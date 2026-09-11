import { decodeBase64URL, encodeBase64URL } from "../protocol/v0/base64url.js";
import {
  cborMap,
  decodeDeterministicCbor,
  encodeDeterministicCbor,
  getRequiredEntry,
  readBoolean,
  readBytes,
  readCborMap,
  readText,
  readUint,
  rejectUnknownEntries,
  type CborMap
} from "../protocol/v0/cbor.js";

// These are endpoint-to-endpoint DataChannel frames. They deliberately do not
// reuse a relay ENVELOPE or expose relay routing, capability, or ACK fields.
export const rtcDataVersion = "branch.rtc.data/0.draft" as const;
// The existing sealed payload is capped at 8192 base64url characters. Direct
// DATA carries its decoded bytes, so it cannot exceed floor(8192 / 4) * 3.
export const maxRtcDataCiphertextBytes = 6 * 1024;
export const maxRtcDataFrameBytes = 8 * 1024;
export const maxRtcAdmitFrameBytes = 256;

export interface RtcData {
  readonly kind: "data";
  readonly version: typeof rtcDataVersion;
  readonly rtcSessionId: string;
  readonly originRouteId: string;
  readonly pathEpoch: number;
  readonly streamId: number;
  readonly deliveryId: string;
  readonly ackRequested: boolean;
  // This base64url form is exactly the decoded bytes of the existing sealed
  // HPKE payload. Its AAD and remote identity are verified by the controller.
  readonly ciphertext: string;
}

export interface RtcAdmit {
  readonly kind: "admit";
  readonly version: typeof rtcDataVersion;
  readonly rtcSessionId: string;
  readonly deliveryId: string;
}

export type RtcDataFrame = RtcData | RtcAdmit;

export function encodeRtcData(value: RtcData): Uint8Array {
  validateRtcData(value);
  return encodeBounded(dataMap(value), maxRtcDataFrameBytes, "rtc data");
}

export function decodeRtcData(bytes: Uint8Array): RtcData {
  const map = strictMap(bytes, "rtc data", maxRtcDataFrameBytes, [
    "kind", "version", "rtc_session_id", "origin_route_id", "path_epoch",
    "stream_id", "delivery_id", "ack_requested", "ciphertext"
  ]);
  const value: RtcData = {
    kind: readKind(map, "data"),
    version: readVersion(map),
    rtcSessionId: tokenFromMap(map, "rtc_session_id", 16),
    originRouteId: tokenFromMap(map, "origin_route_id", 16),
    pathEpoch: readSequence(map, "path_epoch"),
    streamId: readSequence(map, "stream_id"),
    deliveryId: tokenFromMap(map, "delivery_id", 16),
    ackRequested: readBoolean(getRequiredEntry(map, "ack_requested"), "ack_requested"),
    ciphertext: boundedCiphertextFromMap(map)
  };
  validateRtcData(value);
  return value;
}

export function encodeRtcAdmit(value: RtcAdmit): Uint8Array {
  validateRtcAdmit(value);
  return encodeBounded(cborMap([
    { key: "kind", value: value.kind },
    { key: "version", value: value.version },
    { key: "rtc_session_id", value: decodeToken(value.rtcSessionId, 16, "rtc session id") },
    { key: "delivery_id", value: decodeToken(value.deliveryId, 16, "delivery id") }
  ]), maxRtcAdmitFrameBytes, "rtc admit");
}

export function decodeRtcAdmit(bytes: Uint8Array): RtcAdmit {
  const keys = ["kind", "version", "rtc_session_id", "delivery_id"] as const;
  const map = strictMap(bytes, "rtc admit", maxRtcAdmitFrameBytes, keys, keys);
  const value: RtcAdmit = {
    kind: readKind(map, "admit"),
    version: readVersion(map),
    rtcSessionId: tokenFromMap(map, "rtc_session_id", 16),
    deliveryId: tokenFromMap(map, "delivery_id", 16)
  };
  validateRtcAdmit(value);
  return value;
}

export function decodeRtcDataFrame(bytes: Uint8Array): RtcDataFrame {
  const map = strictMap(bytes, "rtc data frame", maxRtcDataFrameBytes, [
    "kind", "version", "rtc_session_id", "origin_route_id", "path_epoch",
    "stream_id", "delivery_id", "ack_requested", "ciphertext"
  ], ["kind", "version", "rtc_session_id", "delivery_id"]);
  const kind = readText(getRequiredEntry(map, "kind"), "kind");
  if (kind === "data") return decodeRtcData(bytes);
  if (kind === "admit") return decodeRtcAdmit(bytes);
  throw new Error("unknown rtc data kind");
}

