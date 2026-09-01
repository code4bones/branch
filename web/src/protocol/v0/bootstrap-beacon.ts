import {
  cborMap,
  decodeDeterministicCbor,
  encodeDeterministicCbor,
  getRequiredEntry,
  hasEntry,
  maxCborBytes,
  readBytes,
  readCborMap,
  readText,
  readTextArray,
  readUint,
  rejectUnknownEntries,
  sameBytes,
  isCborMap,
  isCborArray,
  type CborEntry,
  type CborMap,
  type CborValue
} from "./cbor.js";
import { decodeBase64URL, encodeBase64URL } from "./base64url.js";
import { maxDraftEnvelopeBytes, maxDraftTimestamp, protocolID } from "./envelope.js";
import { branchTextWrapperPrefix, isBranchTextWrapper } from "./text-carrier.js";

const signatureDomain = "BRANCH signed event v0\n";
const encoder = new TextEncoder();
const signatureDomainBytes = encoder.encode(signatureDomain);
const requiredSearchMarkers = ["BRANCH0", protocolID, "branch-bootstrap-v0"] as const;
const defaultMaxFutureSkewSeconds = 300;
const defaultLifetimeSeconds = 7 * 24 * 60 * 60;

export type BootstrapBeaconValidationReason =
  | "accepted"
  | "malformed_wrapper"
  | "envelope_oversized"
  | "invalid_base64url"
  | "invalid_cbor"
  | "non_canonical_cbor"
  | "unknown_field"
  | "unsupported_protocol"
  | "unsupported_event_type"
  | "recipient_tag_present"
  | "invalid_payload_mode"
  | "invalid_sender"
  | "invalid_signature_alg"
  | "signature_invalid"
  | "expired"
  | "created_in_future"
  | "payload_oversized"
  | "payload_invalid"
  | "payload_expiry_mismatch"
  | "payload_issued_after_created";

export interface SignedBootstrapBeacon {
  readonly wrapper: string;
  readonly signedEventBytes: Uint8Array;
  readonly signatureInputBytes: Uint8Array;
  readonly envelope: BootstrapBeaconEnvelope;
  readonly payload: BootstrapBeaconPayload;
}

export interface BootstrapBeaconEnvelope {
  readonly protocol: typeof protocolID;
  readonly eventId: Uint8Array;
  readonly type: "bootstrap.beacon";
  readonly sender: BootstrapBeaconSender;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly payloadMode: "public";
  readonly payloadBytes: Uint8Array;
  readonly signatureAlg: "ed25519";
  readonly signature: Uint8Array;
}

export interface BootstrapBeaconSender {
  readonly keyAlg: "ed25519";
  readonly publicKey: Uint8Array;
}

export interface BootstrapBeaconPayload {
  readonly beaconId: Uint8Array;
  readonly subject: string;
  readonly issuer: string;
  readonly sequence: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly previousBeaconId: Uint8Array | null;
  readonly protocolVersions: readonly string[];
  readonly capabilities: readonly string[];
  readonly searchMarkers: readonly string[];
}

export interface BootstrapBeaconValidationOptions {
  readonly now?: number;
  readonly maxFutureSkewSeconds?: number;
}

export interface BootstrapBeaconValidationResult {
  readonly accepted: boolean;
  readonly reason: BootstrapBeaconValidationReason;
  readonly beacon?: SignedBootstrapBeacon;
}

export interface CreateBootstrapBeaconOptions {
  readonly now?: number;
  readonly expiresAt?: number;
  readonly sequence?: number;
  readonly subject?: string;
  readonly capabilities?: readonly string[];
  readonly searchMarkers?: readonly string[];
}

