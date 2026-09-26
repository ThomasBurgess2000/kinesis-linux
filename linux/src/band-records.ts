// What the band says besides sensor data: its device info, configuration, stream state, battery,
// and anything this client doesn't otherwise understand, decoded field by field. Each distinct
// message is kept once, logged the first time it arrives, and saved for `kinesis inspect`. Only what the band
// sends on its own or in answer to requests the client already makes; nothing is sent to find it.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type ProtoNode, decodeProto, formatProto } from "./protoview";

export interface BandRecord {
  /// What the message is, as far as it's known (e.g. "configuration", "device info").
  name: string;
  channel: number;
  kind: number;
  firstSeen: string;
  lastSeen: string;
  /// How many times this content arrived (request IDs aside).
  count: number;
  hex: string;
  decoded: ProtoNode[] | null;
}

export function recordsPath(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kinesis", "band-records.json");
}

/// The input service's channels, by their low byte. Replies come back on the request's channel.
const CHANNELS: Record<number, string> = {
  1: "link setup", 2: "identity", 3: "device info", 5: "stream control", 6: "configuration", 7: "sensor configuration",
  8: "battery",
};

const KINDS: Record<number, string> = {
  0x02000315: "reply", 0x0300c001: "refusal", 0x02001000: "link setup", 0x03001000: "identity acknowledgement",
};

export function recordName(channel: number, kind: number): string {
  const where = CHANNELS[channel & 0xff] ?? `channel 0x${channel.toString(16)}`;
  const what = KINDS[kind] ?? `message 0x${kind.toString(16).padStart(8, "0")}`;
  return `${where} ${what}`;
}

/// Distinct messages kept; the least recently seen go first.
const MAXIMUM_RECORDS = 200;
/// Some messages change every time (battery readings carry temperature, current and a clock), so
/// only the first few versions of each kind are logged, and only the latest few are kept.
const LOGGED_PER_KIND = 3;
const KEPT_PER_KIND = 5;

export class BandRecords {
  private readonly records = new Map<string, BandRecord>();
  /// Distinct versions seen this session, per channel and message type.
  private readonly versions = new Map<string, number>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onChange: (record: BandRecord, text: string) => void, private readonly path = recordsPath()) {}

  /// Loads what earlier sessions saw, so `inspect` has something before the band next connects.
  async load(): Promise<void> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return;
    try {
      const saved: unknown = await file.json();
      if (!Array.isArray(saved)) return;
      for (const record of saved) {
        if (record && typeof record.name === "string" && typeof record.hex === "string") {
          this.records.set(key(record.channel, record.kind, content(record.decoded ?? null, record.hex)), record);
        }
      }
    } catch {
      // A damaged file is replaced on the next save.
    }
  }

  receive(channel: number, kind: number, payload: Uint8Array): void {
    const hex = Buffer.from(payload).toString("hex");
    const now = new Date().toISOString();
    const decoded = decodeProto(payload, kind === 0x02000315 ? "RpcResponse" : undefined) ?? null;
    // Replies carry a new request ID each time; the same content with a new ID is the same answer.
    const id = key(channel, kind, content(decoded, hex));
    const existing = this.records.get(id);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = now;
      return;
    }
    const record: BandRecord = { name: recordName(channel, kind), channel, kind, firstSeen: now, lastSeen: now, count: 1, hex, decoded };
    const kindKey = `${channel & 0xff}:${kind}`;
    const versions = (this.versions.get(kindKey) ?? 0) + 1;
    this.versions.set(kindKey, versions);
    this.records.set(id, record);
    const sameKind = [...this.records].filter(([k]) => k.startsWith(`${kindKey}:`));
    const evict = sameKind.length > KEPT_PER_KIND ? sameKind : this.records.size > MAXIMUM_RECORDS ? [...this.records] : [];
    const oldest = evict.sort((a, b) => a[1].lastSeen.localeCompare(b[1].lastSeen))[0];
    if (oldest) this.records.delete(oldest[0]);
    if (versions <= LOGGED_PER_KIND) this.onChange(record, describe(record));
    this.scheduleSave();
  }

  list(): BandRecord[] {
    return [...this.records.values()].sort((a, b) => a.name.localeCompare(b.name) || a.firstSeen.localeCompare(b.firstSeen));
  }

  private scheduleSave(): void {
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = undefined;
      mkdirSync(dirname(this.path), { recursive: true });
      void Bun.write(this.path, JSON.stringify(this.list(), null, 2) + "\n");
    }, 1000);
  }
}

function content(decoded: ProtoNode[] | null, hex: string): string {
  return decoded ? JSON.stringify(decoded.filter((node) => !(node.field === 1 && node.name === "requestId"))) : hex;
}

function key(channel: number, kind: number, content: string): string {
  return `${channel & 0xff}:${kind}:${Bun.hash(content).toString(16)}`;
}

/// A record as readable text: what it is, then its fields.
export function describe(record: BandRecord): string {
  const header = `${record.name} (channel 0x${record.channel.toString(16)}, type 0x${record.kind.toString(16).padStart(8, "0")}, ${record.hex.length / 2} bytes)`;
  // Decoded again from the bytes, so names learned since it was saved apply.
  const decoded = decodeProto(Buffer.from(record.hex, "hex"), record.kind === 0x02000315 ? "RpcResponse" : undefined);
  const body = decoded ? formatProto(decoded, "  ") : `  not protobuf: 0x${record.hex}`;
  return `${header}\n${body}`;
}
