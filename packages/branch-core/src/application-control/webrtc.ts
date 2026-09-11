import { decodeBase64URL, encodeBase64URL } from "../protocol/v0/base64url.js";
import {
  cborMap,
  decodeDeterministicCbor,
  encodeDeterministicCbor,
  getRequiredEntry,
  readBytes,
  readCborMap,
  readText,
  readUint,
  rejectUnknownEntries,
  type CborMap
} from "../protocol/v0/cbor.js";

// These endpoint-only bodies travel inside an existing signed application
// control and HPKE envelope. They are never relay frames or relay metadata.
export const rtcSignalingVersion = "branch.rtc.signaling/0.draft" as const;
export const rtcCapabilitiesControlKind = "branch.rtc.capabilities/0.draft" as const;
export const rtcOfferControlKind = "branch.rtc.offer/0.draft" as const;
export const rtcAnswerControlKind = "branch.rtc.answer/0.draft" as const;
export const rtcCandidateControlKind = "branch.rtc.candidate/0.draft" as const;
export const rtcRestartControlKind = "branch.rtc.restart/0.draft" as const;
export const rtcCancelControlKind = "branch.rtc.cancel/0.draft" as const;

export const maxRtcSignalingBodyBytes = 2_048;
export const maxRtcDescriptionBytes = 1_536;
export const maxRtcCandidateBytes = 1_024;
export const maxRtcCandidatesPerDirection = 32;
export const rtcSignalingControlTTLms = 60_000;
export const rtcCapabilitiesControlTTLms = 5 * 60_000;

export type RtcCandidateDirection = "offerer" | "answerer";
export type RtcCancelReason = "cancelled" | "rejected" | "glare";

export interface RtcCapabilities {
  readonly version: typeof rtcSignalingVersion;
  readonly maxDescriptionBytes: number;
  readonly maxCandidateBytes: number;
  readonly maxCandidatesPerDirection: number;
}

export interface RtcOffer {
  readonly version: typeof rtcSignalingVersion;
  readonly rtcSessionId: string;
  readonly generation: number;
  readonly description: string;
  readonly descriptionSHA256: string;
  readonly dtlsFingerprintSHA256: string;
}

export interface RtcAnswer extends RtcOffer {
  readonly offerDescriptionSHA256: string;
}

export interface RtcCandidate {
  readonly version: typeof rtcSignalingVersion;
  readonly rtcSessionId: string;
  readonly generation: number;
  readonly direction: RtcCandidateDirection;
  readonly descriptionSHA256: string;
  readonly candidate: string;
}

export interface RtcRestart extends RtcOffer {
  readonly priorDescriptionSHA256: string;
}

export interface RtcCancel {
  readonly version: typeof rtcSignalingVersion;
  readonly rtcSessionId: string;
  readonly generation: number;
  readonly descriptionSHA256: string;
  readonly reason: RtcCancelReason;
}

export type RtcSignalingBody = RtcCapabilities | RtcOffer | RtcAnswer | RtcCandidate | RtcRestart | RtcCancel;

// The application-control runtime currently has synchronous descriptors. A
// SHA-256 verification necessarily uses the reviewed asynchronous Web Crypto
// primitive, so these are deliberately pure signaling descriptors rather than
// unsafe runtime descriptors that could project an unchecked description.
export interface RtcSignalingControlDescriptor<Body extends RtcSignalingBody> {
  readonly kind: string;
  readonly maximumTTLms: number;
  encodeBody(value: Body): Promise<Uint8Array>;
  decodeBody(bytes: Uint8Array): Promise<Body>;
}

export const rtcCapabilitiesControlDescriptor: RtcSignalingControlDescriptor<RtcCapabilities> = {
  kind: rtcCapabilitiesControlKind,
  maximumTTLms: rtcCapabilitiesControlTTLms,
  encodeBody: encodeRtcCapabilities,
  decodeBody: decodeRtcCapabilities
};

export const rtcOfferControlDescriptor: RtcSignalingControlDescriptor<RtcOffer> = {
  kind: rtcOfferControlKind,
  maximumTTLms: rtcSignalingControlTTLms,
  encodeBody: encodeRtcOffer,
  decodeBody: decodeRtcOffer
};

export const rtcAnswerControlDescriptor: RtcSignalingControlDescriptor<RtcAnswer> = {
  kind: rtcAnswerControlKind,
  maximumTTLms: rtcSignalingControlTTLms,
  encodeBody: encodeRtcAnswer,
  decodeBody: decodeRtcAnswer
};

export const rtcCandidateControlDescriptor: RtcSignalingControlDescriptor<RtcCandidate> = {
  kind: rtcCandidateControlKind,
  maximumTTLms: rtcSignalingControlTTLms,
  encodeBody: encodeRtcCandidate,
  decodeBody: decodeRtcCandidate
};

