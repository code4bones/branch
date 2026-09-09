import {
  cborMap,
  decodeDeterministicCbor,
  encodeDeterministicCbor,
  getRequiredEntry,
  isCborArray,
  readCborMap,
  readText,
  readUint,
  rejectUnknownEntries,
  type CborMap,
  type CborValue
} from "../protocol/v0/cbor.js";

// This is an application-control kind, not a relay or connectivity capability.
// Its body is carried only by a signed application-control envelope.
export const applicationCapabilitiesControlKind = "branch.application.capabilities/0.draft" as const;
export const maxApplicationCapabilitiesBytes = 2_048;
export const maxApplicationCapabilityIdentifiers = 16;
export const maxApplicationCapabilityIdentifierBytes = 96;
export const maxApplicationCapabilityInlineBytes = 3_000;
export const maxApplicationCapabilityRelayAttachmentBytes = 4 * 1024 * 1024;
export const maxApplicationCapabilityDirectAttachmentBytes = 16 * 1024 * 1024;

export type AttachmentMode = "none" | "receiver-accept";

export interface ApplicationCapabilities {
  readonly applicationVersions: readonly string[];
  readonly kinds: readonly string[];
  readonly maxInlineBytes: number;
  readonly attachmentMode: AttachmentMode;
  readonly maxRelayAttachmentBytes: number;
  readonly maxDirectAttachmentBytes: number;
}

// EncodeApplicationCapabilities produces the exact deterministic-CBOR body for
// branch.application.capabilities/0.draft. It neither signs nor sends it.
export function encodeApplicationCapabilities(value: ApplicationCapabilities): Uint8Array {
  validateApplicationCapabilities(value);
  const bytes = encodeDeterministicCbor(capabilitiesMap(value));
  if (bytes.byteLength > maxApplicationCapabilitiesBytes) {
    throw new Error("application capabilities body too large");
  }
  return bytes;
}

// DecodeApplicationCapabilities accepts only canonical, bounded body bytes.
// It has no relay, clock, contact, signature, or policy side effects.
export function decodeApplicationCapabilities(bytes: Uint8Array): ApplicationCapabilities {
  if (bytes.byteLength === 0 || bytes.byteLength > maxApplicationCapabilitiesBytes) {
    throw new Error("invalid application capabilities body size");
  }
  const map = readCborMap(decodeDeterministicCbor(bytes, maxApplicationCapabilitiesBytes), "application_capabilities");
  rejectUnknownEntries(map, ["application_versions", "kinds", "max_inline_bytes", "attachment_mode", "max_relay_attachment_bytes", "max_direct_attachment_bytes"]);
  const attachmentMode = readText(getRequiredEntry(map, "attachment_mode"), "attachment_mode");
  const value: ApplicationCapabilities = {
    applicationVersions: readOrderedIdentifiers(getRequiredEntry(map, "application_versions"), "application_versions"),
    kinds: readOrderedIdentifiers(getRequiredEntry(map, "kinds"), "kinds"),
    maxInlineBytes: readUint(getRequiredEntry(map, "max_inline_bytes"), "max_inline_bytes"),
    attachmentMode: attachmentMode === "none" || attachmentMode === "receiver-accept" ? attachmentMode : invalidAttachmentMode(),
    maxRelayAttachmentBytes: readUint(getRequiredEntry(map, "max_relay_attachment_bytes"), "max_relay_attachment_bytes"),
    maxDirectAttachmentBytes: readUint(getRequiredEntry(map, "max_direct_attachment_bytes"), "max_direct_attachment_bytes")
  };
  validateApplicationCapabilities(value);
  return value;
}

export function validateApplicationCapabilities(value: ApplicationCapabilities): void {
  validateOrderedIdentifiers(value.applicationVersions, "application versions");
  validateOrderedIdentifiers(value.kinds, "application kinds");
  if (!Number.isSafeInteger(value.maxInlineBytes) || value.maxInlineBytes < 0 || value.maxInlineBytes > maxApplicationCapabilityInlineBytes ||
      !Number.isSafeInteger(value.maxRelayAttachmentBytes) || value.maxRelayAttachmentBytes < 0 || value.maxRelayAttachmentBytes > maxApplicationCapabilityRelayAttachmentBytes ||
      !Number.isSafeInteger(value.maxDirectAttachmentBytes) || value.maxDirectAttachmentBytes < 0 || value.maxDirectAttachmentBytes > maxApplicationCapabilityDirectAttachmentBytes ||
      (value.attachmentMode !== "none" && value.attachmentMode !== "receiver-accept")) {
    throw new Error("invalid application capabilities");
  }
}

function capabilitiesMap(value: ApplicationCapabilities): CborMap {
  return cborMap([
    { key: "application_versions", value: [...value.applicationVersions] },
    { key: "kinds", value: [...value.kinds] },
    { key: "max_inline_bytes", value: value.maxInlineBytes },
    { key: "attachment_mode", value: value.attachmentMode },
    { key: "max_relay_attachment_bytes", value: value.maxRelayAttachmentBytes },
    { key: "max_direct_attachment_bytes", value: value.maxDirectAttachmentBytes }
  ]);
}

function readOrderedIdentifiers(value: CborValue, label: string): readonly string[] {
  if (!isCborArray(value) || value.length > maxApplicationCapabilityIdentifiers) {
    throw new Error(`invalid ${label}`);
  }
  const identifiers = value.map((item) => readText(item, label));
  validateOrderedIdentifiers(identifiers, label);
  return identifiers;
}

function validateOrderedIdentifiers(values: readonly string[], label: string): void {
  if (values.length > maxApplicationCapabilityIdentifiers) {
    throw new Error(`invalid ${label}`);
  }
  let previous: string | undefined;
  for (const value of values) {
    if (!isASCIIIdentifier(value) || (previous !== undefined && value <= previous)) {
      throw new Error(`invalid ${label}`);
    }
    previous = value;
  }
}

function isASCIIIdentifier(value: string): boolean {
  const bytes = new TextEncoder().encode(value);
  return bytes.byteLength > 0 && bytes.byteLength <= maxApplicationCapabilityIdentifierBytes && [...bytes].every((byte) => byte >= 0x21 && byte <= 0x7e);
}

function invalidAttachmentMode(): never {
  throw new Error("invalid attachment mode");
}
