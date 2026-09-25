// Raw sEMG: the band's EMG configuration and sample batches. Port of KinesisCore/EMGReadings.swift.
// Values are ADC counts; voltage calibration and electrode order are unknown.

import { BandProtocolError, ProtoFields } from "./wire";

export interface EMGConfiguration {
  sampleRate: number;
  channels: number;
  adcBits: number;
  samplesPerBatch: number;
  encoding: number;
}

export const EMG_CHANNELS = 8;
export const EMG_SAMPLES_PER_BATCH = 16;
export const EMG_SAMPLE_INTERVAL_US = 1_000_000 / 2048;
export const EMG_BATCH_DURATION_US = EMG_SAMPLES_PER_BATCH * EMG_SAMPLE_INTERVAL_US;

/// Config read response: status (2) = 1, config (6) → emg (42) → rate, channels, bits, batch, encoding.
export function parseEMGConfiguration(response: Uint8Array): EMGConfiguration {
  const fields = new ProtoFields(response);
  if (fields.requiredInteger(2) !== 1n) throw new BandProtocolError("The band rejected the EMG configuration read.");
  const emg = new ProtoFields(new ProtoFields(fields.bytes(6)).bytes(42));
  return {
    sampleRate: Number(emg.requiredInteger(1)),
    channels: Number(emg.requiredInteger(2)),
    adcBits: Number(emg.requiredInteger(4)),
    samplesPerBatch: Number(emg.requiredInteger(5)),
    encoding: Number(emg.requiredInteger(10)),
  };
}

/// The observed layout the readings view supports.
export function isSupportedEMG(config: EMGConfiguration): boolean {
  return config.sampleRate === 2048 && config.channels === 8 && config.adcBits === 16
    && config.samplesPerBatch === 16 && config.encoding === 0;
}

export interface EMGBatch {
  sequence: bigint;
  timestampUs: bigint;
  /// Unsigned little-endian, interleaved by sample then channel (16 × 8).
  values: number[];
}

export function parseEMGBatch(payload: Uint8Array): EMGBatch {
  const fields = new ProtoFields(payload);
  const bytes = fields.bytes(3, 256);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Array<number>(128);
  for (let i = 0; i < 128; i++) values[i] = view.getUint16(i * 2, true);
  return { sequence: fields.requiredInteger(1), timestampUs: fields.requiredInteger(2), values };
}