export const rtcRestartControlDescriptor: RtcSignalingControlDescriptor<RtcRestart> = {
  kind: rtcRestartControlKind,
  maximumTTLms: rtcSignalingControlTTLms,
  encodeBody: encodeRtcRestart,
  decodeBody: decodeRtcRestart
};

export const rtcCancelControlDescriptor: RtcSignalingControlDescriptor<RtcCancel> = {
  kind: rtcCancelControlKind,
  maximumTTLms: rtcSignalingControlTTLms,
  encodeBody: encodeRtcCancel,
  decodeBody: decodeRtcCancel
};

export const rtcSignalingControlDescriptors = [
  rtcCapabilitiesControlDescriptor,
  rtcOfferControlDescriptor,
  rtcAnswerControlDescriptor,
  rtcCandidateControlDescriptor,
  rtcRestartControlDescriptor,
  rtcCancelControlDescriptor
] as const;

export async function encodeRtcCapabilities(value: RtcCapabilities): Promise<Uint8Array> {
  validateRtcCapabilities(value);
  return boundedEncoding(cborMap([
    { key: "version", value: value.version },
    { key: "max_description_bytes", value: value.maxDescriptionBytes },
    { key: "max_candidate_bytes", value: value.maxCandidateBytes },
    { key: "max_candidates_per_direction", value: value.maxCandidatesPerDirection }
  ]));
}

export async function decodeRtcCapabilities(bytes: Uint8Array): Promise<RtcCapabilities> {
  const map = strictMap(bytes, "rtc capabilities", ["version", "max_description_bytes", "max_candidate_bytes", "max_candidates_per_direction"]);
  const value: RtcCapabilities = {
    version: readRtcSignalingVersion(map),
    maxDescriptionBytes: readUint(getRequiredEntry(map, "max_description_bytes"), "max_description_bytes"),
    maxCandidateBytes: readUint(getRequiredEntry(map, "max_candidate_bytes"), "max_candidate_bytes"),
    maxCandidatesPerDirection: readUint(getRequiredEntry(map, "max_candidates_per_direction"), "max_candidates_per_direction")
  };
  validateRtcCapabilities(value);
  return value;
}

export async function encodeRtcOffer(value: RtcOffer): Promise<Uint8Array> {
  await validateRtcOffer(value);
  return boundedEncoding(descriptionMap(value));
}

export async function decodeRtcOffer(bytes: Uint8Array): Promise<RtcOffer> {
  const map = strictMap(bytes, "rtc offer", ["version", "rtc_session_id", "generation", "description", "description_sha256", "dtls_fingerprint_sha256"]);
  const value: RtcOffer = descriptionFromMap(map);
  await validateRtcOffer(value);
  return value;
}

export async function encodeRtcAnswer(value: RtcAnswer): Promise<Uint8Array> {
  await validateRtcAnswer(value);
  return boundedEncoding(cborMap([
    ...descriptionEntries(value),
    { key: "offer_description_sha256", value: decodeDigest(value.offerDescriptionSHA256, "offer description hash") }
  ]));
}

export async function decodeRtcAnswer(bytes: Uint8Array): Promise<RtcAnswer> {
  const map = strictMap(bytes, "rtc answer", ["version", "rtc_session_id", "generation", "description", "description_sha256", "dtls_fingerprint_sha256", "offer_description_sha256"]);
  const value: RtcAnswer = {
    ...descriptionFromMap(map),
    offerDescriptionSHA256: digestFromMap(map, "offer_description_sha256")
  };
  await validateRtcAnswer(value);
  return value;
}

export async function encodeRtcCandidate(value: RtcCandidate): Promise<Uint8Array> {
  validateRtcCandidate(value);
  return boundedEncoding(cborMap([
    { key: "version", value: value.version },
    { key: "rtc_session_id", value: decodeToken(value.rtcSessionId, 16, "rtc session id") },
    { key: "generation", value: value.generation },
    { key: "direction", value: value.direction },
    { key: "description_sha256", value: decodeDigest(value.descriptionSHA256, "description hash") },
    { key: "candidate", value: value.candidate }
  ]));
}

export async function decodeRtcCandidate(bytes: Uint8Array): Promise<RtcCandidate> {
  const map = strictMap(bytes, "rtc candidate", ["version", "rtc_session_id", "generation", "direction", "description_sha256", "candidate"]);
  const value: RtcCandidate = {
    version: readRtcSignalingVersion(map),
    rtcSessionId: tokenFromMap(map, "rtc_session_id", 16),
    generation: readGeneration(map),
    direction: readDirection(map),
    descriptionSHA256: digestFromMap(map, "description_sha256"),
    candidate: readBoundedUtf8(map, "candidate", maxRtcCandidateBytes)
  };
  validateRtcCandidate(value);
  return value;
}

