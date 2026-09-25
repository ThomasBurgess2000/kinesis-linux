// The observed band handshake, enrollment ceremony, per-session trust proof, and input
// subscription. Port of Sources/KinesisCore/BandSession.swift. It never exports session keys.
//
// Setup runs a small state machine:
//   link      – plain handshake, then EndLinkSetup (un-enrolled bands)
//   ceremony  – owner-enrollment ceremony (pairs the band to a Meta account)
//   identity  – enrolled EnableTrust proof; waits for mutual trust, then EndLinkSetup
//   deviceInfo– device-info RPC that gates the input service
//   input     – gesture/gyro/quaternion subscription is live

import { createECDH, createHash, randomBytes } from "node:crypto";
import { AirShieldCipher, AirShieldKeys, AirShieldReceiver, airShieldParams, macPrefixFor } from "./airshield";
import { OwnershipCeremony, ceremonyFailureMessage } from "./ceremony";
import { PinchDial } from "./dial";
import { type BandEnrollmentIdentity, BandIdentityMismatchError, verifyPreimage } from "./identity";
import { parseEMGConfiguration } from "./emg";
import type { BandEvent, BandGesture, BandHand } from "./gestures";
import { BandProtocolError, BandWire, DataXReceiver, type DataXFrame, ProtoFields, be16, be32, concat } from "./wire";

interface HandRequest {
  id: bigint;
  hand: BandHand | undefined;
  reading: boolean;
  deadline: number;
}

export interface SessionOptions {
  configChannel?: number;
  enrollment?: BandEnrollmentIdentity;
  ceremony?: OwnershipCeremony;
  /// Turn raw sEMG on as soon as the input subscription is up (readings were on before a reconnect).
  rawEMG?: boolean;
}

type RawStage = "config" | "query" | "update";

/// Whether two DataX channels are the same channel. Newer firmware tags its channels with
/// per-connection high bits (0x9801 answering our 0x8001, 0x9802 for its proof), so compare the
/// channel number in the low byte rather than the whole value.
function sameChannel(a: number, b: number): boolean {
  return (a & 0xff) === (b & 0xff);
}

/// BatteryInfoResp: status 1 in field 2, then response (3) → batteryData (1) with level (1) and an
/// optional charging flag (2). Port of BandBatteryStatus.swift; undefined when anything is off.
export function parseBatteryStatus(payload: Uint8Array): { level: number; charging: boolean | undefined } | undefined {
  try {
    const rpc = new ProtoFields(payload);
    if (rpc.requiredInteger(2) !== 1n) return undefined;
    const battery = new ProtoFields(new ProtoFields(rpc.bytes(3)).bytes(1));
    const level = battery.requiredInteger(1);
    if (level > 100n) return undefined;
    let charging: boolean | undefined;
    if (battery.contains(2)) {
      const flag = battery.requiredInteger(2);
      if (flag > 1n) return undefined;
      charging = flag === 1n;
    }
    return { level: Number(level), charging };
  } catch {
    return undefined;
  }
}

const FINGERS = ["unknown", "thumb", "index", "middle", "notApplicable"];
const ACTIONS = ["unknown", "press", "release", "tap", "doubletap", "click", "up", "down", "left", "right", "wake",
  "swipeIn", "swipeOut", "ia", "partialPress", "partialRelease", "partialClick", "partialUp", "partialDown",
  "partialLeft", "partialRight"];
const DERIVED = ["unknown", "singleTap", "doubleTap", "buttonHold", "buttonRelease", "buttonUp", "buttonDown",
  "buttonLeft", "buttonRight", "buttonPress", "buttonHoldRelease"];

const event = (payload: BandEvent["payload"], receivedAt: number): BandEvent => ({ payload, receivedAt });
const sha256 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(data).digest());

type SetupStage = "link" | "ceremony" | "identity" | "deviceInfo" | "input";

