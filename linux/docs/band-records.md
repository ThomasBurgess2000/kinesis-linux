# What the band reports

Captured on 2026-09-25 from one band (hardware stage PVT, firmware build 1043538475) with
`kinesis inspect`, which decodes the band's replies to the requests the client already makes.
Nothing was written to the band to get these.

Names without a `?` come from [neural-band-poc](https://github.com/callbacked/neural-band-poc), which
recovered them from the Meta AI app's protobuf name maps. Names with a `?` are inferences from the
values, not confirmed.

## Device info (reply to the device-info request, RPC response field 4)

| Field | Value | Meaning |
| --- | --- | --- |
| 1 | `Meta Platforms, Inc.` | manufacturer? |
| 2 | `5c2b1ca1f73b+` | firmware revision? (a source revision; `+` usually means a modified tree) |
| 3 | `1043538475` | firmware build? |
| 4 | `PVT` | hardware stage? (production validation test) |
| 5 | `cc_od_resetlstm_F1017719999_260108` | gesture model in use? (also the first of field 10) |
| 6 | a 14-character serial | serial number? The band's advertised name ends with its last four characters. Not recorded here. |
| 7 | 2048 | EMG sample rate? |
| 8 | 128 | IMU sample rate? |
| 10 | six model IDs (below) | `allModelIds` |
| 18 | `cc_od_resetlstm_F1105975896_260701`, `ia_od_F1068590897_260418` | unknown. A newer gesture model build than field 5, so possibly models staged for an update. |

`allModelIds`: `cc_od_resetlstm_F1017719999_260108`, `ia_od_F1068590897_260418`,
`hw_t59_f1076659698_260503`, `Ceres_BOD_v48`, `Ceres_PLI_Detect_v38`, `tightness_f1032497175_260207`.
Going by their names: `cc_od_resetlstm` is the gesture decoder, `tightness` probably judges how
snugly the band sits, `Ceres_PLI_Detect` probably detects power-line interference, and `Ceres_BOD`
may be band-on (wear) detection. `ia` and `hw_t59` are unknown (possibly the wake gesture and
handwriting).

## Configuration (reply to an empty configuration read, RPC response field 6)

| Field | Value | Meaning |
| --- | --- | --- |
| 1 | 128 | IMU rate? |
| 2 | 2048 | EMG rate? |
| 7 | `{ 1: 3 }` | unknown |
| 9 | 4 | unknown |
| 10 | 0 | `isLeftHanded` (writable; the only field this client writes) |
| 11 | 3 | unknown |
| 13 | 0 | unknown |
| 15–20 | six floats, all 0 | unknown; six values suggests an x/y/z pair such as IMU offsets |
| 21 | 30 | unknown; maybe a timeout in seconds |
| 22 | 60 | unknown; maybe a timeout in seconds |
| 23 | 0 | unknown flag |
| 24 | 1 | unknown flag |
| 25 | 1 | unknown flag |
| 40 | IMU block: 128 Hz, scale 0.000244, range 8, calibration | accelerometer? (0.000244 = 1/4096 g per count, the ±8 g range) |
| 41 | IMU block: 128 Hz, scale 0.07, range 2000, calibration | gyroscope? (0.07 °/s per count, the ±2000 °/s range; the air cursor's observed gyro scale is also 0.07) |
| 42 | 2048 Hz, 8 channels, 16-bit, 16 per batch, encoding 0; floats 380, 0, 5, 2.5 | `emgConfig` (the four floats are unnamed; 2.5 may be the ADC reference voltage) |
| 43 | `{ 1: 1, 2: 1, 3: 1 }` | unknown; three flags |
| 46 | downsample 0, stride 32, pipeline 2, 9 logits | `inferenceConfig` |

A haptics setting, if the configuration has one, is most likely among the unknown flags (23, 24,
25, or 43's three), but none is confirmed. Finding out means writing one field at a time, reading it
back, and checking whether gestures still buzz, then restoring it.

## Stream control

An empty stream-control query (a read) lists every stream the band has, all off before the
subscription: fields 2 through 31, except 14, 15, 21 and 24. Known: 2 `enableRawEmg`, 3
`enableGestures`, 4 `enableRawInference`, 6 `enableGyro`, 8 `enableQuat`. The rest (5, 7, 9–13,
16–20, 22, 23, 25–31) are unidentified streams.

## Battery (reply on channel 0x8008, field 3 → 1)

| Field | Example | Meaning |
| --- | --- | --- |
| 1 | 97 | level (%) |
| 2 | 0 | charging |
| 3 | 32.45 (float) | temperature in °C? |
| 4 | 4357 | millivolts? (4.36 V at 97% fits a lithium cell) |
| 5 | 24, 15, 14 | milliamps drawn? |
| 6 | 337940, then +5 every 5 s | uptime in seconds? (about 3.9 days) |
