// The BLE side of band enrollment. Port of Sources/KinesisCore/OwnershipCeremony.swift.
// One step per band response; the two HTTP exchanges (pair_request, pair) are performed by
// the caller against Meta's hardware graph and fed back in.

import { createHash } from "node:crypto";
import { type BandEnrollmentIdentity, SigningKey } from "./identity";
import { BandProtocolError, BandWire, type DataXFrame, ProtoFields, concat } from "./wire";

export interface BandIdentityInfo {
  deviceCertificate: Uint8Array;
  serial: string;
  secondaryCertificate: Uint8Array;
}

export interface CeremonyPairRequestData {
  identity: BandIdentityInfo;
  nonce: Uint8Array;
  appPublicKey: Uint8Array;
}

export interface CeremonyPairData {
  receipt: string;
  signature: Uint8Array;
}

export type CeremonyHTTPRequest =
  | { kind: "pairRequest"; data: CeremonyPairRequestData }
  | { kind: "pair"; data: CeremonyPairData };

export type CeremonyStage = "identityRead" | "skipChallenge" | "startChangeOwner" | "pair" | "finishChangeOwner" | "done";

export function ceremonyFailureMessage(code: number): string {
  return `the band rejected enrollment (0x${code.toString(16)}). try again.`;
}

/// Drives the ownership ceremony one band response at a time.
export class OwnershipCeremony {
  stage: CeremonyStage = "identityRead";
  readonly appPrivateKey: SigningKey;
  identity: BandIdentityInfo | undefined;
  nonce: Uint8Array | undefined;
  private devicePublicKey: Uint8Array | undefined;

  constructor(readonly bandID: string, appPrivateKey: SigningKey = SigningKey.generate()) {
    this.appPrivateKey = appPrivateKey;
  }

  get appPublicKey(): Uint8Array {
    return this.appPrivateKey.publicPoint;
  }

  /// Identity read that opens the identity service on channel 0x8002.
  start(): Uint8Array {
    if (this.stage !== "identityRead") throw new BandProtocolError("The enrollment is past its identity read");
    return BandWire.frame(0x8002, [0x81000024, 0x02003000]);
  }

  /// Parse the IdentityResponse (fields 1 cert, 2 serial, 5 secondary) and return SkipChallenge.
  identityRead(payload: Uint8Array): Uint8Array {
    if (this.stage !== "identityRead") throw new BandProtocolError("The band sent an unexpected identity response");
    const fields = new ProtoFields(payload);
    const certificate = fields.bytes(1);
    const serialBytes = fields.bytes(2);
    const secondary = fields.bytes(5);
    const serial = Buffer.from(serialBytes).toString("ascii");
    if (certificate.length <= 256 || secondary.length <= 256 || serial.length === 0 || /[^\x20-\x7e]/.test(serial)) {
      throw new BandProtocolError("The band didn't report a usable identity");
    }
    this.identity = { deviceCertificate: certificate, serial, secondaryCertificate: secondary };
    this.stage = "skipChallenge";
    return BandWire.frame(0x8002, [0x02002000]);
  }

  /// Parse the SkipChallengeResponse: field 1 is the 16-byte ownership nonce.
  skipChallenge(payload: Uint8Array): CeremonyPairRequestData {
    if (this.stage !== "skipChallenge" || !this.identity) {
      throw new BandProtocolError("The band sent an unexpected challenge response");
    }
    const nonce = new ProtoFields(payload).bytes(1, 16);
    this.nonce = nonce;
    this.stage = "startChangeOwner";
    return { identity: this.identity, nonce, appPublicKey: this.appPublicKey };
  }

  /// Build StartChangeOwner from the pair_request result (field 1 signature, field 2 receipt).
  pairRequestCompleted(signature: Uint8Array, receipt: string): Uint8Array {
    if (this.stage !== "startChangeOwner") throw new BandProtocolError("The enrollment isn't waiting for its claim");
    if (signature.length === 0 || receipt.length === 0) {
      throw new BandProtocolError("The server didn't return a pending ownership receipt");
    }
    this.stage = "pair";
    return BandWire.frame(0x8002, [0x02002002], concat(BandWire.field(1, signature), BandWire.field(2, new Uint8Array(Buffer.from(receipt, "utf8")))));
  }

  /// Parse the band's StartChangeOwnerResponse (field 1 signature, field 2 receipt).
  startChangeOwner(payload: Uint8Array): CeremonyPairData {
    if (this.stage !== "pair") throw new BandProtocolError("The band sent an unexpected ownership response");
    const fields = new ProtoFields(payload);
    const signature = fields.bytes(1);
    const receipt = Buffer.from(fields.bytes(2)).toString("utf8");
    if (receipt.length === 0) throw new BandProtocolError("The band didn't return its pending ownership receipt");
    this.stage = "finishChangeOwner";
    return { receipt, signature };
  }

  /// Build FinishChangeOwner from the pair result.
  pairCompleted(signature: Uint8Array, receipt: string, devicePublicKey: Uint8Array | undefined): Uint8Array {
    if (this.stage !== "finishChangeOwner") throw new BandProtocolError("The enrollment isn't waiting for its final receipt");
    if (signature.length === 0 || receipt.length === 0) {
      throw new BandProtocolError("The server didn't return a final ownership receipt");
    }
    this.devicePublicKey = devicePublicKey;
    this.stage = "done";
    return BandWire.frame(0x8002, [0x02002004], concat(BandWire.field(1, signature), BandWire.field(2, new Uint8Array(Buffer.from(receipt, "utf8")))));
  }

  /// Confirm the empty FinishChangeOwnerResponse and return the enrolled identity.
  complete(words: number[], payload: Uint8Array): BandEnrollmentIdentity {
    if (this.stage !== "done") throw new BandProtocolError("The enrollment isn't ready to finish");
    if (words.length !== 1 || words[0] !== 0x02002005 || payload.length !== 0) {
      throw new BandProtocolError("The band didn't confirm the ownership change");
    }
    const bandPublicKey = this.devicePublicKey && this.devicePublicKey.length === 64 ? this.devicePublicKey : undefined;
    return { privateKey: this.appPrivateKey, ...(bandPublicKey ? { bandPublicKey } : {}) };
  }
}

export function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

export type { DataXFrame };