export class BandSession {
  private readonly ecdh = createECDH("prime256v1");
  private readonly challenge = new Uint8Array(randomBytes(16));
  private readonly seed = new Uint8Array(randomBytes(32));
  private readonly iv = new Uint8Array(randomBytes(16));
  private readonly base = randomBytes(4).readUInt32LE(0);
  private peerKey: Uint8Array | undefined;
  private peerChallenge: Uint8Array | undefined;
  private peerSeed: Uint8Array | undefined;
  private pending: Uint8Array = new Uint8Array();
  private transmitter: AirShieldCipher | undefined;
  private receiver: AirShieldReceiver | undefined;
  private datax = new DataXReceiver();
  private channelTypes = new Map<number, number>();
  private dial = new PinchDial();
  private emittedEngagement = false;
  private dialPending = 0;
  private lastDial = -Infinity;
  private lastHeartbeat = -Infinity;
  private streaming = false;
  private stopping = false;
  stopAcknowledged = false;
  authenticatedPackets = 0;
  motionMessages = 0;
  streamsEnabled = false;
  offeredParams = 0n;
  negotiatedParams = 0n;
  /// The parameters we declare in our EnableEncryption (field 5). Each side sends with the set it
  /// declared, so this keys our TX while the band's declared set (negotiatedParams) keys RX.
  declaredParams = 3n;
  /// Subscribed streams: 3 gestures, 6 gyro, 8 quaternion. KINESIS_STREAMS (e.g. "3") narrows it
  /// for experiments; the pinch dial needs gyro.
  private readonly streamFields = process.env.KINESIS_STREAMS
    ? process.env.KINESIS_STREAMS.split(",").map(Number).filter((f) => [2, 3, 6, 8].includes(f))
    : [3, 6, 8];
  private readonly streamChannel = 0x8005;
  private readonly configurationChannel: number;
  private setupStage: SetupStage = "link";
  private enrollment: BandEnrollmentIdentity | undefined;
  private readonly ceremony: OwnershipCeremony | undefined;
  private appTrusted = false;
  private bandTrusted = false;
  private endLinkSent = false;
  /// Set when an enrollment ceremony finishes; the caller persists it.
  enrolledIdentity: BandEnrollmentIdentity | undefined;
  private configurationID = 0n;
  private handRequest: HandRequest | undefined;
  private readonly batteryChannel = 0x8008;
  private batteryChannelOpened = false;
  private batteryRequestID = 0n;
  private batteryRequest: { id: bigint; deadline: number } | undefined;
  private batteryUnavailable = false;
  // Raw sEMG rides on the input subscription (flag 2), after reading the EMG config on 0x8007.
  private readonly configServiceChannel = 0x8007;
  private configServiceOpened = false;
  private rawEMG: boolean;
  private rawRequested = false;
  private rawRequestID = 6n;
  private rawRequest: { enabled: boolean; stage: RawStage; id: bigint; deadline: number } | undefined;
  rawEMGFrames = 0;
  rawEMGBytes = 0;
  hand: BandHand | undefined;

  onFrame: ((frame: { channel: number; words: number[]; length: number }) => void) | undefined;
  /// Diagnostics: transport records outside the authenticated stream (control/relay markers).
  onTransport: ((record: Uint8Array) => void) | undefined;

  constructor(options: SessionOptions = {}) {
    this.ecdh.generateKeys();
    this.configurationChannel = options.configChannel ?? 0x8006;
    this.enrollment = options.enrollment;
    this.ceremony = options.ceremony;
    this.rawEMG = options.rawEMG ?? false;
  }

  private get publicKey(): Uint8Array {
    return new Uint8Array(this.ecdh.getPublicKey()).subarray(1);
  }

  request(): Uint8Array {
    return BandWire.frame(0x8001, [0x81000005, 0x02000001], concat(
      BandWire.field(1, this.publicKey), BandWire.field(2, this.challenge), BandWire.field(3, 0),
      BandWire.field(4, 31), BandWire.field(7, 16)));
  }