export async function encodeRtcRestart(value: RtcRestart): Promise<Uint8Array> {
  await validateRtcRestart(value);
  return boundedEncoding(cborMap([
    { key: "version", value: value.version },
    { key: "rtc_session_id", value: decodeToken(value.rtcSessionId, 16, "rtc session id") },
    { key: "generation", value: value.generation },
    { key: "prior_description_sha256", value: decodeDigest(value.priorDescriptionSHA256, "prior description hash") },
    { key: "description", value: value.description },
    { key: "description_sha256", value: decodeDigest(value.descriptionSHA256, "description hash") },
    { key: "dtls_fingerprint_sha256", value: decodeDigest(value.dtlsFingerprintSHA256, "dtls fingerprint") }
  ]));
}

export async function decodeRtcRestart(bytes: Uint8Array): Promise<RtcRestart> {
  const map = strictMap(bytes, "rtc restart", ["version", "rtc_session_id", "generation", "prior_description_sha256", "description", "description_sha256", "dtls_fingerprint_sha256"]);
  const value: RtcRestart = {
    ...descriptionFromMap(map),
    priorDescriptionSHA256: digestFromMap(map, "prior_description_sha256")
  };
  await validateRtcRestart(value);
  return value;
}

export async function encodeRtcCancel(value: RtcCancel): Promise<Uint8Array> {
  validateRtcCancel(value);
  return boundedEncoding(cborMap([
    { key: "version", value: value.version },
    { key: "rtc_session_id", value: decodeToken(value.rtcSessionId, 16, "rtc session id") },
    { key: "generation", value: value.generation },
    { key: "description_sha256", value: decodeDigest(value.descriptionSHA256, "description hash") },
    { key: "reason", value: value.reason }
  ]));
}

export async function decodeRtcCancel(bytes: Uint8Array): Promise<RtcCancel> {
  const map = strictMap(bytes, "rtc cancel", ["version", "rtc_session_id", "generation", "description_sha256", "reason"]);
  const value: RtcCancel = {
    version: readRtcSignalingVersion(map),
    rtcSessionId: tokenFromMap(map, "rtc_session_id", 16),
    generation: readGeneration(map),
    descriptionSHA256: digestFromMap(map, "description_sha256"),
    reason: readCancelReason(map)
  };
  validateRtcCancel(value);
  return value;
}

export function validateRtcCapabilities(value: RtcCapabilities): void {
  if (value.version !== rtcSignalingVersion || !boundedInteger(value.maxDescriptionBytes, 1, maxRtcDescriptionBytes) || !boundedInteger(value.maxCandidateBytes, 1, maxRtcCandidateBytes) || !boundedInteger(value.maxCandidatesPerDirection, 1, maxRtcCandidatesPerDirection)) {
    throw new Error("invalid rtc capabilities");
  }
}

export async function validateRtcOffer(value: RtcOffer): Promise<void> {
  await validateRtcDescription(value, "offer");
}

export async function validateRtcAnswer(value: RtcAnswer): Promise<void> {
  await validateRtcDescription(value, "answer");
  decodeDigest(value.offerDescriptionSHA256, "offer description hash");
}

export function validateRtcCandidate(value: RtcCandidate): void {
  if (value.version !== rtcSignalingVersion || !validToken(value.rtcSessionId, 16) || !validGeneration(value.generation) || (value.direction !== "offerer" && value.direction !== "answerer") || !validDigest(value.descriptionSHA256) || !validBoundedUtf8(value.candidate, maxRtcCandidateBytes)) {
    throw new Error("invalid rtc candidate");
  }
}

export async function validateRtcRestart(value: RtcRestart): Promise<void> {
  await validateRtcDescription(value, "restart");
  decodeDigest(value.priorDescriptionSHA256, "prior description hash");
}

export function validateRtcCancel(value: RtcCancel): void {
  if (value.version !== rtcSignalingVersion || !validToken(value.rtcSessionId, 16) || !validGeneration(value.generation) || !validDigest(value.descriptionSHA256) || (value.reason !== "cancelled" && value.reason !== "rejected" && value.reason !== "glare")) {
    throw new Error("invalid rtc cancel");
  }
}

// Hashing uses Web Crypto, never an in-tree hash implementation. The returned
// base64url form becomes a 32-byte CBOR byte string in the signed body.
export async function rtcDescriptionSHA256(description: string): Promise<string> {
  if (!validBoundedUtf8(description, maxRtcDescriptionBytes)) {
    throw new Error("invalid rtc description");
  }
  const encoded = new TextEncoder().encode(description);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(encoded).buffer));
  return encodeBase64URL(digest);
}