export async function validateBranchTextBootstrapBeacon(
  wrapper: string,
  options: BootstrapBeaconValidationOptions = {}
): Promise<BootstrapBeaconValidationResult> {
  const normalizedNow = options.now ?? Math.floor(Date.now() / 1000);
  const maxFutureSkewSeconds = options.maxFutureSkewSeconds ?? defaultMaxFutureSkewSeconds;

  try {
    if (!isBranchTextWrapper(wrapper)) {
      return reject("malformed_wrapper");
    }
    const encoded = wrapper.slice(branchTextWrapperPrefix.length);
    const signedEventBytes = decodeBase64URL(encoded);
    if (signedEventBytes.byteLength > maxDraftEnvelopeBytes) {
      return reject("envelope_oversized");
    }

    const envelopeMap = readCborMap(decodeCborForValidation(signedEventBytes), "signed_event");
    const envelope = readBootstrapEnvelope(envelopeMap);
    const canonicalSignedEventBytes = encodeDeterministicCbor(cborMap(signedEnvelopeEntries(envelope)));
    if (!sameBytes(canonicalSignedEventBytes, signedEventBytes)) {
      return reject("non_canonical_cbor");
    }

    const unsignedBytes = encodeDeterministicCbor(cborMap(unsignedEnvelopeEntries(envelope)));
    const signatureInputBytes = concatBytes([signatureDomainBytes, unsignedBytes]);
    if (!await verifyEd25519(envelope.sender.publicKey, envelope.signature, signatureInputBytes)) {
      return reject("signature_invalid");
    }

    if (envelope.expiresAt <= normalizedNow) {
      return reject("expired");
    }
    if (envelope.createdAt > normalizedNow + maxFutureSkewSeconds) {
      return reject("created_in_future");
    }

    const payload = readBootstrapPayload(envelope.payloadBytes);
    if (payload.expiresAt !== envelope.expiresAt) {
      return reject("payload_expiry_mismatch");
    }
    if (payload.issuedAt > envelope.createdAt) {
      return reject("payload_issued_after_created");
    }

    return {
      accepted: true,
      reason: "accepted",
      beacon: {
        wrapper,
        signedEventBytes,
        signatureInputBytes,
        envelope,
        payload
      }
    };
  } catch (error) {
    return reject(reasonFromError(error));
  }
}

export async function assertValidBranchTextBootstrapBeacon(
  wrapper: string,
  options: BootstrapBeaconValidationOptions = {}
): Promise<SignedBootstrapBeacon> {
  const result = await validateBranchTextBootstrapBeacon(wrapper, options);
  if (!result.accepted || result.beacon === undefined) {
    throw new Error(`BRANCH0 bootstrap.beacon rejected: ${result.reason}`);
  }
  return result.beacon;
}

export async function createBetaBootstrapBeaconWrapper(options: CreateBootstrapBeaconOptions = {}): Promise<string> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const expiresAt = options.expiresAt ?? now + defaultLifetimeSeconds;
  const keyPair = await generateEd25519KeyPair();
  const publicKeyBytes = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", keyPair.publicKey));
  const subject = options.subject ?? `ed25519:${encodeBase64URL(publicKeyBytes)}`;
  const capabilities = options.capabilities ?? ["search.direct-browser/0"];
  const searchMarkers = options.searchMarkers ?? requiredSearchMarkers;
  const payloadBytes = encodeBootstrapPayload({
    beaconId: randomBytes(32),
    subject,
    issuer: subject,
    sequence: options.sequence ?? 1,
    issuedAt: now,
    expiresAt,
    previousBeaconId: null,
    protocolVersions: [protocolID],
    capabilities,
    searchMarkers
  });
  const unsignedEnvelope = {
    protocol: protocolID,
    eventId: randomBytes(32),
    type: "bootstrap.beacon",
    sender: {
      keyAlg: "ed25519",
      publicKey: publicKeyBytes
    },
    createdAt: now,
    expiresAt,
    payloadMode: "public",
    payloadBytes,
    signatureAlg: "ed25519"
  } satisfies Omit<BootstrapBeaconEnvelope, "signature">;
  const unsignedBytes = encodeDeterministicCbor(cborMap(unsignedEnvelopeEntries(unsignedEnvelope)));
  const signatureInputBytes = concatBytes([signatureDomainBytes, unsignedBytes]);
  const signature = new Uint8Array(await globalThis.crypto.subtle.sign("Ed25519", keyPair.privateKey, toArrayBuffer(signatureInputBytes)));
  const signedEnvelope = { ...unsignedEnvelope, signature } satisfies BootstrapBeaconEnvelope;
  return `${branchTextWrapperPrefix}${encodeBase64URL(encodeDeterministicCbor(cborMap(signedEnvelopeEntries(signedEnvelope))))}`;
}

export function encodeBootstrapPayload(payload: BootstrapBeaconPayload): Uint8Array {
  const entries: CborEntry[] = [
    { key: "beacon_id", value: payload.beaconId },
    { key: "subject", value: payload.subject },
    { key: "issuer", value: payload.issuer },
    { key: "sequence", value: payload.sequence },
    { key: "issued_at", value: payload.issuedAt },
    { key: "expires_at", value: payload.expiresAt },
    { key: "protocol_versions", value: payload.protocolVersions },
    { key: "search_markers", value: payload.searchMarkers }
  ];
  if (payload.previousBeaconId !== null) {
    entries.push({ key: "previous_beacon_id", value: payload.previousBeaconId });
  }
  if (payload.capabilities.length > 0) {
    entries.push({ key: "capabilities", value: payload.capabilities });
  }
  return encodeDeterministicCbor(cborMap(entries));
}