  feed(bytes: Uint8Array, time: number): { outgoing: Uint8Array; packets: Uint8Array[]; events: BandEvent[] } {
    this.pending = concat(this.pending, bytes);
    const outgoing: Uint8Array[] = [];
    let events: BandEvent[] = [];
    while (this.receiver === undefined && this.pending.length >= 4) {
      if (!(this.pending[0]! & 0x80)) throw new BandProtocolError("Unexpected bytes before band encryption");
      const size = (be16(this.pending, 0) & 0x7fff) + 4;
      if (size < 8) throw new BandProtocolError("Invalid band setup length");
      if (this.pending.length < size) break;
      const frame = this.pending.slice(0, size);
      this.pending = this.pending.slice(size);
      const offset = frame[2]! & 0x80 ? 8 : 4;
      if (size < offset + 4) throw new BandProtocolError("Truncated band setup header");
      const kind = be32(frame, offset);
      const fields = new ProtoFields(frame.subarray(offset + 4));
      const point = fields.bytes(1, 64);
      switch (kind) {
        case 0x02000001: {
          // field 4 is the band's parameter set. We only implement the param-3 key derivation;
          // whether it matches other advertised values is decided by the packet MAC below, so we
          // record the value and proceed rather than gating on it. Only the P-256 curve is required.
          if (this.peerKey !== undefined || fields.integer(3) !== 0n) {
            throw new BandProtocolError(`Unsupported band encryption curve (${fields.integer(3)})`);
          }
          this.offeredParams = fields.integer(4);
          this.declaredParams = BandSession.declareParams(this.offeredParams);
          this.peerKey = point;
          this.peerChallenge = fields.bytes(2, 16);
          outgoing.push(BandWire.frame(1, [0x02000002], concat(
            BandWire.field(1, this.publicKey), BandWire.field(2, this.seed), BandWire.field(3, this.iv),
            BandWire.field(4, this.base), BandWire.field(5, this.declaredParams))));
          break;
        }
        case 0x02000002: {
          const peerChallenge = this.peerChallenge;
          // Accept the negotiated parameters (recorded in field 5); the packet MAC validates the
          // derivation. Only the band key match and the seed/iv shapes are structurally required.
          if (!this.peerKey || !peerChallenge || Buffer.compare(point, this.peerKey) !== 0) {
            throw new BandProtocolError("Unexpected band encryption response");
          }
          this.negotiatedParams = fields.integer(5);
          const secret = new Uint8Array(this.ecdh.computeSecret(concat(new Uint8Array([4]), point)));
          const peerSeed = fields.bytes(2, 32);
          this.peerSeed = peerSeed;
          const peerIV = fields.bytes(3, 16);
          const peerBase = fields.integer(4);
          if (peerBase < 0n || peerBase > 0xffffffffn) throw new BandProtocolError("Invalid band packet counter");
          // Each direction is keyed by the parameters its sender declared (param 3 vs the extended
          // 26/31 style): TX by ours, RX by the band's. TX uses the peer challenge + our seed; RX
          // uses ours + the peer's.
          this.transmitter = new AirShieldCipher(
            AirShieldKeys.derive(secret, peerChallenge, this.seed, airShieldParams(this.declaredParams)),
            this.iv, this.base, macPrefixFor(this.declaredParams));
          this.receiver = new AirShieldReceiver(new AirShieldCipher(
            AirShieldKeys.derive(secret, this.challenge, peerSeed, airShieldParams(this.negotiatedParams)),
            peerIV, Number(peerBase), macPrefixFor(this.negotiatedParams)));
          this.receiver.onSkipped = (record) => this.onTransport?.(record);
          if (this.ceremony) {
            // Enrollment startup runs the ownership ceremony instead of the identity queries.
            this.setupStage = "ceremony";
            outgoing.push(this.encrypt(this.ceremony.start()));
          } else if (this.enrollment) {
            // Enrolled startup replaces the empty identity query with an EnableTrust proof.
            this.setupStage = "identity";
            outgoing.push(this.encrypt(this.enableTrust(this.enrollment)));
          } else {
            // Un-enrolled: complete link setup before the input service (hits 0xc001 on an
            // enrolled band; enroll or import an identity to get past it).
            outgoing.push(this.encrypt(BandWire.frame(0x8002, [0x81000024, 0x02003000])));
            outgoing.push(this.encrypt(BandWire.frame(0x8001, [0x02001000], concat(
              BandWire.field(1, 1), BandWire.field(2, new Uint8Array(randomBytes(16)))))));
          }
          break;
        }
        default:
          throw new BandProtocolError("Unrecognized band setup message");
      }
    }
    if (this.receiver !== undefined) {
      const records = this.receiver.feed(this.pending);
      this.pending = new Uint8Array();
      for (const plaintext of records) {
        this.authenticatedPackets += 1;
        for (const frame of this.datax.feed(plaintext)) {
          this.onFrame?.({ channel: frame.channel, words: frame.words, length: frame.payload.length });
          events = events.concat(this.input(frame, time, outgoing));
        }
        if (this.streaming && !this.stopping && time - this.lastHeartbeat >= 0.2) {
          this.lastHeartbeat = time;
          events.push(event({ type: "heartbeat" }, time));
        }
      }
    }
    return { outgoing: concat(...outgoing), packets: outgoing, events };
  }

  tick(time: number): BandEvent[] {
    this.dial.tick(time);
    const events = this.engagementEvents(time);
    if (this.handRequest && time >= this.handRequest.deadline && !this.stopping) {
      this.handRequest = undefined;
      this.hand = undefined;
      events.push(event({ type: "handednessFailure", message: "Couldn't confirm the band hand. Reconnect and try again." }, time));
    }
    if (this.batteryRequest && time >= this.batteryRequest.deadline && !this.stopping) {
      this.batteryRequest = undefined;
      events.push(event({ type: "batteryStatus", status: undefined }, time));
    }
    if (this.rawRequest && time >= this.rawRequest.deadline && !this.stopping) {
      this.rawRequest = undefined;
      events.push(event({ type: "rawEMGFailure", message: "The band didn't confirm the EMG change. Turn readings off, then try again." }, time));
    }
    return events;
  }

