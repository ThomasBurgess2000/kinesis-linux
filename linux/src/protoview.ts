// A schema-less protobuf reader for looking inside the band's messages: every field, nested
// messages where the bytes parse as one, text where they read as text, hex otherwise. Field names
// come from what neural-band-poc recovered from the phone app's name maps (see its docs/
// handedness.md, findings.md and gesture-models.md); anything unnamed is still shown by number.
// Names ending in "?" are this port's inferences from the values a band reported, not names from
// the app: see linux/docs/band-records.md.

export type ProtoNode =
  | { field: number; name?: string; wire: "varint"; value: string }
  | { field: number; name?: string; wire: "fixed32" | "fixed64"; value: string; float?: number }
  | { field: number; name?: string; wire: "bytes"; length: number; nested?: ProtoNode[]; text?: string; hex?: string };

/// Field names by message, as far as they are known. `message` names the message a field holds.
interface Schema {
  [field: number]: { name: string; message?: string };
}

const SCHEMAS: Record<string, Schema> = {
  RpcRequest: { 1: { name: "requestId" }, 3: { name: "deviceInfoReq" }, 4: { name: "streamControlReq", message: "StreamControl" }, 5: { name: "configReq", message: "Config" } },
  RpcResponse: {
    1: { name: "requestId" }, 2: { name: "status" }, 3: { name: "batteryResp", message: "BatteryResp" },
    4: { name: "deviceInfoResp", message: "DeviceInfo" }, 5: { name: "streamControlResp", message: "StreamControl" },
    6: { name: "configResp", message: "Config" },
  },
  BatteryResp: { 1: { name: "batteryData", message: "Battery" } },
  Battery: {
    1: { name: "level" }, 2: { name: "charging" }, 3: { name: "temperatureC?" }, 4: { name: "millivolts?" }, 5: { name: "milliamps?" },
    6: { name: "uptimeSeconds?" },
  },
  StreamControl: {
    2: { name: "enableRawEmg" }, 3: { name: "enableGestures" }, 4: { name: "enableRawInference" }, 6: { name: "enableGyro" },
    8: { name: "enableQuat" },
  },
  Config: {
    10: { name: "isLeftHanded" }, 40: { name: "accelerometer?", message: "ImuConfig" }, 41: { name: "gyroscope?", message: "ImuConfig" },
    42: { name: "emgConfig", message: "EmgConfig" }, 46: { name: "inferenceConfig", message: "InferenceConfig" },
  },
  ImuConfig: { 2: { name: "rateHz?" }, 4: { name: "unitsPerCount?" }, 5: { name: "range?" }, 8: { name: "calibration?" } },
  EmgConfig: { 1: { name: "samplingFrequency" }, 2: { name: "channels" }, 4: { name: "adcBits" }, 5: { name: "samplesPerBatch" }, 10: { name: "encoding" } },
  InferenceConfig: { 1: { name: "downsampleWindow" }, 2: { name: "modelStride" }, 3: { name: "pipelineType" }, 4: { name: "normalized" }, 5: { name: "numLogits" } },
  DeviceInfo: {
    1: { name: "manufacturer?" }, 2: { name: "firmwareRevision?" }, 3: { name: "firmwareBuild?" }, 4: { name: "hardwareStage?" },
    5: { name: "gestureModel?" }, 6: { name: "serialNumber?" }, 7: { name: "emgRateHz?" }, 8: { name: "imuRateHz?" }, 9: { name: "modelId" },
    10: { name: "allModelIds" },
  },
};

/// Decodes `data` as a protobuf message, or undefined when it isn't one.
export function decodeProto(data: Uint8Array, message?: string, depth = 0): ProtoNode[] | undefined {
  const nodes: ProtoNode[] = [];
  const schema = message ? SCHEMAS[message] : undefined;
  let offset = 0;
  const varint = (): bigint | undefined => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= data.length) return undefined;
      const byte = data[offset++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return value;
    }
    return undefined;
  };
  while (offset < data.length) {
    const tag = varint();
    if (tag === undefined) return undefined;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field < 1 || field >= 1 << 29) return undefined;
    const known = schema?.[field];
    const name = known?.name;
    if (wire === 0) {
      const value = varint();
      if (value === undefined) return undefined;
      nodes.push({ field, ...(name ? { name } : {}), wire: "varint", value: value.toString() });
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (offset + size > data.length) return undefined;
      const view = new DataView(data.buffer, data.byteOffset + offset, size);
      const value = wire === 1 ? view.getBigUint64(0, true).toString() : view.getUint32(0, true).toString();
      const float = wire === 5 ? view.getFloat32(0, true) : view.getFloat64(0, true);
      nodes.push({ field, ...(name ? { name } : {}), wire: wire === 1 ? "fixed64" : "fixed32", value, ...(Number.isFinite(float) ? { float } : {}) });
      offset += size;
    } else if (wire === 2) {
      const size = varint();
      if (size === undefined || offset + Number(size) > data.length) return undefined;
      const bytes = data.subarray(offset, offset + Number(size));
      offset += Number(size);
      const node: ProtoNode = { field, ...(name ? { name } : {}), wire: "bytes", length: bytes.length };
      const text = printable(bytes);
      const nested = depth < 8 && bytes.length > 0 ? decodeProto(bytes, known?.message, depth + 1) : undefined;
      // Short printable strings also parse as protobuf by accident; prefer text for those.
      if (text !== undefined && (!known?.message || !nested)) node.text = text;
      else if (nested && nested.length > 0) node.nested = nested;
      else node.hex = Buffer.from(bytes).toString("hex");
      nodes.push(node);
    } else {
      return undefined;
    }
  }
  return nodes;
}

function printable(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  // Protobuf tags and lengths are mostly control characters, so text without them is text.
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? undefined : text;
}

/// Indented text, one field per line, for logs and the CLI.
export function formatProto(nodes: ProtoNode[], indent = ""): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const label = `${indent}${node.field}${node.name ? ` ${node.name}` : ""}`;
    switch (node.wire) {
      case "varint":
        lines.push(`${label} = ${node.value}`);
        break;
      case "fixed32":
      case "fixed64":
        lines.push(`${label} = ${node.value} (${node.wire}${node.float !== undefined ? `, as float ${node.float}` : ""})`);
        break;
      case "bytes":
        if (node.nested) {
          lines.push(`${label} {`, formatProto(node.nested, `${indent}  `), `${indent}}`);
        } else if (node.text !== undefined) {
          lines.push(`${label} = ${JSON.stringify(node.text)}`);
        } else {
          lines.push(`${label} = ${node.hex ? `0x${node.hex}` : "(empty)"} (${node.length} bytes)`);
        }
        break;
    }
  }
  return lines.join("\n");
}
