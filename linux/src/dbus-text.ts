// Parser for busctl's plain (non-JSON) reply format, driven by the D-Bus signature that
// starts each reply. busctl's --json mode cannot serialise a{qv}, which BlueZ uses for
// ManufacturerData, so JSON is unusable once any advertising phone or beacon is nearby.
//
// Example reply:  a{sv} 2 "Address" s "AA:BB:CC:DD:EE:FF" "RSSI" n -73

export type DbusValue = string | number | bigint | boolean | Uint8Array | DbusValue[] | Map<DbusValue, DbusValue> | undefined;

export class DbusParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbusParseError";
  }
}

/// Splits busctl output into tokens, keeping quoted strings (with escapes) as one token.
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') {
      let out = '"';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) { out += text[i]! + text[i + 1]!; i += 2; continue; }
        out += text[i]!;
        i++;
      }
      if (text[i] !== '"') throw new DbusParseError("Unterminated string in busctl output");
      i++;
      tokens.push(out + '"');
      continue;
    }
    let j = i;
    while (j < text.length && !/\s/.test(text[j]!)) j++;
    tokens.push(text.slice(i, j));
    i = j;
  }
  return tokens;
}

function unquote(token: string): string {
  if (token.length < 2 || !token.startsWith('"') || !token.endsWith('"')) {
    throw new DbusParseError(`Expected a quoted string, got ${token}`);
  }
  return token.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

/// Returns the length of the single complete type starting at signature[index].
function typeLength(signature: string, index: number): number {
  const ch = signature[index];
  if (ch === undefined) throw new DbusParseError("Unexpected end of signature");
  if (ch === "a") return 1 + typeLength(signature, index + 1);
  if (ch === "(" || ch === "{") {
    const close = ch === "(" ? ")" : "}";
    let depth = 1;
    let i = index + 1;
    while (i < signature.length && depth > 0) {
      if (signature[i] === "(" || signature[i] === "{") depth++;
      else if (signature[i] === ")" || signature[i] === "}") depth--;
      i++;
    }
    if (depth !== 0 || signature[i - 1] !== close) throw new DbusParseError(`Unbalanced signature ${signature}`);
    return i - index;
  }
  return 1;
}

class Reader {
  private index = 0;
  constructor(private readonly tokens: string[]) {}

  next(): string {
    const token = this.tokens[this.index++];
    if (token === undefined) throw new DbusParseError("Unexpected end of busctl output");
    return token;
  }

  done(): boolean {
    return this.index >= this.tokens.length;
  }

  value(signature: string): DbusValue {
    const ch = signature[0]!;
    switch (ch) {
      case "s":
      case "o":
      case "g":
        return unquote(this.next());
      case "b": {
        const token = this.next();
        if (token !== "true" && token !== "false") throw new DbusParseError(`Expected a boolean, got ${token}`);
        return token === "true";
      }
      case "y": case "n": case "q": case "i": case "u": case "h": {
        const token = this.next();
        const number = Number(token);
        if (!Number.isInteger(number)) throw new DbusParseError(`Expected an integer, got ${token}`);
        return number;
      }
      case "x": case "t":
        return BigInt(this.next());
      case "d":
        return Number(this.next());
      case "v": {
        const inner = this.next();
        return this.value(inner);
      }
      case "a": {
        const element = signature.slice(1);
        const count = Number(this.next());
        if (!Number.isInteger(count) || count < 0) throw new DbusParseError("Expected an array length");
        if (element === "y") {
          const bytes = new Uint8Array(count);
          for (let i = 0; i < count; i++) bytes[i] = Number(this.next());
          return bytes;
        }
        if (element.startsWith("{")) {
          const inner = element.slice(1, -1);
          const keyLength = typeLength(inner, 0);
          const keySig = inner.slice(0, keyLength);
          const valueSig = inner.slice(keyLength);
          const map = new Map<DbusValue, DbusValue>();
          for (let i = 0; i < count; i++) {
            const key = this.value(keySig);
            map.set(key, this.value(valueSig));
          }
          return map;
        }
        const items: DbusValue[] = [];
        for (let i = 0; i < count; i++) items.push(this.value(element));
        return items;
      }
      case "(": {
        const inner = signature.slice(1, -1);
        const items: DbusValue[] = [];
        let i = 0;
        while (i < inner.length) {
          const length = typeLength(inner, i);
          items.push(this.value(inner.slice(i, i + length)));
          i += length;
        }
        return items;
      }
      default:
        throw new DbusParseError(`Unsupported D-Bus type ${ch}`);
    }
  }
}

/// Parses a full busctl reply: leading signature, then one value per top-level type.
export function parseReply(text: string): DbusValue[] {
  const tokens = tokenize(text.trim());
  if (tokens.length === 0) return [];
  const reader = new Reader(tokens);
  const signature = reader.next();
  const values: DbusValue[] = [];
  let i = 0;
  while (i < signature.length) {
    const length = typeLength(signature, i);
    values.push(reader.value(signature.slice(i, i + length)));
    i += length;
  }
  if (!reader.done()) throw new DbusParseError("Trailing tokens in busctl output");
  return values;
}

export type PropertyMap = Map<DbusValue, DbusValue>;

export function asMap(value: DbusValue): PropertyMap {
  if (!(value instanceof Map)) throw new DbusParseError("Expected a D-Bus dictionary");
  return value;
}

export function getString(map: PropertyMap, key: string): string | undefined {
  const value = map.get(key);
  return typeof value === "string" ? value : undefined;
}

export function getNumber(map: PropertyMap, key: string): number | undefined {
  const value = map.get(key);
  return typeof value === "number" ? value : undefined;
}

export function getBoolean(map: PropertyMap, key: string): boolean | undefined {
  const value = map.get(key);
  return typeof value === "boolean" ? value : undefined;
}

export function getStrings(map: PropertyMap, key: string): string[] {
  const value = map.get(key);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