  /// Turn raw sEMG on or off on the running subscription; gestures and motion stay on. On: read
  /// the EMG config, query the stream, then update it with flag 2. Off: update it directly.
  /// Before the subscription is up this only records the wish (see SessionOptions.rawEMG).
  setRawEMGEnabled(enabled: boolean, time: number): Uint8Array {
    if (this.stopping) throw new BandProtocolError("Wait for the band to reconnect before changing readings.");
    if (this.rawRequest) throw new BandProtocolError("Wait for the current EMG change to finish.");
    this.rawEMG = enabled;
    if (!this.streamsEnabled) return new Uint8Array();
    this.rawRequestID += 1n;
    this.rawRequest = { enabled, stage: enabled ? "config" : "update", id: this.rawRequestID, deadline: time + 8 };
    if (enabled) {
      const words = this.configServiceOpened ? [] : [0x8100ce56, 0x02000314];
      this.configServiceOpened = true;
      return this.encrypt(BandWire.frame(this.configServiceChannel, words,
        concat(BandWire.field(1, this.rawRequestID), BandWire.field(5, new Uint8Array()))));
    }
    return this.rawStreamUpdate(this.rawRequestID, false);
  }

  /// Every stream field set explicitly, so none is left to the band's default.
  private rawStreamUpdate(id: bigint, enabled: boolean): Uint8Array {
    this.rawRequested = true;
    const control = concat(BandWire.field(2, enabled ? 1 : 0), ...this.streamFields.map((field) => BandWire.field(field, 1)));
    return this.encrypt(BandWire.frame(this.streamChannel, [], concat(BandWire.field(1, id), BandWire.field(4, control))));
  }

  private receiveRaw(frame: DataXFrame, fields: ProtoFields, time: number, outgoing: Uint8Array[]): BandEvent[] | undefined {
    const pending = this.rawRequest;
    if (!pending) return undefined;
    const expected = pending.stage === "config" ? this.configServiceChannel : this.streamChannel;
    if (!sameChannel(frame.channel, expected) || fields.integer(1) !== pending.id) return undefined;
    if (fields.integer(2) !== 1n) {
      this.rawRequest = undefined;
      return [event({ type: "rawEMGFailure", message: "The band rejected the EMG change. Gestures remain requested." }, time)];
    }
    switch (pending.stage) {
      case "config": {
        let config;
        try {
          config = parseEMGConfiguration(frame.payload);
        } catch {
          this.rawRequest = undefined;
          return [event({ type: "rawEMGFailure", message: "The band didn't provide a readable EMG configuration." }, time)];
        }
        this.rawRequestID += 1n;
        this.rawRequest = { ...pending, stage: "query", id: this.rawRequestID };
        outgoing.push(this.streamRequest(this.rawRequestID, undefined));
        return [event({ type: "rawEMGConfiguration", config }, time)];
      }
      case "query":
        this.rawRequestID += 1n;
        this.rawRequest = { ...pending, stage: "update", id: this.rawRequestID };
        outgoing.push(this.rawStreamUpdate(this.rawRequestID, pending.enabled));
        return [];
      case "update": {
        this.rawRequest = undefined;
        const flags = new ProtoFields(fields.bytes(5));
        if (!this.streamFields.every((f) => flags.integer(f) === 1n)) {
          throw new BandProtocolError("The band stopped gesture streams during the EMG change. Reconnect with readings off.");
        }
        if (flags.integer(2) !== (pending.enabled ? 1n : 0n)) {
          return [event({ type: "rawEMGFailure", message: "The band didn't accept EMG alongside gestures." }, time)];
        }
        return [event({ type: "rawEMGState", enabled: pending.enabled }, time)];
      }
    }
  }

  /// BatteryInfoReq: an empty read on its own service channel, separate from the sensor
  /// subscription. Empty when streams aren't up, a request is pending, or the band lacks it.
  queryBatteryStatus(time: number): Uint8Array {
    if (!this.streamsEnabled || this.stopping || this.batteryUnavailable || this.batteryRequest) return new Uint8Array();
    this.batteryRequestID += 1n;
    this.batteryRequest = { id: this.batteryRequestID, deadline: time + 3 };
    const words = this.batteryChannelOpened ? [] : [0x8100ce56, 0x02000314];
    this.batteryChannelOpened = true;
    return this.encrypt(BandWire.frame(this.batteryChannel, words,
      concat(BandWire.field(1, this.batteryRequestID), BandWire.field(2, new Uint8Array()))));
  }

  setHandedness(hand: BandHand, time: number): Uint8Array {
    if (!this.streamsEnabled || this.stopping || this.hand === undefined || this.handRequest !== undefined) {
      throw new BandProtocolError("Wait for the band to report its hand before changing it.");
    }
    this.dial = new PinchDial();
    return this.requestHand(hand, false, time);
  }

