import { decodeBase64URL } from "./base64url.js";
import { maxDraftEnvelopeBytes, maxDraftStringBytes, maxDraftTimestamp, protocolID } from "./envelope.js";
import { developmentProfileMultihash } from "./profile.js";

export const relayAttachmentSchema = "branch.relay-attachment/0.draft" as const;
export const relayProofDomain = "BRANCH relay attachment v0\n" as const;
export const maxDraftRelayAttachmentFrameBytes = maxDraftEnvelopeBytes;
const maxDraftRouteHints = 8;
const maxDraftRouteHintUriBytes = 512;
const draftRelayAttachmentPath = "/relay/v0";

const relayFrameTypes = [
  "HELLO",
  "CHALLENGE",
  "AUTH",
  "READY",
  "PRESENCE",
  "HEARTBEAT",
  "LOOKUP",
  "RENDEZVOUS",
  "ENVELOPE",
  "ACK",
  "ERROR"
] as const;

const protocolErrorCodes = [
  "unsupported_version",
  "unsupported_profile",
  "profile_hash_mismatch",
  "required_capability_missing",
  "required_extension_missing",
  "malformed_envelope",
  "signature_invalid",
  "payload_decrypt_failed",
  "frame_too_large",
  "frame_malformed",
  "frame_replayed",
  "authentication_failed",
  "capability_required",
  "capability_expired",
  "capability_revoked",
  "quota_exceeded",
  "peer_unavailable",
  "route_unavailable",
  "migration_rejected",
  "rate_limited",
  "timeout",
  "internal_unavailable"
] as const;

export type RelayFrameType = (typeof relayFrameTypes)[number];

export class RelayAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayAttachmentError";
  }
}

export interface DraftRelayAttachmentFrame {
  readonly type: RelayFrameType;
}

export function isRelayFrameType(value: string): value is RelayFrameType {
  return relayFrameTypes.some((frameType) => frameType === value);
}

export function decodeDraftRelayAttachmentFrameText(text: string): DraftRelayAttachmentFrame {
  if (new TextEncoder().encode(text).byteLength > maxDraftRelayAttachmentFrameBytes) {
    throw new RelayAttachmentError("oversized draft relay attachment frame");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new RelayAttachmentError("invalid draft relay attachment frame");
  }
  return validateDraftRelayAttachmentFrame(decoded);
}

export function validateDraftRelayAttachmentFrame(value: unknown): DraftRelayAttachmentFrame {
  if (!isRecord(value)) {
    throw new RelayAttachmentError("invalid draft relay attachment frame");
  }
  const type = readRelayFrameType(value, "type");
  switch (type) {
    case "HELLO":
      validateHello(value);
      break;
    case "CHALLENGE":
      validateChallenge(value);
      break;
    case "AUTH":
      validateAuth(value);
      break;
    case "READY":
      validateReady(value);
      break;
    case "PRESENCE":
      validatePresence(value);
      break;
    case "HEARTBEAT":
      validateHeartbeat(value);
      break;
    case "LOOKUP":
      validateLookup(value);
      break;
    case "RENDEZVOUS":
      validateRendezvous(value);
      break;
    case "ENVELOPE":
      validateEnvelope(value);
      break;
    case "ACK":
      validateAck(value);
      break;
    case "ERROR":
      validateError(value);
      break;
  }
  return { type };
}

function validateHello(record: Record<string, unknown>): void {
  rejectUnknownKeys(record, ["type", "client_nonce", "client_time", "requested_role", "max_frame_bytes", "offers"]);
  readBase64URLBytes(record, "client_nonce", 32);
  readInteger(record, "client_time");
  readLiteral(record, "requested_role", "relay.forward.live/0");
  readBoundedInteger(record, "max_frame_bytes", 1, 49152);
  readVersionOffers(record, "offers");
}

function validateChallenge(record: Record<string, unknown>): void {
  rejectUnknownKeys(record, ["type", "client_nonce", "relay_nonce", "issued_at", "expires_at", "relay_public_key", "selected", "transcript_hash", "relay_proof"]);
  readBase64URLBytes(record, "client_nonce", 32);
  readBase64URLBytes(record, "relay_nonce", 32);
  const issuedAt = readInteger(record, "issued_at");
  const expiresAt = readInteger(record, "expires_at");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 60) {
    throw new RelayAttachmentError("frame_replayed");
  }
  readBase64URLBytes(record, "relay_public_key", 32);
  readVersionOffer(readObject(record, "selected"));
  readBase64URLBytes(record, "transcript_hash", 32);
  readBase64URLBytes(record, "relay_proof", 64);
}

function validateAuth(record: Record<string, unknown>): void {
  rejectUnknownKeys(record, ["type", "client_public_key", "client_nonce", "relay_nonce", "transcript_hash", "client_proof"]);
  readBase64URLBytes(record, "client_public_key", 32);
  readBase64URLBytes(record, "client_nonce", 32);
  readBase64URLBytes(record, "relay_nonce", 32);
  readBase64URLBytes(record, "transcript_hash", 32);
  readBase64URLBytes(record, "client_proof", 64);
}

