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

export const applicationControlWireVersion = "branch.application-control/0.draft" as const;
export const applicationControlSignatureDomain = "branch.application-control.signature/0.draft" as const;
const maxControlBytes = 4_096;
const maxControlKindBytes = 96;
const maxControlBodyBytes = 2_048;

export type ApplicationControlAuthentication = "none" | "ed25519";
export type ApplicationControlProjection = "ephemeral" | "message_metadata";
export type ApplicationControlEffectKind = "ephemeral_projection" | "message_metadata" | "outbound_control";

export interface ApplicationControlEnvelope {
  readonly version: typeof applicationControlWireVersion;
  readonly kind: string;
  readonly controlId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly senderPeerId: string;
  readonly recipientPeerId: string;
  readonly body: Uint8Array;
  readonly signature: Uint8Array;
}

export interface ApplicationControlDescriptor<Body> {
  readonly kind: string;
  readonly authentication: ApplicationControlAuthentication;
  readonly maximumTTLms: number;
  readonly projection: ApplicationControlProjection;
  readonly allowedEffects: readonly ApplicationControlEffectKind[];
  decodeBody(body: Uint8Array): Body;
  encodeBody(body: Body): Uint8Array;
  reduce(input: VerifiedApplicationControl<Body>): readonly ApplicationControlEffect[];
}

export interface VerifiedApplicationControl<Body> {
  readonly envelope: ApplicationControlEnvelope;
  readonly body: Body;
}

export type ApplicationControlEffect =
  | { readonly kind: "ephemeral_projection"; readonly projection: string; readonly value: Uint8Array; readonly expiresAt: number }
  | { readonly kind: "message_metadata"; readonly deliveryId: string; readonly state: string }
  | { readonly kind: "outbound_control"; readonly controlKind: string; readonly body: Uint8Array; readonly expiresAt: number };

export interface ApplicationControlPorts {
  readonly now: number;
  readonly localPeerId: string;
  readonly isKnownContact: (peerId: string) => boolean;
  readonly verifyEd25519: (peerId: string, input: Uint8Array, signature: Uint8Array) => Promise<boolean>;
  readonly hasSeenControl: (controlId: string) => boolean;
  readonly rememberControl: (controlId: string, expiresAt: number) => void;
  readonly isAllowed: (kind: string, senderPeerId: string) => boolean;
  readonly maxClockSkewMs: number;
}

export type ApplicationControlResult =
  | { readonly status: "accepted"; readonly effects: readonly ApplicationControlEffect[] }
  | { readonly status: "rejected"; readonly reason: ApplicationControlRejection };

export type ApplicationControlRejection =
  | "malformed"
  | "unknown_kind"
  | "recipient_mismatch"
  | "unknown_contact"
  | "expired"
  | "future_issued"
  | "ttl_exceeded"
  | "replay"
  | "policy_denied"
  | "signature_invalid"
  | "body_invalid"
  | "effect_forbidden";

export interface OutboundApplicationControl<Body> {
  readonly kind: string;
  readonly controlId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly senderPeerId: string;
  readonly recipientPeerId: string;
  readonly body: Body;
}

export interface OutboundApplicationControlPorts {
  readonly now: number;
  readonly localPeerId: string;
  readonly isKnownContact: (peerId: string) => boolean;
  readonly isAllowed: (kind: string, recipientPeerId: string) => boolean;
  readonly consumeRateLimit: (kind: string, recipientPeerId: string, now: number) => boolean;
  readonly maxClockSkewMs: number;
}

export function createApplicationControlRegistry(
  descriptors: readonly ApplicationControlDescriptor<unknown>[]
): ReadonlyMap<string, ApplicationControlDescriptor<unknown>> {
  const registry = new Map<string, ApplicationControlDescriptor<unknown>>();
  for (const descriptor of descriptors) {
    validateDescriptor(descriptor);
    if (registry.has(descriptor.kind)) {
      throw new Error("duplicate application control descriptor");
    }
    registry.set(descriptor.kind, descriptor);
  }
  return registry;
}

