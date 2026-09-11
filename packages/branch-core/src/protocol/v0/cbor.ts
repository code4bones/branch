export const maxCborCollectionEntries = 64;
export const maxCborTextBytes = 1024;
export const maxCborBytes = 48 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type CborValue = boolean | number | string | Uint8Array | readonly CborValue[] | CborMap;

export interface CborMap {
  readonly kind: "map";
  readonly entries: readonly CborEntry[];
}

export interface CborEntry {
  readonly key: string;
  readonly value: CborValue;
}

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CborError";
  }
}

export function cborMap(entries: readonly CborEntry[]): CborMap {
  return { kind: "map", entries };
}

export function decodeDeterministicCbor(bytes: Uint8Array, maxBytes = 64 * 1024): CborValue {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new CborError("invalid_cbor_size");
  }
  const decoder = new CborDecoder(bytes);
  const value = decoder.readValue();
  if (!decoder.done()) {
    throw new CborError("trailing_cbor");
  }
  if (!sameBytes(encodeDeterministicCbor(value), bytes)) {
    throw new CborError("non_canonical_cbor");
  }
  return value;
}

export function encodeDeterministicCbor(value: CborValue): Uint8Array {
  if (typeof value === "boolean") {
    return new Uint8Array([value ? 0xf5 : 0xf4]);
  }
  if (typeof value === "number") {
    return encodeUnsigned(value);
  }
  if (typeof value === "string") {
    return encodeBytes(3, textEncoder.encode(value));
  }
  if (value instanceof Uint8Array) {
    return encodeBytes(2, value);
  }
  if (isCborArray(value)) {
    return concatBytes([encodeHeader(4, value.length), ...value.map((entry) => encodeDeterministicCbor(entry))]);
  }
  return encodeMap(value);
}

export function readCborMap(value: CborValue, label: string): CborMap {
  if (!isCborMap(value)) {
    throw new CborError(`missing_${label}`);
  }
  return value;
}

export function getRequiredEntry(map: CborMap, key: string): CborValue {
  const entry = map.entries.find((candidate) => candidate.key === key);
  if (entry === undefined) {
    throw new CborError(`missing_${key}`);
  }
  return entry.value;
}

export function hasEntry(map: CborMap, key: string): boolean {
  return map.entries.some((entry) => entry.key === key);
}

export function rejectUnknownEntries(map: CborMap, keys: readonly string[]): void {
  const known = new Set(keys);
  for (const entry of map.entries) {
    if (!known.has(entry.key)) {
      throw new CborError(`unknown_${entry.key}`);
    }
  }
}

export function readText(value: CborValue, key: string): string {
  if (typeof value !== "string" || value.length === 0 || textEncoder.encode(value).byteLength > maxCborTextBytes) {
    throw new CborError(`invalid_${key}`);
  }
  return value;
}

export function readUint(value: CborValue, key: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CborError(`invalid_${key}`);
  }
  return value;
}

export function readBoolean(value: CborValue, key: string): boolean {
  if (typeof value !== "boolean") {
    throw new CborError(`invalid_${key}`);
  }
  return value;
}

export function readBytes(value: CborValue, key: string, size?: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maxCborBytes) {
    throw new CborError(`invalid_${key}`);
  }
  if (size !== undefined && value.byteLength !== size) {
    throw new CborError(`invalid_${key}`);
  }
  return value;
}

export function readTextArray(value: CborValue, key: string, maxItems = 16): readonly string[] {
  if (!isCborArray(value) || value.length === 0 || value.length > maxItems) {
    throw new CborError(`invalid_${key}`);
  }
  return value.map((entry) => readText(entry, key));
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export function isCborMap(value: CborValue): value is CborMap {
  return typeof value === "object" && !(value instanceof Uint8Array) && !isCborArray(value);
}

export function isCborArray(value: CborValue): value is readonly CborValue[] {
  return Array.isArray(value);
}

function encodeMap(map: CborMap): Uint8Array {
  if (map.entries.length > maxCborCollectionEntries) {
    throw new CborError("too_many_map_entries");
  }
  const seen = new Set<string>();
  const encoded = map.entries.map((entry) => {
    if (seen.has(entry.key)) {
      throw new CborError(`duplicate_${entry.key}`);
    }
    seen.add(entry.key);
    return {
      key: encodeBytes(3, textEncoder.encode(entry.key)),
      value: encodeDeterministicCbor(entry.value)
    };
  });
  encoded.sort((left, right) => compareBytes(left.key, right.key));
  return concatBytes([
    encodeHeader(5, encoded.length),
    ...encoded.flatMap((entry) => [entry.key, entry.value])
  ]);
}

function encodeUnsigned(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CborError("invalid_unsigned");
  }
  return encodeHeader(0, value);
}