function readBootstrapEnvelope(map: CborMap): BootstrapBeaconEnvelope {
  rejectEnvelopeUnknownEntries(map);
  if (hasEntry(map, "recipient_tag")) {
    throw new Error("recipient_tag_present");
  }
  const protocol = readText(getRequiredEntry(map, "protocol"), "protocol");
  if (protocol !== protocolID) {
    throw new Error("unsupported_protocol");
  }
  const type = readText(getRequiredEntry(map, "type"), "type");
  if (type !== "bootstrap.beacon") {
    throw new Error("unsupported_event_type");
  }
  const payloadMode = readText(getRequiredEntry(map, "payload_mode"), "payload_mode");
  if (payloadMode !== "public") {
    throw new Error("invalid_payload_mode");
  }
  const signatureAlg = readText(getRequiredEntry(map, "signature_alg"), "signature_alg");
  if (signatureAlg !== "ed25519") {
    throw new Error("invalid_signature_alg");
  }
  const sender = readSender(readCborMap(getRequiredEntry(map, "sender"), "sender"));
  const createdAt = readTimestamp(getRequiredEntry(map, "created_at"), "created_at");
  const expiresAt = readTimestamp(getRequiredEntry(map, "expires_at"), "expires_at");
  if (expiresAt <= createdAt) {
    throw new Error("expired");
  }
  return {
    protocol,
    eventId: readBytes(getRequiredEntry(map, "event_id"), "event_id", 32),
    type,
    sender,
    createdAt,
    expiresAt,
    payloadMode,
    payloadBytes: readBytes(getRequiredEntry(map, "payload"), "payload"),
    signatureAlg,
    signature: readBytes(getRequiredEntry(map, "signature"), "signature", 64)
  };
}

function readSender(map: CborMap): BootstrapBeaconSender {
  rejectUnknownEntries(map, ["key_alg", "public_key"]);
  const keyAlg = readText(getRequiredEntry(map, "key_alg"), "key_alg");
  if (keyAlg !== "ed25519") {
    throw new Error("invalid_sender");
  }
  return {
    keyAlg,
    publicKey: readBytes(getRequiredEntry(map, "public_key"), "public_key", 32)
  };
}

function readBootstrapPayload(bytes: Uint8Array): BootstrapBeaconPayload {
  if (bytes.byteLength > maxCborBytes) {
    throw new Error("payload_oversized");
  }
  const payloadMap = readCborMap(decodeCborForValidation(bytes), "bootstrap_payload");
  rejectUnknownEntries(payloadMap, [
    "beacon_id",
    "subject",
    "issuer",
    "sequence",
    "issued_at",
    "expires_at",
    "previous_beacon_id",
    "revokes",
    "protocol_versions",
    "capabilities",
    "rendezvous_boards",
    "relay_announcements",
    "mirror_hints",
    "search_markers",
    "proofs"
  ]);
  const protocolVersions = readTextArray(getRequiredEntry(payloadMap, "protocol_versions"), "protocol_versions", 8);
  const searchMarkers = readTextArray(getRequiredEntry(payloadMap, "search_markers"), "search_markers", 16);
  if (!protocolVersions.includes(protocolID) || !requiredSearchMarkers.every((marker) => searchMarkers.includes(marker))) {
    throw new Error("payload_invalid");
  }
  validateOptionalPublicValues(payloadMap);
  return {
    beaconId: readBytes(getRequiredEntry(payloadMap, "beacon_id"), "beacon_id", 32),
    subject: readText(getRequiredEntry(payloadMap, "subject"), "subject"),
    issuer: readText(getRequiredEntry(payloadMap, "issuer"), "issuer"),
    sequence: readUint(getRequiredEntry(payloadMap, "sequence"), "sequence"),
    issuedAt: readTimestamp(getRequiredEntry(payloadMap, "issued_at"), "issued_at"),
    expiresAt: readTimestamp(getRequiredEntry(payloadMap, "expires_at"), "expires_at"),
    previousBeaconId: hasEntry(payloadMap, "previous_beacon_id")
      ? readBytes(getRequiredEntry(payloadMap, "previous_beacon_id"), "previous_beacon_id", 32)
      : null,
    protocolVersions,
    capabilities: hasEntry(payloadMap, "capabilities")
      ? readTextArray(getRequiredEntry(payloadMap, "capabilities"), "capabilities", 32)
      : [],
    searchMarkers
  };
}

function rejectEnvelopeUnknownEntries(map: CborMap): void {
  rejectUnknownEntries(map, [
    "protocol",
    "event_id",
    "type",
    "sender",
    "recipient_tag",
    "created_at",
    "expires_at",
    "payload_mode",
    "payload",
    "signature_alg",
    "signature"
  ]);
}

function readTimestamp(value: CborValue, key: string): number {
  const timestamp = readUint(value, key);
  if (timestamp > maxDraftTimestamp) {
    throw new Error(`invalid_${key}`);
  }
  return timestamp;
}