export async function processApplicationControl(
  bytes: Uint8Array,
  registry: ReadonlyMap<string, ApplicationControlDescriptor<unknown>>,
  ports: ApplicationControlPorts
): Promise<ApplicationControlResult> {
  let envelope: ApplicationControlEnvelope;
  try {
    envelope = decodeApplicationControl(bytes);
  } catch {
    return rejected("malformed");
  }
  const descriptor = registry.get(envelope.kind);
  if (descriptor === undefined) {
    return rejected("unknown_kind");
  }
  if (envelope.recipientPeerId !== ports.localPeerId) {
    return rejected("recipient_mismatch");
  }
  if (!ports.isKnownContact(envelope.senderPeerId)) {
    return rejected("unknown_contact");
  }
  if (envelope.expiresAt <= ports.now) {
    return rejected("expired");
  }
  if (envelope.issuedAt > ports.now + ports.maxClockSkewMs) {
    return rejected("future_issued");
  }
  if (envelope.expiresAt - envelope.issuedAt > descriptor.maximumTTLms) {
    return rejected("ttl_exceeded");
  }
  if (ports.hasSeenControl(envelope.controlId)) {
    return rejected("replay");
  }
  if (!ports.isAllowed(envelope.kind, envelope.senderPeerId)) {
    return rejected("policy_denied");
  }
  if (descriptor.authentication === "ed25519") {
    if (!await ports.verifyEd25519(envelope.senderPeerId, applicationControlSigningBytes(envelope), envelope.signature)) {
      return rejected("signature_invalid");
    }
  } else if (envelope.signature.byteLength !== 0) {
    return rejected("signature_invalid");
  }
  let body: unknown;
  try {
    body = descriptor.decodeBody(envelope.body);
  } catch {
    return rejected("body_invalid");
  }
  const effects = descriptor.reduce({ envelope, body });
  if (!effects.every((effect) => descriptor.allowedEffects.includes(effect.kind)) || !effectsAreBounded(effects, envelope.expiresAt)) {
    return rejected("effect_forbidden");
  }
  ports.rememberControl(envelope.controlId, envelope.expiresAt);
  return { status: "accepted", effects };
}

// Prepares the canonical unsigned representation for an adapter that owns the
// identity key. Core never signs, opens sockets, reads a clock, or persists.
export function prepareOutboundApplicationControl<Body>(
  control: OutboundApplicationControl<Body>,
  descriptor: ApplicationControlDescriptor<Body>,
  ports: OutboundApplicationControlPorts
): Omit<ApplicationControlEnvelope, "signature"> {
  validateDescriptor(descriptor);
  if (control.kind !== descriptor.kind || control.senderPeerId !== ports.localPeerId || !ports.isKnownContact(control.recipientPeerId) || !ports.isAllowed(descriptor.kind, control.recipientPeerId)) {
    throw new Error("application control outbound policy denied");
  }
  const envelope = {
    version: applicationControlWireVersion,
    kind: descriptor.kind,
    controlId: requireBase64URLBytes(control.controlId, 16, "control id"),
    issuedAt: control.issuedAt,
    expiresAt: control.expiresAt,
    senderPeerId: requireBase64URLBytes(control.senderPeerId, 32, "sender peer id"),
    recipientPeerId: requireBase64URLBytes(control.recipientPeerId, 32, "recipient peer id"),
    body: boundedBody(descriptor.encodeBody(control.body))
  } satisfies Omit<ApplicationControlEnvelope, "signature">;
  if (envelope.issuedAt > ports.now + ports.maxClockSkewMs || envelope.expiresAt <= ports.now || envelope.expiresAt - envelope.issuedAt > descriptor.maximumTTLms) {
    throw new Error("invalid application control lifetime");
  }
  if (!ports.consumeRateLimit(descriptor.kind, envelope.recipientPeerId, ports.now)) {
    throw new Error("application control rate limited");
  }
  return envelope;
}

export function encodeApplicationControl(envelope: ApplicationControlEnvelope): Uint8Array {
  validateEnvelope(envelope);
  return encodeDeterministicCbor(envelopeMap(envelope, true));
}

export function applicationControlSigningBytes(envelope: Omit<ApplicationControlEnvelope, "signature"> | ApplicationControlEnvelope): Uint8Array {
  return concatBytes([new TextEncoder().encode(`${applicationControlSignatureDomain}\0`), encodeDeterministicCbor(envelopeMap(envelope, false))]);
}

export function decodeApplicationControl(bytes: Uint8Array): ApplicationControlEnvelope {
  if (bytes.byteLength === 0 || bytes.byteLength > maxControlBytes) {
    throw new Error("invalid application control size");
  }
  const map = readCborMap(decodeDeterministicCbor(bytes, maxControlBytes), "application_control");
  rejectUnknownEntries(map, ["version", "kind", "control_id", "issued_at", "expires_at", "sender_peer_id", "recipient_peer_id", "body", "signature"]);
  const envelope: ApplicationControlEnvelope = {
    version: readVersion(map),
    kind: readKind(map),
    controlId: encodeBase64URL(readBytes(getRequiredEntry(map, "control_id"), "control_id", 16)),
    issuedAt: readUint(getRequiredEntry(map, "issued_at"), "issued_at"),
    expiresAt: readUint(getRequiredEntry(map, "expires_at"), "expires_at"),
    senderPeerId: encodeBase64URL(readBytes(getRequiredEntry(map, "sender_peer_id"), "sender_peer_id", 32)),
    recipientPeerId: encodeBase64URL(readBytes(getRequiredEntry(map, "recipient_peer_id"), "recipient_peer_id", 32)),
    body: boundedBody(readBytes(getRequiredEntry(map, "body"), "body")),
    signature: readBytesOrEmpty(getRequiredEntry(map, "signature"), "signature")
  };
  validateEnvelope(envelope);
  return envelope;
}