  /// Resume the ceremony after the pair_request HTTP exchange.
  ceremonyPairRequestCompleted(signature: Uint8Array, receipt: string): Uint8Array {
    if (!this.ceremony) throw new BandProtocolError("No enrollment is running");
    return this.encrypt(this.ceremony.pairRequestCompleted(signature, receipt));
  }

  /// Resume the ceremony after the pair HTTP exchange.
  ceremonyPairCompleted(signature: Uint8Array, receipt: string, devicePublicKey: Uint8Array | undefined): Uint8Array {
    if (!this.ceremony) throw new BandProtocolError("No enrollment is running");
    return this.encrypt(this.ceremony.pairCompleted(signature, receipt, devicePublicKey));
  }

  private requestHand(hand: BandHand | undefined, reading: boolean, time: number): Uint8Array {
    const id = this.configurationID + 1n;
    const config = reading ? new Uint8Array() : BandWire.field(10, hand === "left" ? 1 : 0);
    const bytes = this.encrypt(BandWire.frame(this.configurationChannel,
      this.configurationID === 0n ? [0x8100ce56, 0x02000314] : [],
      concat(BandWire.field(1, id), BandWire.field(5, config))));
    this.configurationID = id;
    this.handRequest = { id, hand, reading, deadline: time + 5 };
    return bytes;
  }

  private receiveHand(fields: ProtoFields, time: number, outgoing: Uint8Array[]): BandEvent[] {
    const request = this.handRequest;
    if (!request || fields.integer(1) !== request.id) return [];
    this.handRequest = undefined;
    if (time >= request.deadline) {
      this.hand = undefined;
      return [event({ type: "handednessFailure", message: "Couldn't confirm the band hand. Reconnect and try again." }, time)];
    }
    if (fields.integer(2) !== 1n) {
      this.hand = undefined;
      return [event({ type: "handednessFailure", message: "The band couldn't apply its hand setting. Reconnect and try again." }, time)];
    }
    if (!request.reading) {
      outgoing.push(this.requestHand(request.hand, true, time));
      return [];
    }
    if (!fields.contains(6)) {
      this.hand = undefined;
      return [event({ type: "handednessFailure", message: "This band didn't report its hand setting." }, time)];
    }
    const config = new ProtoFields(fields.bytes(6));
    if (!config.contains(10) || config.integer(10) > 1n) {
      this.hand = undefined;
      return [event({ type: "handednessFailure", message: "This band didn't report its hand setting." }, time)];
    }
    const reported: BandHand = config.integer(10) === 1n ? "left" : "right";
    this.hand = reported;
    const events = [event({ type: "handedness", hand: reported }, time)];
    if (request.hand !== undefined && reported !== request.hand) {
      events.push(event({ type: "handednessFailure", message: "The band didn't keep the selected hand. Reconnect and try again." }, time));
    }
    return events;
  }

  queryStreamState(): Uint8Array {
    if (!this.streamsEnabled || this.stopping) return new Uint8Array();
    return this.streamRequest(5n, undefined);
  }

  stop(): Uint8Array {
    if (this.stopping) return new Uint8Array();
    this.stopping = true;
    this.handRequest = undefined;
    if (!this.transmitter || this.setupStage !== "input") return new Uint8Array();
    return this.streamRequest(4n, false, this.rawRequested);
  }

  private encrypt(data: Uint8Array): Uint8Array {
    if (!this.transmitter) throw new BandProtocolError("Band encryption is not ready");
    return this.transmitter.encrypt(data);
  }

  /// Pick the parameter set we declare (and send with) from the band's offer. Bands offering the
  /// extended bits refuse a param-3 sender, so declare the extended set we implement (26: bits 1,3,4,
  /// no separate MAC key) whenever the offer contains it; otherwise keep the verified param 3.
  static declareParams(offered: bigint): bigint {
    if ((offered & 26n) === 26n) return 26n;
    if ((offered & 3n) === 3n) return 3n;
    throw new BandProtocolError(`Unsupported band encryption parameters (${offered})`);
  }

  /// The confirmed transcript preimage; SHA-256 of it is the signed digest.
  private static trustPreimage(challenge: Uint8Array, receiver: Uint8Array, seed: Uint8Array, sender: Uint8Array): Uint8Array {
    return concat(sha256(concat(challenge, receiver)), sha256(concat(seed, sender)));
  }

