import {
  cborMap,
  decodeDeterministicCbor,
  encodeDeterministicCbor,
  getRequiredEntry,
  hasEntry,
  isCborArray,
  readBytes,
  readCborMap,
  readText,
  readTextArray,
  readUint,
  rejectUnknownEntries,
  sameBytes,
  maxCborBytes,
  type CborEntry,
  type CborMap,
  type CborValue
} from "./cbor.js";
import { decodeBase64URL, encodeBase64URL } from "./base64url.js";
import { maxDraftEnvelopeBytes, maxDraftTimestamp, protocolID } from "./envelope.js";
import { developmentProfileMultihash } from "./profile.js";
import { branchTextWrapperPrefix, isBranchTextWrapper } from "./text-carrier.js";

const signatureDomain = "BRANCH signed event v0\n";
const branchIDDomain = "BRANCH identity id v0\n";
const encoder = new TextEncoder();
const signatureDomainBytes = encoder.encode(signatureDomain);
const branchIDDomainBytes = encoder.encode(branchIDDomain);
const defaultMaxFutureSkewSeconds = 300;
const defaultLifetimeSeconds = 7 * 24 * 60 * 60;
const maxContactIDBytes = 32;
const maxIdentityAliasBytes = 64;
const maxIdentityAliases = 8;
const maxIdentityDisplayNameBytes = 96;
const maxIdentityRouteHints = 8;
const maxIdentityRouteTransportBytes = 32;
const maxIdentityRouteUriBytes = 512;
const branchIDPrefix = "br1.";

export const identityContactEventType = "identity.announce" as const;
export const defaultIdentityContactProtocolVersions = [protocolID] as const;
export const defaultIdentityContactProfileMultihashes = [developmentProfileMultihash] as const;

export type IdentityContactValidationReason =
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
  | "payload_issued_after_created"
  | "invalid_branch_id"
  | "branch_id_mismatch"
  | "lower_sequence";

export interface BranchIDParts {
  readonly value: string;
  readonly multihash: Uint8Array;
}

export interface SignedIdentityContact {
  readonly wrapper: string;
  readonly signedEventBytes: Uint8Array;
  readonly signatureInputBytes: Uint8Array;
  readonly envelope: IdentityContactEnvelope;
  readonly payload: IdentityContactPayload;
}

export interface IdentityContactEnvelope {
  readonly protocol: typeof protocolID;
  readonly eventId: Uint8Array;
  readonly type: typeof identityContactEventType;
  readonly sender: IdentityContactSender;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly payloadMode: "public";
  readonly payloadBytes: Uint8Array;
  readonly signatureAlg: "ed25519";
  readonly signature: Uint8Array;
}

export interface IdentityContactSender {
  readonly keyAlg: "ed25519";
  readonly publicKey: Uint8Array;
}

export interface IdentityContactPayload {
  readonly contactId: Uint8Array;
  readonly branchId: string;
  readonly sequence: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly displayName: string | null;
  readonly aliases: readonly string[];
  readonly protocolVersions: readonly string[];
  readonly profileMultihashes: readonly string[];
  readonly routeHints: readonly IdentityContactRouteHint[];
}

export interface IdentityContactRouteHint {
  readonly transport: string;
  readonly uri: string;
  readonly relayPublicKey: string;
  readonly profileMultihash: string;
  readonly priority: number;
}

export interface IdentityContactValidationOptions {
  readonly now?: number;
  readonly maxFutureSkewSeconds?: number;
  readonly supportedProfileMultihashes?: readonly string[];
  readonly minimumSequence?: number;
}

export interface IdentityContactValidationResult {
  readonly accepted: boolean;
  readonly reason: IdentityContactValidationReason;
  readonly contact?: SignedIdentityContact;
}