function envelopeMap(envelope: Omit<ApplicationControlEnvelope, "signature"> | ApplicationControlEnvelope, includeSignature: boolean): CborMap {
  const entries = [
    { key: "version", value: envelope.version },
    { key: "kind", value: envelope.kind },
    { key: "control_id", value: decodeBase64URL(envelope.controlId) },
    { key: "issued_at", value: envelope.issuedAt },
    { key: "expires_at", value: envelope.expiresAt },
    { key: "sender_peer_id", value: decodeBase64URL(envelope.senderPeerId) },
    { key: "recipient_peer_id", value: decodeBase64URL(envelope.recipientPeerId) },
    { key: "body", value: envelope.body }
  ];
  if (includeSignature && "signature" in envelope) {
    entries.push({ key: "signature", value: envelope.signature });
  }
  return cborMap(entries);
}

function validateDescriptor<Body>(descriptor: ApplicationControlDescriptor<Body>): void {
  if (new TextEncoder().encode(descriptor.kind).byteLength === 0 || new TextEncoder().encode(descriptor.kind).byteLength > maxControlKindBytes || descriptor.maximumTTLms <= 0 || !Number.isSafeInteger(descriptor.maximumTTLms)) {
    throw new Error("invalid application control descriptor");
  }
}

function validateEnvelope(envelope: ApplicationControlEnvelope): void {
  if (envelope.version !== applicationControlWireVersion || new TextEncoder().encode(envelope.kind).byteLength === 0 || new TextEncoder().encode(envelope.kind).byteLength > maxControlKindBytes || envelope.expiresAt <= envelope.issuedAt) {
    throw new Error("invalid application control envelope");
  }
  requireBase64URLBytes(envelope.controlId, 16, "control id");
  requireBase64URLBytes(envelope.senderPeerId, 32, "sender peer id");
  requireBase64URLBytes(envelope.recipientPeerId, 32, "recipient peer id");
  boundedBody(envelope.body);
  if (envelope.signature.byteLength !== 0 && envelope.signature.byteLength !== 64) {
    throw new Error("invalid application control signature");
  }
}

function effectsAreBounded(effects: readonly ApplicationControlEffect[], envelopeExpiry: number): boolean {
  return effects.length <= 4 && effects.every((effect) => {
    if (effect.kind === "ephemeral_projection") {
      return effect.projection.length > 0 && effect.value.byteLength <= maxControlBodyBytes && effect.expiresAt > 0 && effect.expiresAt <= envelopeExpiry;
    }
    if (effect.kind === "message_metadata") {
      return isBase64URLBytes(effect.deliveryId, 16) && effect.state.length > 0 && effect.state.length <= 64;
    }
    return effect.controlKind.length > 0 && effect.controlKind.length <= maxControlKindBytes && effect.body.byteLength <= maxControlBodyBytes && effect.expiresAt > 0 && effect.expiresAt <= envelopeExpiry;
  });
}

function readVersion(map: CborMap): typeof applicationControlWireVersion {
  if (readText(getRequiredEntry(map, "version"), "version") !== applicationControlWireVersion) {
    throw new Error("unsupported application control version");
  }
  return applicationControlWireVersion;
}

function readKind(map: CborMap): string {
  const kind = readText(getRequiredEntry(map, "kind"), "kind");
  if (new TextEncoder().encode(kind).byteLength > maxControlKindBytes) {
    throw new Error("invalid application control kind");
  }
  return kind;
}

function readBytesOrEmpty(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > 64) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function boundedBody(value: Uint8Array): Uint8Array {
  if (value.byteLength === 0 || value.byteLength > maxControlBodyBytes) {
    throw new Error("invalid application control body");
  }
  return value;
}

function requireBase64URLBytes(value: string, size: number, label: string): string {
  if (!isBase64URLBytes(value, size)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function isBase64URLBytes(value: string, size: number): boolean {
  try {
    return decodeBase64URL(value).byteLength === size;
  } catch {
    return false;
  }
}

function rejected(reason: ApplicationControlRejection): ApplicationControlResult {
  return { status: "rejected", reason };
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