function signedEnvelopeEntries(envelope: BootstrapBeaconEnvelope): readonly CborEntry[] {
  return [...unsignedEnvelopeEntries(envelope), { key: "signature", value: envelope.signature }];
}

function unsignedEnvelopeEntries(envelope: Omit<BootstrapBeaconEnvelope, "signature">): readonly CborEntry[] {
  return [
    { key: "protocol", value: envelope.protocol },
    { key: "event_id", value: envelope.eventId },
    { key: "type", value: envelope.type },
    { key: "sender", value: cborMap([
      { key: "key_alg", value: envelope.sender.keyAlg },
      { key: "public_key", value: envelope.sender.publicKey }
    ]) },
    { key: "created_at", value: envelope.createdAt },
    { key: "expires_at", value: envelope.expiresAt },
    { key: "payload_mode", value: envelope.payloadMode },
    { key: "payload", value: envelope.payloadBytes },
    { key: "signature_alg", value: envelope.signatureAlg }
  ];
}

function validateOptionalPublicValues(map: CborMap): void {
  for (const key of ["revokes", "rendezvous_boards", "relay_announcements", "mirror_hints", "proofs"]) {
    if (hasEntry(map, key)) {
      validateBoundedPublicValue(getRequiredEntry(map, key), 0);
    }
  }
}

function validateBoundedPublicValue(value: CborValue, depth: number): void {
  if (depth > 3) {
    throw new Error("payload_invalid");
  }
  if (typeof value === "number") {
    readUint(value, "public_value");
    return;
  }
  if (typeof value === "string") {
    readText(value, "public_value");
    return;
  }
  if (value instanceof Uint8Array) {
    readBytes(value, "public_value");
    return;
  }
  if (isCborArray(value)) {
    if (value.length > 16) {
      throw new Error("payload_invalid");
    }
    for (const entry of value) {
      validateBoundedPublicValue(entry, depth + 1);
    }
    return;
  }
  if (isCborMap(value)) {
    if (value.entries.length > 16) {
      throw new Error("payload_invalid");
    }
    for (const entry of value.entries) {
      readText(entry.key, "public_key");
      validateBoundedPublicValue(entry.value, depth + 1);
    }
  }
}

function decodeCborForValidation(bytes: Uint8Array): CborValue {
  try {
    return decodeDeterministicCbor(bytes, maxDraftEnvelopeBytes);
  } catch (error) {
    if (error instanceof Error && error.message === "non_canonical_cbor") {
      throw new Error("non_canonical_cbor");
    }
    throw new Error("invalid_cbor");
  }
}

async function verifyEd25519(publicKey: Uint8Array, signature: Uint8Array, input: Uint8Array): Promise<boolean> {
  try {
    const key = await globalThis.crypto.subtle.importKey("raw", toArrayBuffer(publicKey), "Ed25519", false, ["verify"]);
    return await globalThis.crypto.subtle.verify("Ed25519", key, toArrayBuffer(signature), toArrayBuffer(input));
  } catch {
    return false;
  }
}

async function generateEd25519KeyPair(): Promise<CryptoKeyPair> {
  const generated = await globalThis.crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  if (!isCryptoKeyPair(generated)) {
    throw new Error("Ed25519 key pair generation failed");
  }
  return generated;
}

function isCryptoKeyPair(value: CryptoKey | CryptoKeyPair): value is CryptoKeyPair {
  return "privateKey" in value && "publicKey" in value;
}

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
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

function reject(reason: BootstrapBeaconValidationReason): BootstrapBeaconValidationResult {
  return { accepted: false, reason };
}

function reasonFromError(error: unknown): BootstrapBeaconValidationReason {
  const message = error instanceof Error ? error.message : "";
  if (message === "invalid base64url") {
    return "invalid_base64url";
  }
  if (isValidationReason(message)) {
    return message;
  }
  if (message.startsWith("unknown_")) {
    return "unknown_field";
  }
  if (message.startsWith("invalid_payload") || message.startsWith("missing_")) {
    return "payload_invalid";
  }
  return "invalid_cbor";
}

function isValidationReason(value: string): value is BootstrapBeaconValidationReason {
  return [
    "malformed_wrapper",
    "envelope_oversized",
    "invalid_base64url",
    "invalid_cbor",
    "non_canonical_cbor",
    "unsupported_protocol",
    "unsupported_event_type",
    "recipient_tag_present",
    "invalid_payload_mode",
    "invalid_sender",
    "invalid_signature_alg",
    "signature_invalid",
    "expired",
    "created_in_future",
    "payload_oversized",
    "payload_invalid",
    "payload_expiry_mismatch",
    "payload_issued_after_created"
  ].includes(value);
}
