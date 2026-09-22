// A synthetic band peer for the staged/enrolled flows. It performs the AirShield handshake with
// public P-256 scalar 1, then answers the session's staged setup frames the way real firmware did
// in the captures. Used to drive BandSession to a live stream without hardware.

import { createECDH, createHash } from "node:crypto";
import { expect } from "bun:test";
import { AirShieldCipher, AirShieldKeys, AirShieldReceiver } from "../src/airshield";
import type { BandEvent } from "../src/gestures";
import { SigningKey } from "../src/identity";
import type { BandSession } from "../src/session";
import { BandWire, DataXReceiver, type DataXFrame, ProtoFields, be16, concat, i16le } from "../src/wire";

export const range = (from: number, to: number): Uint8Array => Uint8Array.from({ length: to - from }, (_, i) => from + i);
const sha256 = (d: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(d).digest());
const trustPreimage = (challenge: Uint8Array, receiver: Uint8Array, seed: Uint8Array, sender: Uint8Array): Uint8Array =>
  concat(sha256(concat(challenge, receiver)), sha256(concat(seed, sender)));

export interface BandOptions {
  /// A synthetic band signing key; when set, the band emits an EnableTrustEC proof the enrolled
  /// session can verify, and its public point is what the caller stores as `bandPublicKey`.
  signingKey?: SigningKey;
}

/// Drives a BandSession through the whole staged/enrolled setup to a live stream.
export class SyntheticBand {
  readonly sender: AirShieldCipher;
  readonly receiver: AirShieldReceiver;
  private readonly datax = new DataXReceiver();
  private readonly challenge = range(0, 16);
  private readonly seed = range(0, 32);
  private readonly bandPoint: Uint8Array;
  private ourChallenge!: Uint8Array;
  private ourSeed!: Uint8Array;
  private ourPoint!: Uint8Array;
  private streamSeq = 0;
  /// Events emitted while the constructor drove setup to a live stream.
  readonly setupEvents: BandEvent[] = [];

  constructor(private readonly session: BandSession, private readonly options: BandOptions = {}) {
    const request = session.request();
    const local = new ProtoFields(request.subarray(12));
    this.ourChallenge = local.bytes(2);
    this.ourPoint = local.bytes(1);
    const peer = createECDH("prime256v1");
    peer.setPrivateKey(Buffer.from(concat(new Uint8Array(31), new Uint8Array([1]))));
    this.bandPoint = new Uint8Array(peer.getPublicKey()).subarray(1);
    const iv = range(16, 32);
    const peerRequest = BandWire.frame(0x8001, [0x81000005, 0x02000001], concat(
      BandWire.field(1, this.bandPoint), BandWire.field(2, this.challenge), BandWire.field(3, 0), BandWire.field(4, 3)));
    const peerEnable = BandWire.frame(1, [0x02000002], concat(
      BandWire.field(1, this.bandPoint), BandWire.field(2, this.seed), BandWire.field(3, iv), BandWire.field(4, 42), BandWire.field(5, 3)));
    let output: Uint8Array = new Uint8Array();
    for (const byte of concat(peerRequest, peerEnable)) output = concat(output, session.feed(new Uint8Array([byte]), 100).outgoing);
    const size = (be16(output, 0) & 0x7fff) + 4;
    const enable = new ProtoFields(output.subarray(8, size));
    this.ourSeed = enable.bytes(2);
    const secret = new Uint8Array(peer.computeSecret(Buffer.from(concat(new Uint8Array([4]), this.ourPoint))));
    this.sender = new AirShieldCipher(AirShieldKeys.derive(secret, local.bytes(2), this.seed), iv, 42);
    this.receiver = new AirShieldReceiver(new AirShieldCipher(
      AirShieldKeys.derive(secret, this.challenge, enable.bytes(2)), enable.bytes(3), Number(enable.integer(4))));
    // The session's first setup frames (identity/EndLinkSetup or EnableTrust) follow the enable.
    this.setupEvents.push(...this.react(output.subarray(size), 100));
  }

  /// Feed the session's encrypted output through the band, answering each frame, until quiescent.
  private react(bytes: Uint8Array, time: number): BandEvent[] {
    const events: BandEvent[] = [];
    let input = bytes;
    for (let guard = 0; guard < 32; guard++) {
      const replies: Uint8Array[] = [];
      for (const plain of this.receiver.feed(input)) {
        for (const frame of this.datax.feed(plain)) replies.push(...this.answer(frame));
      }
      if (replies.length === 0) return events;
      const result = this.session.feed(concat(...replies), time);
      events.push(...result.events);
      input = result.outgoing;
      if (input.length === 0) return events;
    }
    return events;
  }