// Glare policy is deliberately pure and state-free: the RTC session controller
// supplies its immutable peer ids and applies the resulting local action.
// Peer ids have already been canonical base64url-decoded at the identity
// boundary; their textual comparison is the protocol's specified ordering.
function strictMap(bytes: Uint8Array, label: string, keys: readonly string[]): CborMap {
  if (bytes.byteLength === 0 || bytes.byteLength > maxRtcSignalingBodyBytes) {
    throw new Error(`invalid ${label} body size`);
  }
  const map = readCborMap(decodeDeterministicCbor(bytes, maxRtcSignalingBodyBytes), label);
  rejectUnknownEntries(map, keys);
  return map;
}

function boundedEncoding(map: CborMap): Uint8Array {
  const bytes = encodeDeterministicCbor(map);
  if (bytes.byteLength > maxRtcSignalingBodyBytes) {
    throw new Error("rtc signaling body too large");
  }
  return bytes;
}

function descriptionMap(value: RtcOffer): CborMap {
  return cborMap(descriptionEntries(value));
}

function descriptionEntries(value: RtcOffer): { readonly key: string; readonly value: string | number | Uint8Array }[] {
  return [
    { key: "version", value: value.version },
    { key: "rtc_session_id", value: decodeToken(value.rtcSessionId, 16, "rtc session id") },
    { key: "generation", value: value.generation },
    { key: "description", value: value.description },
    { key: "description_sha256", value: decodeDigest(value.descriptionSHA256, "description hash") },
    { key: "dtls_fingerprint_sha256", value: decodeDigest(value.dtlsFingerprintSHA256, "dtls fingerprint") }
  ];
}

function descriptionFromMap(map: CborMap): RtcOffer {
  return {
    version: readRtcSignalingVersion(map),
    rtcSessionId: tokenFromMap(map, "rtc_session_id", 16),
    generation: readGeneration(map),
    description: readBoundedUtf8(map, "description", maxRtcDescriptionBytes),
    descriptionSHA256: digestFromMap(map, "description_sha256"),
    dtlsFingerprintSHA256: digestFromMap(map, "dtls_fingerprint_sha256")
  };
}

async function validateRtcDescription(value: RtcOffer, label: string): Promise<void> {
  if (value.version !== rtcSignalingVersion || !validToken(value.rtcSessionId, 16) || !validGeneration(value.generation) || !validBoundedUtf8(value.description, maxRtcDescriptionBytes) || !validDigest(value.descriptionSHA256) || !validDigest(value.dtlsFingerprintSHA256)) {
    throw new Error(`invalid rtc ${label}`);
  }
  if (await rtcDescriptionSHA256(value.description) !== value.descriptionSHA256) {
    throw new Error(`rtc ${label} description hash mismatch`);
  }
}

function readRtcSignalingVersion(map: CborMap): typeof rtcSignalingVersion {
  if (readText(getRequiredEntry(map, "version"), "version") !== rtcSignalingVersion) {
    throw new Error("unsupported rtc signaling version");
  }
  return rtcSignalingVersion;
}

function readGeneration(map: CborMap): number {
  const value = readUint(getRequiredEntry(map, "generation"), "generation");
  if (!validGeneration(value)) throw new Error("invalid rtc generation");
  return value;
}

function readDirection(map: CborMap): RtcCandidateDirection {
  const value = readText(getRequiredEntry(map, "direction"), "direction");
  if (value !== "offerer" && value !== "answerer") throw new Error("invalid rtc candidate direction");
  return value;
}

function readCancelReason(map: CborMap): RtcCancelReason {
  const value = readText(getRequiredEntry(map, "reason"), "reason");
  if (value !== "cancelled" && value !== "rejected" && value !== "glare") throw new Error("invalid rtc cancel reason");
  return value;
}

function tokenFromMap(map: CborMap, key: string, size: number): string {
  return encodeBase64URL(readBytes(getRequiredEntry(map, key), key, size));
}

function digestFromMap(map: CborMap, key: string): string {
  return encodeBase64URL(readBytes(getRequiredEntry(map, key), key, 32));
}

function readBoundedUtf8(map: CborMap, key: string, maximumBytes: number): string {
  const value = readText(getRequiredEntry(map, key), key);
  if (!validBoundedUtf8(value, maximumBytes)) throw new Error(`invalid ${key}`);
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

function decodeDigest(value: string, label: string): Uint8Array {
  return decodeToken(value, 32, label);
}

function validToken(value: string, size: number): boolean {
  try { return decodeBase64URL(value).byteLength === size; } catch { return false; }
}

function validDigest(value: string): boolean {
  return validToken(value, 32);
}

function validGeneration(value: number): boolean {
  return boundedInteger(value, 0, 65_535);
}

function boundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validBoundedUtf8(value: string, maximumBytes: number): boolean {
  if (value.length === 0 || hasUnpairedSurrogate(value)) return false;
  return new TextEncoder().encode(value).byteLength <= maximumBytes;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