function validateReady(record: Record<string, unknown>): void {
  rejectUnknownKeys(record, ["type", "session_id", "route_id", "presence_ttl_seconds", "heartbeat_interval_seconds", "accepted_limits"]);
  readBase64URLBytes(record, "session_id", 32);
  readBase64URLBytes(record, "route_id", 16);
  readBoundedInteger(record, "presence_ttl_seconds", 1, 300);
  readBoundedInteger(record, "heartbeat_interval_seconds", 1, 60);
  const limits = readObject(record, "accepted_limits");
  rejectUnknownKeys(limits, ["max_frame_bytes", "max_queue_depth", "max_frames_per_session", "max_bytes_per_session"]);
  readBoundedInteger(limits, "max_frame_bytes", 1, 49152);
  readBoundedInteger(limits, "max_queue_depth", 1, 1024);
  readBoundedInteger(limits, "max_frames_per_session", 1, maxDraftTimestamp);
  readBoundedInteger(limits, "max_bytes_per_session", 1, maxDraftTimestamp);
}

function validatePresence(record: Record<string, unknown>): void {
  rejectUnknownKeys(record, ["type", "session_id", "route_id", "peer_id", "sequence", "ttl_seconds", "sent_at"]);
  readBase64URLBytes(record, "session_id", 32);
  readBase64URLBytes(record, "route_id", 16);
  readBase64URLBytes(record, "peer_id", 32);
  readBoundedInteger(record, "sequence", 0, maxDraftTimestamp);
  readBoundedInteger(record, "ttl_seconds", 1, 300);
  readInteger(record, "sent_at");
}

function validateHeartbeat(record: Record<string, unknown>): void {
  rejectUnknownKeys(record, ["type", "session_id", "sequence", "sent_at"]);
  readBase64URLBytes(record, "session_id", 32);
  readBoundedInteger(record, "sequence", 0, maxDraftTimestamp);
  readInteger(record, "sent_at");
}

function validateLookup(record: Record<string, unknown>): void {
  rejectUnknownKeys(record, ["type", "session_id", "peer_id", "sequence"]);
  readBase64URLBytes(record, "session_id", 32);
  readBase64URLBytes(record, "peer_id", 32);
  readBoundedInteger(record, "sequence", 0, maxDraftTimestamp);
}

function validateRendezvous(record: Record<string, unknown>): void {
  rejectUnknownKeys(record, ["type", "session_id", "route_id", "peer_id", "sequence"], ["route_hints"]);
  readBase64URLBytes(record, "session_id", 32);
  readBase64URLBytes(record, "route_id", 16);
  readBase64URLBytes(record, "peer_id", 32);
  readBoundedInteger(record, "sequence", 0, maxDraftTimestamp);
  validateRouteHints(record);
}

function validateEnvelope(record: Record<string, unknown>): void {
  rejectUnknownKeys(record, ["type", "session_id", "route_id", "path_epoch", "stream_id", "delivery_id", "ciphertext", "ack_requested"], ["sender_peer_id"]);
  readBase64URLBytes(record, "session_id", 32);
  readBase64URLBytes(record, "route_id", 16);
  readBoundedInteger(record, "path_epoch", 0, maxDraftTimestamp);
  readBoundedInteger(record, "stream_id", 0, maxDraftTimestamp);
  readBase64URLBytes(record, "delivery_id", 16);
  readBase64URLString(record, "ciphertext");
  if (record.sender_peer_id !== undefined) {
    readBase64URLBytes(record, "sender_peer_id", 32);
  }
  readBoolean(record, "ack_requested");
}

function validateAck(record: Record<string, unknown>): void {
  rejectUnknownKeys(record, ["type", "session_id", "delivery_id", "ack_type", "durable"]);
  readBase64URLBytes(record, "session_id", 32);
  readBase64URLBytes(record, "delivery_id", 16);
  const ackType = readString(record, "ack_type");
  if (ackType !== "relay.accepted" && ackType !== "relay.forwarded" && ackType !== "peer.received") {
    throw new RelayAttachmentError("invalid ack_type");
  }
  if (readBoolean(record, "durable")) {
    throw new RelayAttachmentError("durable ack forbidden");
  }
}

function validateError(record: Record<string, unknown>): void {
  rejectUnknownKeys(record, ["type", "code", "retryable", "detail"]);
  const code = readString(record, "code");
  if (!protocolErrorCodes.some((knownCode) => knownCode === code)) {
    throw new RelayAttachmentError("unknown error code");
  }
  readBoolean(record, "retryable");
  if (record.detail !== undefined && readString(record, "detail").length > 256) {
    throw new RelayAttachmentError("detail too large");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(record: Record<string, unknown>, keys: readonly string[], optionalKeys: readonly string[] = []): void {
  const known = new Set([...keys, ...optionalKeys]);
  for (const key of keys) {
    if (!(key in record)) {
      throw new RelayAttachmentError(`missing ${key}`);
    }
  }
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new RelayAttachmentError(`unknown ${key}`);
    }
  }
}