  /// Host EnableTrust on the identity service channel, replacing the empty identity query.
  private enableTrust(identity: BandEnrollmentIdentity, serviceOpen = false): Uint8Array {
    if (!this.peerKey || !this.peerChallenge) throw new BandProtocolError("Band encryption is not ready");
    const preimage = BandSession.trustPreimage(this.peerChallenge, this.peerKey, this.seed, this.publicKey);
    const signature = identity.privateKey.signPreimage(preimage);
    return BandWire.frame(0x8002, serviceOpen ? [0x02001000] : [0x81000024, 0x02001000],
      concat(BandWire.field(1, sha256(identity.privateKey.publicPoint)), BandWire.field(2, signature)));
  }

  private receiveCeremony(frame: DataXFrame, kind: number, time: number, outgoing: Uint8Array[]): BandEvent[] {
    const ceremony = this.ceremony;
    if (!ceremony) return [];
    if ((kind & 0xff000000) === 0x03000000) {
      throw new BandProtocolError(ceremonyFailureMessage(kind & 0xffffff));
    }
    switch (kind) {
      case 0x02003001:
        outgoing.push(this.encrypt(ceremony.identityRead(frame.payload)));
        return [event({ type: "ceremonyStage", message: "reading the band identity" }, time)];
      case 0x02002001: {
        const request = ceremony.skipChallenge(frame.payload);
        return [event({ type: "ceremonyStage", message: "claiming the band" }, time),
          event({ type: "ceremonyHTTP", request: { kind: "pairRequest", data: request } }, time)];
      }
      case 0x02002003: {
        const pair = ceremony.startChangeOwner(frame.payload);
        return [event({ type: "ceremonyStage", message: "confirming ownership" }, time),
          event({ type: "ceremonyHTTP", request: { kind: "pair", data: pair } }, time)];
      }
      case 0x02002005: {
        const identity = ceremony.complete(frame.words, frame.payload);
        return [this.adoptEnrolledIdentity(identity, outgoing, time)];
      }
      default:
        return [];
    }
  }

  private adoptEnrolledIdentity(identity: BandEnrollmentIdentity, outgoing: Uint8Array[], time: number): BandEvent {
    this.enrollment = identity;
    this.enrolledIdentity = identity;
    this.appTrusted = false;
    this.bandTrusted = false;
    this.endLinkSent = false;
    this.setupStage = "identity";
    outgoing.push(this.encrypt(this.enableTrust(identity, true)));
    return event({ type: "ceremonyStage", message: "establishing trust" }, time);
  }

  private receiveIdentity(frame: DataXFrame, kind: number, outgoing: Uint8Array[]): BandEvent[] {
    if ((kind & 0xff000000) === 0x03000000 && frame.channel === 2) {
      if (kind !== 0x03001000) {
        if (kind === 0x03001043) {
          throw new BandIdentityMismatchError("band enrolled to a different key. forget the stored band identity to reconnect without it.");
        }
        throw new BandIdentityMismatchError(`the band rejected the stored identity (${kind.toString(16)}). try reconnecting.`);
      }
      this.appTrusted = true;
    } else if (kind === 0x02001001 && (frame.channel & 0x8000) !== 0) {
      if (this.bandTrusted) throw new BandProtocolError("The band sent a duplicate identity proof");
      const fields = new ProtoFields(frame.payload);
      if (!this.peerKey || !this.peerSeed) throw new BandProtocolError("Band encryption is not ready");
      const signature = fields.bytes(2, 64);
      const bandKey = this.enrollment?.bandPublicKey;
      if (bandKey) {
        const preimage = BandSession.trustPreimage(this.challenge, this.publicKey, this.peerSeed, this.peerKey);
        if (!verifyPreimage(bandKey, preimage, signature)) {
          throw new BandProtocolError("The band's identity proof didn't verify. Try reconnecting.");
        }
      }
      this.bandTrusted = true;
      outgoing.push(this.encrypt(BandWire.frame(frame.channel & 0x7fff, [0x03001000])));
    } else if (kind === 0x02001000 && sameChannel(frame.channel, 0x8001) && this.endLinkSent) {
      const fields = new ProtoFields(frame.payload);
      if (fields.requiredInteger(1) !== 1n || fields.bytes(2).length !== 16) {
        throw new BandProtocolError("Unexpected band link setup response");
      }
      this.setupStage = "deviceInfo";
      outgoing.push(this.encrypt(BandWire.frame(0x8003, [0x8100ce56, 0x02000314], concat(
        BandWire.field(1, 1), BandWire.field(3, new Uint8Array())))));
      return [];
    } else {
      return [];
    }
    if (this.appTrusted && this.bandTrusted && !this.endLinkSent) {
      this.endLinkSent = true;
      outgoing.push(this.encrypt(BandWire.frame(0x8001, [0x02001000], concat(
        BandWire.field(1, 1), BandWire.field(2, new Uint8Array(randomBytes(16)))))));
    }
    return [];
  }

