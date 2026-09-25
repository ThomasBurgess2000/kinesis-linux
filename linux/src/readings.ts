// Live raw sEMG for the readings view: batch bookkeeping (gaps, restarts, invalid layouts), rates,
// and JSONL recording of the original payloads. Port of Kinesis/EMGReadings.swift and the Mac
// app's raw recorder.

import { type EMGBatch, type EMGConfiguration, isSupportedEMG, parseEMGBatch } from "./emg";

export interface ReadingsStats {
  issue: string | null;
  frames: number;
  missingBatches: number;
  invalidFrames: number;
  /// Samples per second per channel, and payload bytes per second, over the last second.
  sampleRate: number;
  byteRate: number;
}

export class EMGReadings {
  private config: EMGConfiguration | undefined;
  private issue: string | null = null;
  private frames = 0;
  private bytes = 0;
  private missingBatches = 0;
  private invalidFrames = 0;
  private sampleFrames = 0;
  private lastSequence: bigint | undefined;
  private lastTimestamp: bigint | undefined;
  private fresh: EMGBatch[] = [];
  private restarted = false;
  private rateAt = 0;
  private rateSamples = 0;
  private rateBytes = 0;
  private sampleRate = 0;
  private byteRate = 0;

  reset(): void {
    Object.assign(this, new EMGReadings());
  }

  configure(config: EMGConfiguration): void {
    this.config = config;
    this.lastSequence = undefined;
    this.lastTimestamp = undefined;
    this.fresh = [];
    this.restarted = true;
    this.issue = isSupportedEMG(config) ? null : "This EMG format isn't supported yet. Raw recording is still available.";
  }

  receive(payload: Uint8Array): void {
    this.frames += 1;
    this.bytes += payload.length;
    if (!this.config) {
      this.issue = "Waiting for the band's EMG configuration.";
      return;
    }
    if (!isSupportedEMG(this.config)) return;
    let batch: EMGBatch;
    try {
      batch = parseEMGBatch(payload);
    } catch {
      this.invalidFrames += 1;
      this.fresh = [];
      this.restarted = true;
      this.issue = "Received an unexpected sample layout. The raw payload can still be recorded.";
      return;
    }
    if (this.lastSequence !== undefined && this.lastTimestamp !== undefined) {
      if (batch.sequence <= this.lastSequence || batch.timestampUs <= this.lastTimestamp) {
        // A restart must not join unrelated traces or report an enormous gap.
        this.fresh = [];
        this.restarted = true;
      } else if (batch.sequence - this.lastSequence > 1n) {
        this.missingBatches += Number(batch.sequence - this.lastSequence - 1n);
      }
    }
    this.sampleFrames += 16;
    this.lastSequence = batch.sequence;
    this.lastTimestamp = batch.timestampUs;
    this.fresh.push(batch);
    if (this.fresh.length > 128) this.fresh.splice(0, this.fresh.length - 128);
    this.issue = null;
  }

  /// Batches since the last call, and whether the viewer should clear its trace first.
  take(): { restart: boolean; batches: EMGBatch[] } {
    const taken = { restart: this.restarted, batches: this.fresh };
    this.fresh = [];
    this.restarted = false;
    return taken;
  }

  stats(now: number): ReadingsStats {
    const elapsed = now - this.rateAt;
    if (elapsed >= 1) {
      this.sampleRate = (this.sampleFrames - this.rateSamples) / elapsed;
      this.byteRate = (this.bytes - this.rateBytes) / elapsed;
      this.rateAt = now;
      this.rateSamples = this.sampleFrames;
      this.rateBytes = this.bytes;
    }
    return {
      issue: this.issue, frames: this.frames, missingBatches: this.missingBatches, invalidFrames: this.invalidFrames,
      sampleRate: this.sampleRate, byteRate: this.byteRate,
    };
  }
}

/// The Mac app's raw capture format: one JSON line per batch, sensor payload and timestamps only.
export class RawRecorder {
  frames = 0;
  private readonly writer: ReturnType<ReturnType<typeof Bun.file>["writer"]>;

  constructor(readonly path: string) {
    this.writer = Bun.file(path).writer();
  }

  record(payload: Uint8Array, uptime: number): void {
    this.frames += 1;
    const line = {
      t: new Date().toISOString(), uptime, channel: 5, kind: "0x0200020a", bytes: payload.length,
      payload: Buffer.from(payload).toString("hex"),
    };
    this.writer.write(JSON.stringify(line) + "\n");
  }

  flush(): void {
    void this.writer.flush();
  }

  async close(): Promise<void> {
    await this.writer.end();
  }
}