function validateRouteHints(record: Record<string, unknown>): void {
  if (record.route_hints === undefined) {
    return;
  }
  const hints = record.route_hints;
  if (!Array.isArray(hints) || hints.length === 0 || hints.length > maxDraftRouteHints) {
    throw new RelayAttachmentError("invalid route_hints");
  }
  const seen = new Set<string>();
  for (const hint of hints) {
    if (!isRecord(hint)) {
      throw new RelayAttachmentError("invalid route_hints");
    }
    rejectUnknownKeys(hint, ["transport", "uri", "relay_public_key", "priority"]);
    const transport = readString(hint, "transport");
    if (transport !== "wss" && transport !== "ws") {
      throw new RelayAttachmentError("invalid route_hints");
    }
    const uri = readString(hint, "uri");
    validateRouteHintUri(transport, uri);
    const key = `${transport}\0${uri}`;
    if (seen.has(key)) {
      throw new RelayAttachmentError("duplicate route_hints");
    }
    seen.add(key);
    readBase64URLBytes(hint, "relay_public_key", 32);
    readBoundedInteger(hint, "priority", 0, maxDraftTimestamp);
  }
}

function validateRouteHintUri(transport: "ws" | "wss", value: string): void {
  if (new TextEncoder().encode(value).byteLength > maxDraftRouteHintUriBytes) {
    throw new RelayAttachmentError("invalid route_hints");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RelayAttachmentError("invalid route_hints");
  }
  if (
    parsed.protocol !== `${transport}:` ||
    parsed.host === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== draftRelayAttachmentPath
  ) {
    throw new RelayAttachmentError("invalid route_hints");
  }
}

function readRelayFrameType(record: Record<string, unknown>, key: string): RelayFrameType {
  const value = readString(record, key);
  if (!isRelayFrameType(value)) {
    throw new RelayAttachmentError("unsupported frame type");
  }
  return value;
}

function readObject(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new RelayAttachmentError(`missing ${key}`);
  }
  return value;
}

function readVersionOffers(record: Record<string, unknown>, key: string): void {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new RelayAttachmentError(`invalid ${key}`);
  }
  for (const offer of value) {
    readVersionOffer(offer);
  }
}

function readVersionOffer(value: unknown): void {
  if (!isRecord(value)) {
    throw new RelayAttachmentError("invalid version offer");
  }
  rejectUnknownKeys(value, ["wire_version", "protocol", "profile_multihash", "capabilities", "required_capabilities", "extensions", "required_extensions"]);
  if (readBoundedInteger(value, "wire_version", 0, maxDraftTimestamp) !== 0) {
    throw new RelayAttachmentError("unsupported_version");
  }
  if (readString(value, "protocol") !== protocolID) {
    throw new RelayAttachmentError("unsupported_protocol");
  }
  if (readString(value, "profile_multihash") !== developmentProfileMultihash) {
    throw new RelayAttachmentError("profile_hash_mismatch");
  }
  const capabilities = readOrderedUniqueStrings(value, "capabilities", 32);
  if (!capabilities.includes("relay.forward.live/0")) {
    throw new RelayAttachmentError("capability_required");
  }
  readOrderedUniqueStrings(value, "required_capabilities", 32);
  readOrderedUniqueStrings(value, "extensions", 32);
  readOrderedUniqueStrings(value, "required_extensions", 32);
}

function readOrderedUniqueStrings(record: Record<string, unknown>, key: string, maxItems: number): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new RelayAttachmentError(`invalid ${key}`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  let previous = "";
  for (const item of value) {
    if (typeof item !== "string" || item === "" || new TextEncoder().encode(item).byteLength > maxDraftStringBytes) {
      throw new RelayAttachmentError(`invalid ${key}`);
    }
    if (seen.has(item) || item < previous) {
      throw new RelayAttachmentError(`invalid ${key}`);
    }
    seen.add(item);
    result.push(item);
    previous = item;
  }
  return result;
}

function readLiteral<T extends string>(record: Record<string, unknown>, key: string, expected: T): T {
  const value = readString(record, key);
  if (value !== expected) {
    throw new RelayAttachmentError(`unsupported ${key}`);
  }
  return expected;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxDraftStringBytes
  ) {
    throw new RelayAttachmentError(`invalid ${key}`);
  }
  return value;
}

function readInteger(record: Record<string, unknown>, key: string): number {
  return readBoundedInteger(record, key, 0, maxDraftTimestamp);
}

function readBoundedInteger(record: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new RelayAttachmentError(`invalid ${key}`);
  }
  return value;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new RelayAttachmentError(`invalid ${key}`);
  }
  return value;
}

function readBase64URLString(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  try {
    decodeBase64URL(value);
  } catch {
    throw new RelayAttachmentError(`invalid ${key}`);
  }
  return value;
}

function readBase64URLBytes(record: Record<string, unknown>, key: string, size: number): string {
  const value = readBase64URLString(record, key);
  if (decodeBase64URL(value).byteLength !== size) {
    throw new RelayAttachmentError(`invalid ${key}`);
  }
  return value;
}