  /// `includeRaw` also sets raw sEMG (flag 2), once it has been requested this session.
  private streamRequest(id: bigint, enabled: boolean | undefined, includeRaw = false): Uint8Array {
    const fields = includeRaw ? [2, ...this.streamFields] : this.streamFields;
    const control = enabled === undefined
      ? new Uint8Array()
      : concat(...fields.map((field) => BandWire.field(field, enabled ? 1 : 0)));
    return this.encrypt(BandWire.frame(this.streamChannel, id === 2n ? [0x8100ce56, 0x02000314] : [],
      concat(BandWire.field(1, id), BandWire.field(4, control))));
  }

  private engagementEvents(time: number): BandEvent[] {
    if (this.dial.engaged === this.emittedEngagement) return [];
    this.emittedEngagement = this.dial.engaged;
    this.dialPending = 0;
    this.lastDial = -Infinity;
    return [event({ type: "dialState", engaged: this.dial.engaged }, time)];
  }

  private input(frame: DataXFrame, time: number, outgoing: Uint8Array[]): BandEvent[] {
    const last = frame.words[frame.words.length - 1];
    if (last !== undefined) {
      if (this.channelTypes.size >= 1024 && !this.channelTypes.has(frame.channel)) {
        throw new BandProtocolError("Too many band input channels");
      }
      this.channelTypes.set(frame.channel, last);
    }
    const kind = this.channelTypes.get(frame.channel);
    if (kind === undefined) return [];

    // Frames after the first on a channel omit their type words; `kind` is the channel's type.
    if (this.ceremony && this.setupStage === "ceremony" && !this.stopping) {
      return this.receiveCeremony(frame, kind, time, outgoing);
    }
    if (this.enrollment && this.setupStage === "identity" && !this.stopping) {
      return this.receiveIdentity(frame, kind, outgoing);
    }
    if (kind === 0x02001000 && sameChannel(frame.channel, 0x8001) && this.setupStage === "link" && !this.stopping) {
      const fields = new ProtoFields(frame.payload);
      if (fields.requiredInteger(1) !== 1n) {
        throw new BandProtocolError("The band couldn't finish setting up the connection. Try reconnecting.");
      }
      this.setupStage = "deviceInfo";
      outgoing.push(this.encrypt(BandWire.frame(0x8003, [0x8100ce56, 0x02000314], concat(
        BandWire.field(1, 1), BandWire.field(3, new Uint8Array())))));
      return [];
    }
    if (sameChannel(frame.channel, this.batteryChannel) && !this.stopping) {
      if (kind === 0x0300c001) {
        this.batteryRequest = undefined;
        this.batteryUnavailable = true;
        return [event({ type: "batteryStatus", status: undefined }, time)];
      }
      const request = this.batteryRequest;
      if (kind === 0x02000315 && request) {
        // Optional status: a malformed answer must not interrupt gestures.
        try {
          if (new ProtoFields(frame.payload).requiredInteger(1) !== request.id) return [];
        } catch {
          return [];
        }
        this.batteryRequest = undefined;
        return [event({ type: "batteryStatus", status: parseBatteryStatus(frame.payload) }, time)];
      }
      return [];
    }
    if (kind === 0x0300c001 && !this.stopping) {
      if (this.rawRequest && (sameChannel(frame.channel, 7) || (sameChannel(frame.channel, 5) && this.rawRequest.stage !== "config"))) {
        this.rawRequest = undefined;
        return [event({ type: "rawEMGFailure", message: "The band rejected the EMG request." }, time)];
      }
      if (sameChannel(frame.channel, 3) && this.setupStage === "deviceInfo") {
        throw new BandProtocolError("The band rejected gesture setup. Try reconnecting.");
      }
      if (sameChannel(frame.channel, 5) && this.setupStage === "input") {
        throw new BandProtocolError("The band rejected the input subscription. Try reconnecting.");
      }
      if (sameChannel(frame.channel, 6) && this.handRequest) {
        this.handRequest = undefined;
        this.hand = undefined;
        return [event({ type: "handednessFailure", message: "The band couldn't report its hand setting. Reconnect and try again." }, time)];
      }
      return [];
    }
    if (![0x02000315, 0x0200020a, 0x0200020d, 0x0200020f, 0x02000212].includes(kind)) return [];
    if (kind === 0x02000315 && sameChannel(frame.channel, 3) && this.setupStage === "deviceInfo" && !this.stopping) {
      const fields = new ProtoFields(frame.payload);
      if (fields.requiredInteger(1) !== 1n) return [];
      if (fields.requiredInteger(2) !== 1n) throw new BandProtocolError("The band rejected gesture setup. Try reconnecting.");
      this.setupStage = "input";
      outgoing.push(this.streamRequest(2n, undefined));
      outgoing.push(this.streamRequest(3n, true));
      outgoing.push(this.requestHand(undefined, true, time));
      return [];
    }
    if (this.setupStage !== "input") return [];
    if (kind === 0x02000315 && sameChannel(frame.channel, this.configurationChannel)) {
      if (this.stopping) return [];
      return this.receiveHand(new ProtoFields(frame.payload), time, outgoing);
    }
    const fields = new ProtoFields(frame.payload);
    if (kind === 0x02000315 && !this.stopping) {
      const raw = this.receiveRaw(frame, fields, time, outgoing);
      if (raw) return raw;
    }
    if (kind === 0x02000315 && !sameChannel(frame.channel, this.streamChannel)) return [];
    if (kind === 0x02000315) {
      const request = fields.integer(1);
      if (request === 3n || request === 5n) {
        if (this.stopping) return [];
        if (fields.integer(2) !== 1n) throw new BandProtocolError("The band rejected the input subscription");
        const flags = new ProtoFields(fields.bytes(5));
        this.streamsEnabled = this.streamFields.every((f) => flags.contains(f) && flags.integer(f) === 1n);
        if (!this.streamsEnabled) throw new BandProtocolError("The band input subscription stopped");
        if (request === 3n && this.rawEMG && !this.rawRequest) outgoing.push(this.setRawEMGEnabled(true, time));
        if (!this.streaming) {
          this.streaming = true;
          return [event({ type: "connected" }, time)];
        }
      } else if (request === 4n && fields.integer(2) === 1n && fields.contains(5)) {
        const flags = new ProtoFields(fields.bytes(5));
        const stopped = this.rawRequested ? [2, ...this.streamFields] : this.streamFields;
        this.stopAcknowledged = stopped.every((f) => flags.contains(f) && flags.integer(f) === 0n);
      }
      return [];
    }
    if (this.stopping) return [];
    if (kind === 0x0200020a) {
      // Keep the original payload for recordings, including unknown encodings.
      this.rawEMGFrames += 1;
      this.rawEMGBytes += frame.payload.length;
      const events: BandEvent[] = [];
      if (!this.streaming) {
        this.streaming = true;
        events.push(event({ type: "connected" }, time));
        events.push(event({ type: "heartbeat" }, time));
        this.lastHeartbeat = time;
      }
      events.push(event({ type: "rawEMGFrame", payload: frame.payload }, time));
      return events;
    }
    const sequence = fields.requiredInteger(1);
    const timestamp = fields.requiredInteger(2);
    const events: BandEvent[] = [];
    if (kind === 0x0200020d) {
      const name = (field: number, names: string[]): string => {
        const value = fields.integer(field);
        return value < BigInt(names.length) ? names[Number(value)]! : `unrecognized:${value}`;
      };
      const gesture: BandGesture = {
        sequence, timestampUs: timestamp,
        finger: name(3, FINGERS), action: name(4, ACTIONS), derivedAction: name(5, DERIVED),
        synthetic: fields.integer(12) !== 0n, receivedAt: time,
      };
      events.push(event({ type: "gesture", gesture }, time));
      this.dial.gesture(gesture, time);
      events.push(...this.engagementEvents(time));
      return events;
    }
    const bytes = fields.bytes(3, kind === 0x0200020f ? 6 : 16);
    this.motionMessages += 1;
    events.push(event({ type: "motion", bandTimeUs: timestamp }, time));
    if (!this.streaming) {
      this.streaming = true;
      events.push(event({ type: "connected" }, time));
      events.push(event({ type: "heartbeat" }, time));
      this.lastHeartbeat = time;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (kind === 0x0200020f) {
      const values: [number, number, number] = [view.getInt16(0, true), view.getInt16(2, true), view.getInt16(4, true)];
      const delta = this.dial.gyro(timestamp, values, time);
      events.push(...this.engagementEvents(time));
      if (delta !== undefined) {
        this.dialPending += delta;
        if (time - this.lastDial >= 0.02) {
          events.push(event({ type: "dialTurn", rotation: this.dialPending }, time));
          this.lastDial = time;
          this.dialPending = 0;
        }
      }
    } else {
      const values = [0, 1, 2, 3].map((i) => view.getFloat32(i * 4, true));
      const norm = values.reduce((sum, v) => sum + v * v, 0);
      if (!values.every(Number.isFinite) || norm < 0.9 || norm > 1.1) {
        throw new BandProtocolError("Invalid band orientation sample");
      }
    }
    return events;
  }
}