  private answer(frame: DataXFrame): Uint8Array[] {
    const kind = frame.words[frame.words.length - 1];
    // EnableTrust from an enrolled session (channel 0x8002, type 0x02001000): acknowledge app
    // trust on channel 2, and send the band's own EnableTrustEC proof on a high channel.
    if (kind === 0x02001000 && frame.channel === 0x8002) {
      const appTrusted = this.encrypt(BandWire.frame(2, [0x03001000]));
      const key = this.options.signingKey;
      const proofSig = key
        ? key.signPreimage(trustPreimage(this.ourChallenge, this.ourPoint, this.seed, this.bandPoint))
        : new Uint8Array(64);
      const proof = this.encrypt(BandWire.frame(0x8002, [0x02001001], concat(BandWire.field(1, 1), BandWire.field(2, proofSig))));
      return [appTrusted, proof];
    }
    // Our EndLinkSetup (channel 0x8001, type 0x02001000): reply on 0x8001 echoing a 16-byte UUID.
    if (kind === 0x02001000 && frame.channel === 0x8001) {
      return [this.encrypt(BandWire.frame(0x8001, [0x02001000], concat(BandWire.field(1, 1), BandWire.field(2, range(0, 16)))))];
    }
    // Our reply to the band proof (0x03001000 on channel 2): nothing to send.
    if (kind === 0x03001000) return [];
    // Device-info query (channel 0x8003): reply success on channel 3.
    if (frame.channel === 0x8003) {
      return [this.encrypt(BandWire.frame(3, [0x02000315], concat(BandWire.field(1, 1), BandWire.field(2, 1))))];
    }
    // Stream/hand RPCs on the 0xce56 service. The session opens config on 0x8006 and streams on 0x8005.
    if (frame.channel === 0x8006 || frame.channel === 0x8005) {
      const fields = new ProtoFields(frame.payload);
      const id = fields.integer(1);
      if (frame.channel === 0x8006) {
        // Hand read/write: echo status 1 with a right-hand config (field 10 = 0).
        const config = concat(BandWire.field(10, 0), BandWire.field(2, 2048));
        return [this.encrypt(BandWire.frame(6, [0x02000315], concat(BandWire.field(1, id), BandWire.field(2, 1), BandWire.field(6, config))))];
      }
      // Stream control: acknowledge with all requested flags enabled.
      const flags = concat(BandWire.field(3, 1), BandWire.field(6, 1), BandWire.field(8, 1));
      return [this.encrypt(BandWire.frame(5, [0x02000315], concat(BandWire.field(1, id), BandWire.field(2, 1), BandWire.field(5, flags))))];
    }
    return [];
  }

  private encrypt(frame: Uint8Array): Uint8Array {
    return this.sender.encrypt(frame);
  }

  /// Send a gesture (index tap etc.) and return the decoded events.
  gesture(action: number, now: number, options: { finger?: number; derived?: number } = {}): BandEvent[] {
    const payload = concat(BandWire.field(1, ++this.streamSeq), BandWire.field(2, this.streamSeq * 1000),
      BandWire.field(3, options.finger ?? 2), BandWire.field(4, action), BandWire.field(5, options.derived ?? 0));
    const frame = BandWire.frame(0x8005, [0x0200020d], payload);
    return this.session.feed(this.encrypt(frame), 100 + now).events;
  }

  /// Read what the session sent (e.g. the stop request) as decoded frames.
  read(bytes: Uint8Array): DataXFrame[] {
    return this.receiver.feed(bytes).flatMap((plain) => this.datax.feed(plain));
  }

  sendStopAck(): void {
    const flags = concat(BandWire.field(3, 0), BandWire.field(6, 0), BandWire.field(8, 0));
    this.session.feed(this.encrypt(BandWire.frame(5, [0x02000315], concat(BandWire.field(1, 4), BandWire.field(2, 1), BandWire.field(5, flags)))), 200);
  }
}

export const has = (events: BandEvent[], type: BandEvent["payload"]["type"]): boolean => events.some((e) => e.payload.type === type);
export { i16le };