function encodeBytes(major: 2 | 3, bytes: Uint8Array): Uint8Array {
  return concatBytes([encodeHeader(major, bytes.byteLength), bytes]);
}

function encodeHeader(major: number, value: number): Uint8Array {
  if (value < 24) {
    return new Uint8Array([(major << 5) | value]);
  }
  if (value <= 0xff) {
    return new Uint8Array([(major << 5) | 24, value]);
  }
  if (value <= 0xffff) {
    return new Uint8Array([(major << 5) | 25, value >> 8, value & 0xff]);
  }
  if (value <= 0xffffffff) {
    return new Uint8Array([(major << 5) | 26, value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
  }
  const bytes = new Uint8Array(9);
  bytes[0] = (major << 5) | 27;
  let remaining = BigInt(value);
  for (let index = 8; index >= 1; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.byteLength - right.byteLength;
}

class CborDecoder {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  done(): boolean {
    return this.offset === this.bytes.byteLength;
  }

  readValue(): CborValue {
    const initial = this.readByte();
    const major = initial >> 5;
    const additional = initial & 0x1f;
    if (major === 7) {
      if (additional === 20) return false;
      if (additional === 21) return true;
      throw new CborError("unsupported_cbor_type");
    }
    const argument = this.readArgument(additional);
    switch (major) {
      case 0:
        return argument;
      case 2:
        return this.readByteString(argument);
      case 3:
        return this.readTextString(argument);
      case 4:
        return this.readArray(argument);
      case 5:
        return this.readMap(argument);
      default:
        throw new CborError("unsupported_cbor_type");
    }
  }

  private readArgument(additional: number): number {
    if (additional < 24) {
      return additional;
    }
    if (additional === 24) {
      const value = this.readByte();
      if (value < 24) {
        throw new CborError("non_canonical_cbor");
      }
      return value;
    }
    if (additional === 25) {
      const value = (this.readByte() << 8) | this.readByte();
      if (value <= 0xff) {
        throw new CborError("non_canonical_cbor");
      }
      return value;
    }
    if (additional === 26) {
      const value = (this.readByte() * 0x1000000) + ((this.readByte() << 16) | (this.readByte() << 8) | this.readByte());
      if (value <= 0xffff) {
        throw new CborError("non_canonical_cbor");
      }
      return value;
    }
    if (additional === 27) {
      let value = 0n;
      for (let index = 0; index < 8; index += 1) {
        value = (value << 8n) | BigInt(this.readByte());
      }
      if (value <= 0xffffffffn || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new CborError("non_canonical_cbor");
      }
      return Number(value);
    }
    throw new CborError("unsupported_cbor_argument");
  }

  private readByteString(length: number): Uint8Array {
    if (length > maxCborBytes || this.offset + length > this.bytes.byteLength) {
      throw new CborError("invalid_cbor_bytes");
    }
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  private readTextString(length: number): string {
    if (length > maxCborTextBytes || this.offset + length > this.bytes.byteLength) {
      throw new CborError("invalid_cbor_text");
    }
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    try {
      return textDecoder.decode(value);
    } catch {
      throw new CborError("invalid_cbor_text");
    }
  }

  private readArray(length: number): readonly CborValue[] {
    if (length > maxCborCollectionEntries) {
      throw new CborError("too_many_array_entries");
    }
    const values: CborValue[] = [];
    for (let index = 0; index < length; index += 1) {
      values.push(this.readValue());
    }
    return values;
  }

  private readMap(length: number): CborMap {
    if (length > maxCborCollectionEntries) {
      throw new CborError("too_many_map_entries");
    }
    const entries: CborEntry[] = [];
    const seen = new Set<string>();
    let previousKey: Uint8Array | null = null;
    for (let index = 0; index < length; index += 1) {
      const keyStart = this.offset;
      const key = this.readValue();
      if (typeof key !== "string") {
        throw new CborError("non_text_map_key");
      }
      const encodedKey = this.bytes.slice(keyStart, this.offset);
      if (previousKey !== null && compareBytes(previousKey, encodedKey) >= 0) {
        throw new CborError("non_canonical_cbor");
      }
      if (seen.has(key)) {
        throw new CborError(`duplicate_${key}`);
      }
      seen.add(key);
      previousKey = encodedKey;
      entries.push({ key, value: this.readValue() });
    }
    return cborMap(entries);
  }

  private readByte(): number {
    const value = this.bytes[this.offset];
    if (value === undefined) {
      throw new CborError("truncated_cbor");
    }
    this.offset += 1;
    return value;
  }
}