export interface CreateIdentityContactOptions {
  readonly now?: number;
  readonly expiresAt?: number;
  readonly sequence?: number;
  readonly contactId?: Uint8Array;
  readonly eventId?: Uint8Array;
  readonly keyPair?: CryptoKeyPair;
  readonly displayName?: string | null;
  readonly aliases?: readonly string[];
  readonly protocolVersions?: readonly string[];
  readonly profileMultihashes?: readonly string[];
  readonly routeHints?: readonly IdentityContactRouteHint[];
}

export async function branchIDFromPublicKey(publicKey: Uint8Array): Promise<string> {
  if (publicKey.byteLength !== 32) {
    throw new Error("invalid_branch_id");
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", toArrayBuffer(concatBytes([branchIDDomainBytes, publicKey]))));
  const multihash = new Uint8Array(2 + digest.byteLength);
  multihash[0] = 0x12;
  multihash[1] = 0x20;
  multihash.set(digest, 2);
  return `${branchIDPrefix}${encodeBase64URL(multihash)}`;
}

export function parseBranchID(value: string): BranchIDParts {
  if (!value.startsWith(branchIDPrefix)) {
    throw new Error("invalid_branch_id");
  }
  const multihash = decodeBase64URL(value.slice(branchIDPrefix.length));
  if (multihash.byteLength !== 34 || multihash[0] !== 0x12 || multihash[1] !== 0x20) {
    throw new Error("invalid_branch_id");
  }
  return { value, multihash };
}

export async function validateBranchTextIdentityContact(
  wrapper: string,
  options: IdentityContactValidationOptions = {}
): Promise<IdentityContactValidationResult> {
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
    const envelope = readIdentityEnvelope(envelopeMap);
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

    const payload = readIdentityPayload(envelope.payloadBytes, options.supportedProfileMultihashes ?? defaultIdentityContactProfileMultihashes);
    if (payload.expiresAt !== envelope.expiresAt) {
      return reject("payload_expiry_mismatch");
    }
    if (payload.issuedAt > envelope.createdAt) {
      return reject("payload_issued_after_created");
    }
    if (options.minimumSequence !== undefined && payload.sequence < options.minimumSequence) {
      return reject("lower_sequence");
    }
    const expectedBranchID = await branchIDFromPublicKey(envelope.sender.publicKey);
    if (payload.branchId !== expectedBranchID) {
      return reject("branch_id_mismatch");
    }

    return {
      accepted: true,
      reason: "accepted",
      contact: {
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

export async function assertValidBranchTextIdentityContact(
  wrapper: string,
  options: IdentityContactValidationOptions = {}
): Promise<SignedIdentityContact> {
  const result = await validateBranchTextIdentityContact(wrapper, options);
  if (!result.accepted || result.contact === undefined) {
    throw new Error(`BRANCH0 identity.announce rejected: ${result.reason}`);
  }
  return result.contact;
}

export async function createIdentityContactWrapper(options: CreateIdentityContactOptions = {}): Promise<string> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const expiresAt = options.expiresAt ?? now + defaultLifetimeSeconds;
  const keyPair = options.keyPair ?? await generateEd25519KeyPair();
  const publicKeyBytes = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", keyPair.publicKey));
  const protocolVersions = normalizeOrderedTextSet(options.protocolVersions ?? defaultIdentityContactProtocolVersions, "protocol_versions");
  const profileMultihashes = normalizeOrderedTextSet(options.profileMultihashes ?? defaultIdentityContactProfileMultihashes, "profile_multihashes");
  const routeHints = normalizeRouteHints(options.routeHints ?? []);
  const payloadBytes = encodeIdentityContactPayload({
    contactId: options.contactId ?? randomBytes(maxContactIDBytes),
    branchId: await branchIDFromPublicKey(publicKeyBytes),
    sequence: options.sequence ?? 1,
    issuedAt: now,
    expiresAt,
    displayName: options.displayName ?? null,
    aliases: normalizeAliases(options.aliases ?? []),
    protocolVersions,
    profileMultihashes,
    routeHints
  });
  const unsignedEnvelope = {
    protocol: protocolID,
    eventId: options.eventId ?? randomBytes(32),
    type: identityContactEventType,
    sender: {
      keyAlg: "ed25519",
      publicKey: publicKeyBytes
    },
    createdAt: now,
    expiresAt,
    payloadMode: "public",
    payloadBytes,
    signatureAlg: "ed25519"
  } satisfies Omit<IdentityContactEnvelope, "signature">;
  const unsignedBytes = encodeDeterministicCbor(cborMap(unsignedEnvelopeEntries(unsignedEnvelope)));
  const signatureInputBytes = concatBytes([signatureDomainBytes, unsignedBytes]);
  const signature = new Uint8Array(await globalThis.crypto.subtle.sign("Ed25519", keyPair.privateKey, toArrayBuffer(signatureInputBytes)));
  const signedEnvelope = { ...unsignedEnvelope, signature } satisfies IdentityContactEnvelope;
  return `${branchTextWrapperPrefix}${encodeBase64URL(encodeDeterministicCbor(cborMap(signedEnvelopeEntries(signedEnvelope))))}`;
}

export function encodeIdentityContactPayload(payload: IdentityContactPayload): Uint8Array {
  const entries: CborEntry[] = [
    { key: "contact_id", value: payload.contactId },
    { key: "branch_id", value: payload.branchId },
    { key: "sequence", value: payload.sequence },
    { key: "issued_at", value: payload.issuedAt },
    { key: "expires_at", value: payload.expiresAt },
    { key: "aliases", value: payload.aliases },
    { key: "protocol_versions", value: payload.protocolVersions },
    { key: "profile_multihashes", value: payload.profileMultihashes },
    { key: "route_hints", value: payload.routeHints.map((hint) => cborMap([
      { key: "transport", value: hint.transport },
      { key: "uri", value: hint.uri },
      { key: "relay_public_key", value: hint.relayPublicKey },
      { key: "profile_multihash", value: hint.profileMultihash },
      { key: "priority", value: hint.priority }
    ])) }
  ];
  if (payload.displayName !== null) {
    entries.push({ key: "display_name", value: payload.displayName });
  }
  return encodeDeterministicCbor(cborMap(entries));
}

function readIdentityEnvelope(map: CborMap): IdentityContactEnvelope {
  rejectEnvelopeUnknownEntries(map);
  if (hasEntry(map, "recipient_tag")) {
    throw new Error("recipient_tag_present");
  }
  const protocol = readText(getRequiredEntry(map, "protocol"), "protocol");
  if (protocol !== protocolID) {
    throw new Error("unsupported_protocol");
  }
  const type = readText(getRequiredEntry(map, "type"), "type");
  if (type !== identityContactEventType) {
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

function readSender(map: CborMap): IdentityContactSender {
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

function readIdentityPayload(bytes: Uint8Array, supportedProfileMultihashes: readonly string[]): IdentityContactPayload {
  if (bytes.byteLength > maxCborBytes) {
    throw new Error("payload_oversized");
  }
  const payloadMap = readCborMap(decodeCborForValidation(bytes), "identity_contact_payload");
  rejectUnknownEntries(payloadMap, [
    "contact_id",
    "branch_id",
    "sequence",
    "issued_at",
    "expires_at",
    "display_name",
    "aliases",
    "protocol_versions",
    "profile_multihashes",
    "route_hints"
  ]);
  const branchId = readText(getRequiredEntry(payloadMap, "branch_id"), "branch_id");
  parseBranchID(branchId);
  const protocolVersions = readOrderedUniqueTextArray(getRequiredEntry(payloadMap, "protocol_versions"), "protocol_versions", 8);
  const profileMultihashes = readOrderedUniqueTextArray(getRequiredEntry(payloadMap, "profile_multihashes"), "profile_multihashes", 8);
  if (!protocolVersions.includes(protocolID) || !hasSupportedProfile(profileMultihashes, supportedProfileMultihashes)) {
    throw new Error("payload_invalid");
  }
  return {
    contactId: readBytes(getRequiredEntry(payloadMap, "contact_id"), "contact_id", maxContactIDBytes),
    branchId,
    sequence: readUint(getRequiredEntry(payloadMap, "sequence"), "sequence"),
    issuedAt: readTimestamp(getRequiredEntry(payloadMap, "issued_at"), "issued_at"),
    expiresAt: readTimestamp(getRequiredEntry(payloadMap, "expires_at"), "expires_at"),
    displayName: hasEntry(payloadMap, "display_name") ? readDisplayName(getRequiredEntry(payloadMap, "display_name")) : null,
    aliases: readAliases(getRequiredEntry(payloadMap, "aliases")),
    protocolVersions,
    profileMultihashes,
    routeHints: readRouteHints(getRequiredEntry(payloadMap, "route_hints"))
  };
}

function readOrderedUniqueTextArray(value: CborValue, key: string, maxItems: number): readonly string[] {
  const values = readTextArray(value, key, maxItems);
  const seen = new Set<string>();
  let previous = "";
  for (const item of values) {
    if (encoder.encode(item).byteLength > maxIdentityAliasBytes) {
      throw new Error("payload_invalid");
    }
    if (seen.has(item) || item < previous) {
      throw new Error("payload_invalid");
    }
    seen.add(item);
    previous = item;
  }
  return values;
}

function readAliases(value: CborValue): readonly string[] {
  if (!isCborArray(value) || value.length > maxIdentityAliases) {
    throw new Error("payload_invalid");
  }
  const aliases = value.map((entry) => readAlias(readText(entry, "alias")));
  return normalizeAliases(aliases);
}

function readDisplayName(value: CborValue): string {
  const displayName = readText(value, "display_name");
  if (encoder.encode(displayName).byteLength > maxIdentityDisplayNameBytes) {
    throw new Error("payload_invalid");
  }
  return displayName;
}

function readRouteHints(value: CborValue): readonly IdentityContactRouteHint[] {
  if (!isCborArray(value) || value.length > maxIdentityRouteHints) {
    throw new Error("payload_invalid");
  }
  let previousPriority = -1;
  const seen = new Set<string>();
  return value.map((entry) => {
    const hintMap = readCborMap(entry, "route_hint");
    rejectUnknownEntries(hintMap, ["transport", "uri", "relay_public_key", "profile_multihash", "priority"]);
    const transport = readTransport(getRequiredEntry(hintMap, "transport"));
    const uri = readRouteUri(getRequiredEntry(hintMap, "uri"));
    const relayPublicKey = readRelayPublicKey(getRequiredEntry(hintMap, "relay_public_key"));
    const profileMultihash = readText(getRequiredEntry(hintMap, "profile_multihash"), "profile_multihash");
    const priority = readUint(getRequiredEntry(hintMap, "priority"), "priority");
    if (priority < previousPriority) {
      throw new Error("payload_invalid");
    }
    previousPriority = priority;
    const duplicateKey = `${transport}\u0000${uri}\u0000${relayPublicKey}`;
    if (seen.has(duplicateKey)) {
      throw new Error("payload_invalid");
    }
    seen.add(duplicateKey);
    if (transport === "wss") {
      validateWssEndpointUri(uri);
    }
    return { transport, uri, relayPublicKey, profileMultihash, priority };
  });
}

function normalizeAliases(values: readonly string[]): readonly string[] {
  const normalized = [...values].map(readAlias).sort();
  const seen = new Set<string>();
  for (const value of normalized) {
    if (seen.has(value)) {
      throw new Error("payload_invalid");
    }
    seen.add(value);
  }
  return normalized;
}

function readAlias(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (encoder.encode(normalized).byteLength > maxIdentityAliasBytes || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(normalized)) {
    throw new Error("payload_invalid");
  }
  return normalized;
}

function normalizeOrderedTextSet(values: readonly string[], key: string): readonly string[] {
  const normalized = [...values].sort();
  const seen = new Set<string>();
  for (const value of normalized) {
    if (value.length === 0 || encoder.encode(value).byteLength > maxIdentityAliasBytes || seen.has(value)) {
      throw new Error(`invalid_${key}`);
    }
    seen.add(value);
  }
  return normalized;
}

function normalizeRouteHints(hints: readonly IdentityContactRouteHint[]): readonly IdentityContactRouteHint[] {
  const ordered = [...hints]
    .map((hint) => ({
      transport: hint.transport,
      uri: hint.uri,
      relayPublicKey: hint.relayPublicKey,
      profileMultihash: hint.profileMultihash,
      priority: hint.priority
    }))
    .sort((left, right) => left.priority - right.priority || left.transport.localeCompare(right.transport) || left.uri.localeCompare(right.uri));
  return readRouteHints(ordered.map((hint) => cborMap([
    { key: "transport", value: hint.transport },
    { key: "uri", value: hint.uri },
    { key: "relay_public_key", value: hint.relayPublicKey },
    { key: "profile_multihash", value: hint.profileMultihash },
    { key: "priority", value: hint.priority }
  ])));
}

function readTransport(value: CborValue): string {
  const transport = readText(value, "transport");
  if (encoder.encode(transport).byteLength > maxIdentityRouteTransportBytes || !/^[a-z][a-z0-9.+-]*$/.test(transport)) {
    throw new Error("payload_invalid");
  }
  return transport;
}

function readRouteUri(value: CborValue): string {
  const uri = readText(value, "uri");
  if (encoder.encode(uri).byteLength > maxIdentityRouteUriBytes) {
    throw new Error("payload_invalid");
  }
  return uri;
}

function readRelayPublicKey(value: CborValue): string {
  const relayPublicKey = readText(value, "relay_public_key");
  const decoded = decodeBase64URL(relayPublicKey);
  if (decoded.byteLength !== 32) {
    throw new Error("payload_invalid");
  }
  return relayPublicKey;
}

function validateWssEndpointUri(uri: string): void {
  const explicitPort = readExplicitPort(uri);
  if (explicitPort === null || explicitPort < 1 || explicitPort > 65535) {
    throw new Error("payload_invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("payload_invalid");
  }
  if (
    parsed.protocol !== "wss:" ||
    parsed.hostname === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("payload_invalid");
  }
}

function readExplicitPort(uri: string): number | null {
  if (!uri.startsWith("wss://")) {
    return null;
  }
  const authorityEnd = uri.slice(6).search(/[/?#]/);
  const authority = authorityEnd === -1 ? uri.slice(6) : uri.slice(6, authorityEnd + 6);
  if (authority.includes("@")) {
    return null;
  }
  const match = authority.startsWith("[")
    ? authority.match(/^\[[^\]]+\]:(\d+)$/)
    : authority.match(/^[^:]+:(\d+)$/);
  if (match === null) {
    return null;
  }
  const port = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(port) ? port : null;
}

function hasSupportedProfile(profileMultihashes: readonly string[], supportedProfileMultihashes: readonly string[]): boolean {
  const supported = new Set(supportedProfileMultihashes);
  return profileMultihashes.some((profileMultihash) => supported.has(profileMultihash));
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

function signedEnvelopeEntries(envelope: IdentityContactEnvelope): readonly CborEntry[] {
  return [...unsignedEnvelopeEntries(envelope), { key: "signature", value: envelope.signature }];
}

function unsignedEnvelopeEntries(envelope: Omit<IdentityContactEnvelope, "signature">): readonly CborEntry[] {
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

function reject(reason: IdentityContactValidationReason): IdentityContactValidationResult {
  return { accepted: false, reason };
}

function reasonFromError(error: unknown): IdentityContactValidationReason {
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

function isValidationReason(value: string): value is IdentityContactValidationReason {
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
    "payload_issued_after_created",
    "invalid_branch_id",
    "branch_id_mismatch",
    "lower_sequence"
  ].includes(value);
}
