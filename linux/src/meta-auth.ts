// Meta account sign-in for band enrollment. Port of Sources/Kinesis/MetaAuth.swift.
// The chain: an anonymous tokens query, a webview sign-in at auth.meta.com (the user
// enters their password only on Meta's page), a blob decrypt, then the ar-genai exchange
// that yields the account session. This client never sees the password — only the blob
// the sign-in returns.

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface MetaSession {
  accessToken: string;
  userID: string;
  deviceID: string;
  obtainedAt: number;
}
export const META_UNIVERSE = "ar";

export class MetaAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaAuthError";
  }
}

// Meta's own public client identifiers — the same in every copy of Meta's apps. They name
// the app that asks, not a person; they are not secrets and hold no account or session.
export const FRL_CLIENT = "FRL|388177446008673|083800dd7efbbd42eab18c9886d79c18";
export const AR_CLIENT = "AR|306760944872162|a919421a55a8ea18080ab2f10f57f1be";
export const HW_CLIENT = "HW|1312539125771114|98588f106d5d542adbf590619ca071fe";

const TOKENS_QUERY_URL = "https://meta.graph.meta.com/webview_tokens_query";
const BLOBS_DECRYPT_URL = "https://meta.graph.meta.com/webview_blobs_decrypt";
const LOGIN_URL = "https://ar-genai.graph.meta.com/login";
const AUTH_ENTRY_BASE = "https://auth.meta.com/?native_app_id=388177446008673&source_app_id=388177446008673&native_sso_etoken=";

export interface SSOTokens {
  nativeSSOToken: string;
  etoken: string;
}

export function authEntryURL(tokens: SSOTokens): string {
  return AUTH_ENTRY_BASE + tokens.etoken;
}

const makeLSD = (): string => "S0." + Array.from({ length: 6 }, () => Math.floor(Math.random() * 10)).join("");
const jazoest = (lsd: string): string => "2" + String([...lsd].reduce((sum, c) => sum + c.charCodeAt(0), 0));

const FORM_SAFE = /[^A-Za-z0-9\-._~]/g;
export function formEscape(value: string): string {
  return value.replace(FORM_SAFE, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}
export function urlForm(fields: [string, string][]): string {
  return fields.map(([k, v]) => `${k}=${formEscape(v)}`).join("&");
}

function multipartBody(fields: [string, string][], boundary: string): string {
  let body = "";
  for (const [name, value] of fields) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  return body + `--${boundary}--\r\n`;
}

async function postJSON(url: string, headers: Record<string, string>, body: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: "POST", headers, body });
  const text = await response.text();
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = undefined;
  }
  if (response.status !== 200 || !json) {
    throw new MetaAuthError(`meta sign-in failed (http ${response.status}). try again.`);
  }
  if (json.error) {
    const error = json.error as { code?: number; error_subcode?: number };
    throw new MetaAuthError(`meta sign-in failed (code ${error?.code ?? "-"}, subcode ${error?.error_subcode ?? "-"}). try again.`);
  }
  return json;
}

async function postMultipart(url: string, fields: [string, string][]): Promise<Record<string, unknown>> {
  const boundary = `kinesis.form.${crypto.randomUUID()}`;
  return postJSON(url, {
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
    Accept: "application/json",
    Origin: "https://auth.meta.com",
  }, multipartBody(fields, boundary));
}

export const MetaAuth = {
  /// Step 1: anonymous webview tokens query.
  async tokensQuery(): Promise<SSOTokens> {
    const lsd = makeLSD();
    const json = await postMultipart(TOKENS_QUERY_URL, [["access_token", FRL_CLIENT], ["lsd", lsd], ["jazoest", jazoest(lsd)]]);
    const nativeSSOToken = json.native_sso_token as string;
    const etoken = json.native_sso_etoken as string;
    if (!nativeSSOToken || !etoken) throw new MetaAuthError("meta didn't return sign-in tokens. try again.");
    return { nativeSSOToken, etoken };
  },

  /// The token the login callback must present: first 16 hex of SHA-256(request token).
  expectedCallbackToken(nativeSSOToken: string): string {
    return createHash("sha256").update(Buffer.from(nativeSSOToken, "utf8")).digest("hex").slice(0, 16);
  },

  callbackMatches(token: string | undefined, nativeSSOToken: string): boolean {
    if (!token || token.length !== 16) return false;
    const expected = MetaAuth.expectedCallbackToken(nativeSSOToken);
    let diff = 0;
    for (let i = 0; i < 16; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  },

  /// Step 3: decrypt the login blob into the FRL access token.
  async decryptBlob(blob: string, requestToken: string): Promise<string> {
    const lsd = makeLSD();
    const json = await postMultipart(BLOBS_DECRYPT_URL, [
      ["blob", blob], ["request_token", requestToken], ["access_token", FRL_CLIENT], ["lsd", lsd], ["jazoest", jazoest(lsd)],
    ]);
    const token = json.access_token as string;
    if (!token) throw new MetaAuthError("meta didn't confirm the sign-in. try again.");
    return token;
  },

  /// Step 4: exchange the FRL token for the ar user session.
  async login(frlAccessToken: string): Promise<MetaSession> {
    const deviceID = crypto.randomUUID();
    const json = await postJSON(LOGIN_URL, {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: "OAuth " + AR_CLIENT,
    }, urlForm([
      ["frl_access_token", frlAccessToken], ["logging_session_id", crypto.randomUUID()], ["format", "json"],
      ["device_id", deviceID], ["generate_session_cookies", "1"], ["generate_analytics_claim", "1"], ["method", "POST"],
    ]));
    const token = json.access_token as string;
    const userID = typeof json.user_id === "number" ? String(json.user_id) : (json.user_id as string);
    if (!token || !userID) throw new MetaAuthError("meta didn't return an account session. try again.");
    return { accessToken: token, userID, deviceID, obtainedAt: Date.now() };
  },

  /// Parse the intercepted `fb-viewapp://frl_login?token=…&blob=…` callback URL.
  parseCallback(url: string): { token: string | undefined; blob: string | undefined } {
    const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
    const params = new URLSearchParams(query);
    return { token: params.get("token") ?? undefined, blob: params.get("blob") ?? undefined };
  },

  urlForm,
};

/// File-based Meta session store (mirrors BandIdentity; the macOS app uses the keychain).
export const MetaSessionStore = {
  path(): string {
    const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    return join(base, "kinesis", "meta-session.json");
  },
  async save(session: MetaSession): Promise<void> {
    const path = MetaSessionStore.path();
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, JSON.stringify({ ...session, universe: META_UNIVERSE }, null, 2) + "\n");
  },
  async restore(): Promise<MetaSession | undefined> {
    const file = Bun.file(MetaSessionStore.path());
    if (!(await file.exists())) return undefined;
    try {
      const s = (await file.json()) as MetaSession & { universe?: string };
      if (s.universe !== META_UNIVERSE || !s.accessToken || !s.userID) return undefined;
      return { accessToken: s.accessToken, userID: s.userID, deviceID: s.deviceID, obtainedAt: s.obtainedAt };
    } catch {
      return undefined;
    }
  },
  async delete(): Promise<void> {
    await Bun.file(MetaSessionStore.path()).delete().catch(() => {});
  },
};
