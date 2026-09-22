// The ownership HTTP exchanges against Meta's hardware graph. Port of
// Sources/Kinesis/MetaPairClient.swift. Everything is a form-encoded POST; receipts
// travel verbatim and are never reformatted.

import type { CeremonyPairData, CeremonyPairRequestData } from "./ceremony";
import { HW_CLIENT, META_UNIVERSE, type MetaSession, MetaAuthError, urlForm } from "./meta-auth";

const HOST = "https://graph.facebook-hardware.com";

export interface Pending {
  signature: Uint8Array;
  receipt: string;
}
export interface Final {
  signature: Uint8Array;
  receipt: string;
  devicePublicKey: Uint8Array | undefined;
}

export class MetaSessionInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaSessionInvalidError";
  }
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

export const MetaPair = {
  additionalData(nonce: Uint8Array, appPublicKey: Uint8Array, secondaryCert: string): string {
    return JSON.stringify({ device_nonce: b64(nonce), app_pubkey: b64(appPublicKey), secondary_cert: secondaryCert });
  },

  pairRequestFields(data: CeremonyPairRequestData, session: MetaSession): [string, string][] {
    return [
      ["access_token", HW_CLIENT],
      ["user_access_token", session.accessToken],
      ["user_token_universe", META_UNIVERSE],
      ["pair_protocol_version", "3"],
      ["device_cert", b64(data.identity.deviceCertificate)],
      ["serial_number", data.identity.serial],
      ["additional_data", MetaPair.additionalData(data.nonce, data.appPublicKey, b64(data.identity.secondaryCertificate))],
    ];
  },

  pairFields(data: CeremonyPairData, session: MetaSession): [string, string][] {
    return [
      ["access_token", HW_CLIENT],
      ["user_access_token", session.accessToken],
      ["user_token_universe", META_UNIVERSE],
      ["pair_protocol_version", "3"],
      ["device_pending_ownership_receipt", data.receipt],
      ["device_pending_ownership_receipt_signature", b64(data.signature)],
    ];
  },

  parsePending(json: Record<string, unknown>): Pending {
    const receipt = json.pending_ownership_receipt as string;
    const sig = json.receipt_signature as string;
    if (!receipt || !sig) throw new MetaAuthError("the band claim service didn't return a receipt. try again.");
    return { signature: fromB64(sig), receipt };
  },

  parseFinal(json: Record<string, unknown>): Final {
    const receipt = json.final_ownership_receipt as string;
    const sig = json.receipt_signature as string;
    if (!receipt || !sig) throw new MetaAuthError("the band claim service didn't return a final receipt. try again.");
    // The live server omits device_ec_public_key; the reference app logs and continues.
    const devicePublicKey = deviceKeyIn(json) ?? deviceKeyInReceipt(receipt);
    return { signature: fromB64(sig), receipt, devicePublicKey };
  },

  isSessionFailure(status: number, error: { code?: number } | undefined): boolean {
    if (status === 401 || status === 403) return true;
    return error?.code === 190;
  },
};

function deviceKeyIn(json: Record<string, unknown>): Uint8Array | undefined {
  const additional = json.additional_data as { device_ec_public_key?: string } | undefined;
  const key = additional?.device_ec_public_key;
  return key ? fromB64(key) : undefined;
}
function deviceKeyInReceipt(receipt: string): Uint8Array | undefined {
  try {
    return deviceKeyIn(JSON.parse(receipt) as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

/// The live ownership client; talks to Meta's hardware graph with the account session.
export class MetaPairClient {
  constructor(private readonly session: MetaSession) {}

  async pairRequest(data: CeremonyPairRequestData): Promise<Pending> {
    return MetaPair.parsePending(await this.execute(HOST + "/pair_request", MetaPair.pairRequestFields(data, this.session)));
  }

  async pair(data: CeremonyPairData): Promise<Final> {
    return MetaPair.parseFinal(await this.execute(HOST + "/pair", MetaPair.pairFields(data, this.session)));
  }

  private async execute(url: string, fields: [string, string][]): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: urlForm(fields),
    });
    const text = await response.text();
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = undefined;
    }
    if (MetaPair.isSessionFailure(response.status, json?.error as { code?: number } | undefined)) {
      throw new MetaSessionInvalidError("your meta session expired. sign in to claim the band again.");
    }
    if (response.status !== 200 || !json) {
      throw new MetaAuthError(`the band claim service failed (http ${response.status}). try again.`);
    }
    if (json.error) {
      const error = json.error as { code?: number };
      throw new MetaAuthError(`the band claim service rejected the request (code ${error?.code ?? "-"}). try again.`);
    }
    return json;
  }
}
