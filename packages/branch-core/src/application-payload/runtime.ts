import {
  cborMap,
  decodeDeterministicCbor,
  encodeDeterministicCbor,
  getRequiredEntry,
  readBytes,
  readCborMap,
  readText,
  rejectUnknownEntries,
  type CborMap
} from "../protocol/v0/cbor.js";
import { decodeBase64URL, encodeBase64URL } from "../protocol/v0/base64url.js";

export const applicationPayloadVersion = "branch.application-payload/0.draft" as const;
export const chatTextKind = "branch.chat.text/0.draft" as const;
export const inlineBinaryKind = "branch.binary.inline/0.draft" as const;
export const maxApplicationPayloadBytes = 4_096;
export const maxApplicationPayloadKindBytes = 96;
export const maxInlineBinaryBytes = 3_000;

export interface ApplicationPayloadEnvelope {
  readonly version: typeof applicationPayloadVersion;
  readonly kind: string;
  readonly messageId: string;
  readonly body: Uint8Array;
}

export interface ApplicationPayloadDescriptor {
  readonly kind: string;
  readonly maximumBodyBytes: number;
  readonly requiredCapability: string;
}

export type RegisteredApplicationPayload =
  | { readonly status: "accepted"; readonly envelope: ApplicationPayloadEnvelope; readonly descriptor: ApplicationPayloadDescriptor }
  | { readonly status: "unknown_kind"; readonly envelope: ApplicationPayloadEnvelope };

export function createApplicationPayloadRegistry(descriptors: readonly ApplicationPayloadDescriptor[]): ReadonlyMap<string, ApplicationPayloadDescriptor> {
  const registry = new Map<string, ApplicationPayloadDescriptor>();
  for (const descriptor of descriptors) {
    validateDescriptor(descriptor);
    if (registry.has(descriptor.kind)) throw new Error("duplicate application payload descriptor");
    registry.set(descriptor.kind, descriptor);
  }
  return registry;
}

export function encodeApplicationPayload(envelope: ApplicationPayloadEnvelope): Uint8Array {
  validateEnvelope(envelope);
  return encodeDeterministicCbor(envelopeMap(envelope));
}

export function decodeApplicationPayload(bytes: Uint8Array): ApplicationPayloadEnvelope {
  if (bytes.byteLength === 0 || bytes.byteLength > maxApplicationPayloadBytes) throw new Error("invalid application payload size");
  const map = readCborMap(decodeDeterministicCbor(bytes, maxApplicationPayloadBytes), "application_payload");
  rejectUnknownEntries(map, ["version", "kind", "message_id", "body"]);
  const version = readText(getRequiredEntry(map, "version"), "version");
  if (version !== applicationPayloadVersion) throw new Error("unsupported application payload version");
  const envelope: ApplicationPayloadEnvelope = {
    version,
    kind: readKind(map),
    messageId: encodeBase64URL(readBytes(getRequiredEntry(map, "message_id"), "message_id", 16)),
    body: readBytes(getRequiredEntry(map, "body"), "body")
  };
  validateEnvelope(envelope);
  return envelope;
}

// An unknown kind is intentionally non-actionable. The caller must not render
// it, create contact state, or send an automatic reply.
export function classifyApplicationPayload(bytes: Uint8Array, registry: ReadonlyMap<string, ApplicationPayloadDescriptor>): RegisteredApplicationPayload {
  const envelope = decodeApplicationPayload(bytes);
  const descriptor = registry.get(envelope.kind);
  if (descriptor === undefined) return { status: "unknown_kind", envelope };
  if (envelope.body.byteLength > descriptor.maximumBodyBytes) throw new Error("application payload body too large");
  return { status: "accepted", envelope, descriptor };
}

function envelopeMap(envelope: ApplicationPayloadEnvelope): CborMap {
  return cborMap([
    { key: "version", value: envelope.version },
    { key: "kind", value: envelope.kind },
    { key: "message_id", value: decodeBase64URL(envelope.messageId) },
    { key: "body", value: envelope.body }
  ]);
}

function readKind(map: CborMap): string {
  const kind = readText(getRequiredEntry(map, "kind"), "kind");
  if (new TextEncoder().encode(kind).byteLength > maxApplicationPayloadKindBytes) throw new Error("invalid application payload kind");
  return kind;
}

function validateEnvelope(envelope: ApplicationPayloadEnvelope): void {
  if (envelope.version !== applicationPayloadVersion || new TextEncoder().encode(envelope.kind).byteLength === 0 || new TextEncoder().encode(envelope.kind).byteLength > maxApplicationPayloadKindBytes || envelope.body.byteLength === 0 || envelope.body.byteLength > maxApplicationPayloadBytes || !isToken(envelope.messageId, 16)) throw new Error("invalid application payload envelope");
}

function validateDescriptor(descriptor: ApplicationPayloadDescriptor): void {
  if (new TextEncoder().encode(descriptor.kind).byteLength === 0 || new TextEncoder().encode(descriptor.kind).byteLength > maxApplicationPayloadKindBytes || !Number.isSafeInteger(descriptor.maximumBodyBytes) || descriptor.maximumBodyBytes < 1 || descriptor.maximumBodyBytes > maxApplicationPayloadBytes || new TextEncoder().encode(descriptor.requiredCapability).byteLength === 0 || new TextEncoder().encode(descriptor.requiredCapability).byteLength > maxApplicationPayloadKindBytes) throw new Error("invalid application payload descriptor");
}

function isToken(value: string, size: number): boolean {
  try { return decodeBase64URL(value).byteLength === size; } catch { return false; }
}