export function validateRtcData(value: RtcData): void {
  if (
    value.kind !== "data" ||
    value.version !== rtcDataVersion ||
    !validToken(value.rtcSessionId, 16) ||
    !validToken(value.originRouteId, 16) ||
    !validSequence(value.pathEpoch) ||
    !validSequence(value.streamId) ||
    !validToken(value.deliveryId, 16) ||
    typeof value.ackRequested !== "boolean" ||
    !validCiphertext(value.ciphertext)
  ) {
    throw new Error("invalid rtc data");
  }
}

export function validateRtcAdmit(value: RtcAdmit): void {
  if (value.kind !== "admit" || value.version !== rtcDataVersion || !validToken(value.rtcSessionId, 16) || !validToken(value.deliveryId, 16)) {
    throw new Error("invalid rtc admit");
  }
}

function dataMap(value: RtcData): CborMap {
  return cborMap([
    { key: "kind", value: value.kind },
    { key: "version", value: value.version },
    { key: "rtc_session_id", value: decodeToken(value.rtcSessionId, 16, "rtc session id") },
    { key: "origin_route_id", value: decodeToken(value.originRouteId, 16, "origin route id") },
    { key: "path_epoch", value: value.pathEpoch },
    { key: "stream_id", value: value.streamId },
    { key: "delivery_id", value: decodeToken(value.deliveryId, 16, "delivery id") },
    { key: "ack_requested", value: value.ackRequested },
    { key: "ciphertext", value: decodeCiphertext(value.ciphertext) }
  ]);
}

function strictMap(bytes: Uint8Array, label: string, maximumBytes: number, dataKeys: readonly string[], admitKeys?: readonly string[]): CborMap {
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new Error(`invalid ${label} size`);
  }
  const map = readCborMap(decodeDeterministicCbor(bytes, maximumBytes), label.replaceAll(" ", "_"));
  const kind = readText(getRequiredEntry(map, "kind"), "kind");
  if (kind === "data") {
    rejectUnknownEntries(map, dataKeys);
  } else if (kind === "admit" && admitKeys !== undefined) {
    rejectUnknownEntries(map, admitKeys);
  } else if (kind === "admit") {
    throw new Error("invalid rtc data kind");
  } else {
    throw new Error("unknown rtc data kind");
  }
  return map;
}

function encodeBounded(map: CborMap, maximumBytes: number, label: string): Uint8Array {
  const bytes = encodeDeterministicCbor(map);
  if (bytes.byteLength > maximumBytes) {
    throw new Error(`${label} too large`);
  }
  return bytes;
}

function readKind<Kind extends RtcDataFrame["kind"]>(map: CborMap, expected: Kind): Kind {
  const kind = readText(getRequiredEntry(map, "kind"), "kind");
  if (kind !== expected) throw new Error("invalid rtc data kind");
  return expected;
}

function readVersion(map: CborMap): typeof rtcDataVersion {
  if (readText(getRequiredEntry(map, "version"), "version") !== rtcDataVersion) {
    throw new Error("unsupported rtc data version");
  }
  return rtcDataVersion;
}

function tokenFromMap(map: CborMap, key: string, size: number): string {
  return encodeBase64URL(readBytes(getRequiredEntry(map, key), key, size));
}

function boundedCiphertextFromMap(map: CborMap): string {
  const ciphertext = readBytes(getRequiredEntry(map, "ciphertext"), "ciphertext");
  if (ciphertext.byteLength > maxRtcDataCiphertextBytes) throw new Error("invalid ciphertext");
  return encodeBase64URL(ciphertext);
}

function readSequence(map: CborMap, key: string): number {
  const value = readUint(getRequiredEntry(map, key), key);
  if (!validSequence(value)) throw new Error(`invalid ${key}`);
  return value;
}

function decodeToken(value: string, size: number, label: string): Uint8Array {
  try {
    const bytes = decodeBase64URL(value);
    if (bytes.byteLength !== size) throw new Error("invalid token size");
    return bytes;
  } catch {
    throw new Error(`invalid ${label}`);
  }
}

function decodeCiphertext(value: string): Uint8Array {
  try {
    const bytes = decodeBase64URL(value);
    if (bytes.byteLength > maxRtcDataCiphertextBytes) throw new Error("ciphertext too large");
    return bytes;
  } catch {
    throw new Error("invalid ciphertext");
  }
}

function validToken(value: string, size: number): boolean {
  try {
    return decodeBase64URL(value).byteLength === size;
  } catch {
    return false;
  }
}

function validCiphertext(value: string): boolean {
  try {
    const bytes = decodeBase64URL(value);
    return bytes.byteLength > 0 && bytes.byteLength <= maxRtcDataCiphertextBytes;
  } catch {
    return false;
  }
}

function validSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
