import {
  cborMap,
  decodeDeterministicCbor,
  encodeDeterministicCbor,
  getRequiredEntry,
  hasEntry,
  readBytes,
  readCborMap,
  readText,
  readUint,
  rejectUnknownEntries,
  type CborMap
} from "../protocol/v0/cbor.js";
import { decodeBase64URL, encodeBase64URL } from "../protocol/v0/base64url.js";
import type { ApplicationPayloadDescriptor } from "./runtime.js";

// Image values are endpoint-only application-payload bodies. They are not
// relay frames, relay capabilities, URLs, or a request for relay storage.
export const imageMessageVersion = "branch.image-message/0.draft" as const;
export const imageTransferVersion = "branch.image-transfer/0.draft" as const;
export const imageTransferSignatureDomain = "branch.image-transfer.signature/0.draft" as const;
export const imageCapabilitiesControlKind = "branch.image.capabilities/0.draft" as const;
export const imageInlineKind = "branch.image.inline/0.draft" as const;
export const imageTransferManifestKind = "branch.image.transfer.manifest/0.draft" as const;
export const imageTransferChunkKind = "branch.image.transfer.chunk/0.draft" as const;

export const maxInlineImageBytes = 2_800;
export const maxInlineImageBodyBytes = 3_000;
export const maxImageTransferChunkBytes = 3_072;
export const maxImageTransferChunkBodyBytes = 4_096;
// A manifest has fixed signed fields in addition to its optional 1024-byte
// caption. Keep the complete nested body within the ordinary application
// payload bound without making a spec-valid caption impossible to decode.
export const maxImageTransferManifestBodyBytes = 2_048;
export const maxImageTransferChunks = 8_192;
export const maxImageRelayBytes = 4 * 1024 * 1024;
export const maxImageDirectBytes = 16 * 1024 * 1024;
export const maxImageTransferTTLms = 15 * 60 * 1_000;
export const maxImageWidth = 4_096;
export const maxImageHeight = 4_096;
export const maxImagePixels = 16 * 1024 * 1024;
export const maxImageCapabilitiesBytes = 512;
export const maxImageCaptionBytes = 1_024;

export type RasterImageMediaType = "image/jpeg" | "image/png" | "image/webp";
export type ImageRoute = "relay" | "direct";

export interface InlineImage {
  readonly version: typeof imageMessageVersion;
  readonly mediaType: RasterImageMediaType;
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
  readonly caption?: string;
  /** Optional local-only reply target: an exact application message ID. */
  readonly replyToMessageId?: string;
}

// An image-transfer manifest is the image message for non-inline media. The
// enclosing application-payload message_id must exactly match messageId here;
// the duplicate binding keeps a manifest from being projected under another
// message identity after HPKE opening.
export interface ImageTransferManifest {
  readonly version: typeof imageTransferVersion;
  readonly transferId: string;
  readonly manifestId: string;
  readonly messageId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly mediaType: RasterImageMediaType;
  readonly width: number;
  readonly height: number;
  readonly byteCount: number;
  readonly chunkBytes: number;
  readonly chunkCount: number;
  readonly sha256: string;
  readonly signature: Uint8Array;
  readonly caption?: string;
  /** Optional local-only reply target: an exact application message ID. */
  readonly replyToMessageId?: string;
}

export interface ImageTransferChunk {
  readonly version: typeof imageTransferVersion;
  readonly transferId: string;
  readonly manifestId: string;
  readonly index: number;
  readonly bytes: Uint8Array;
}

// This body is carried in an existing signed application-control envelope.
// Its presence means the endpoint opted into automatic image admission within
// these receiver-owned limits. It has no relay authorization meaning.
export interface ImageCapabilities {
  readonly version: typeof imageMessageVersion;
  readonly maxInlineBytes: number;
  readonly maxRelayBytes: number;
  readonly maxDirectBytes: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxPixels: number;
}

export const imageApplicationPayloadDescriptors: readonly ApplicationPayloadDescriptor[] = [
  { kind: imageInlineKind, maximumBodyBytes: maxInlineImageBodyBytes, requiredCapability: imageCapabilitiesControlKind },
  { kind: imageTransferManifestKind, maximumBodyBytes: maxImageTransferManifestBodyBytes, requiredCapability: imageCapabilitiesControlKind },
  { kind: imageTransferChunkKind, maximumBodyBytes: maxImageTransferChunkBodyBytes, requiredCapability: imageCapabilitiesControlKind }
];

export function encodeInlineImage(image: InlineImage): Uint8Array {
  validateInlineImage(image);
  const bytes = encodeDeterministicCbor(inlineMap(image));
  if (bytes.byteLength > maxInlineImageBodyBytes) throw new Error("inline image body too large");
  return bytes;
}

export function decodeInlineImage(bytes: Uint8Array): InlineImage {
  const map = strictMap(bytes, "inline image", ["version", "media_type", "width", "height", "bytes", "caption", "reply_to_message_id"], maxInlineImageBodyBytes);
  const value: InlineImage = {
    version: readImageMessageVersion(map),
    mediaType: readRasterMediaType(map, "media_type"),
    width: number(map, "width"),
    height: number(map, "height"),
    bytes: readBytes(getRequiredEntry(map, "bytes"), "bytes"),
    ...(hasEntry(map, "caption") ? { caption: readCaption(map, "caption") } : {}),
    ...(hasEntry(map, "reply_to_message_id") ? { replyToMessageId: token(map, "reply_to_message_id", 16) } : {})
  };
  validateInlineImage(value);
  return value;
}

export function encodeImageTransferManifest(manifest: ImageTransferManifest): Uint8Array {
  validateImageTransferManifest(manifest);
  const bytes = encodeDeterministicCbor(manifestMap(manifest, true));
  if (bytes.byteLength > maxImageTransferManifestBodyBytes) throw new Error("image transfer manifest body too large");
  return bytes;
}

export function decodeImageTransferManifest(bytes: Uint8Array): ImageTransferManifest {
  const map = strictMap(bytes, "image transfer manifest", ["version", "transfer_id", "manifest_id", "message_id", "issued_at", "expires_at", "media_type", "width", "height", "byte_count", "chunk_bytes", "chunk_count", "sha256", "signature", "caption", "reply_to_message_id"], maxImageTransferManifestBodyBytes);
  const value: ImageTransferManifest = {
    version: readImageTransferVersion(map),
    transferId: token(map, "transfer_id", 16),
    manifestId: token(map, "manifest_id", 32),
    messageId: token(map, "message_id", 16),
    issuedAt: number(map, "issued_at"),
    expiresAt: number(map, "expires_at"),
    mediaType: readRasterMediaType(map, "media_type"),
    width: number(map, "width"),
    height: number(map, "height"),
    byteCount: number(map, "byte_count"),
    chunkBytes: number(map, "chunk_bytes"),
    chunkCount: number(map, "chunk_count"),
    sha256: token(map, "sha256", 32),
    signature: readBytes(getRequiredEntry(map, "signature"), "signature", 64),
    ...(hasEntry(map, "caption") ? { caption: readCaption(map, "caption") } : {}),
    ...(hasEntry(map, "reply_to_message_id") ? { replyToMessageId: token(map, "reply_to_message_id", 16) } : {})
  };
  validateImageTransferManifest(value);
  return value;
}

export function imageTransferManifestSigningBytes(manifest: ImageTransferManifest): Uint8Array {
  validateImageTransferManifest(manifest);
  return signed(manifestMap(manifest, false));
}

export function encodeImageTransferChunk(chunk: ImageTransferChunk): Uint8Array {
  validateImageTransferChunk(chunk);
  return encodeDeterministicCbor(chunkMap(chunk));
}

export function decodeImageTransferChunk(bytes: Uint8Array): ImageTransferChunk {
  const map = strictMap(bytes, "image transfer chunk", ["version", "transfer_id", "manifest_id", "index", "bytes"], maxImageTransferChunkBodyBytes);
  const value: ImageTransferChunk = {
    version: readImageTransferVersion(map),
    transferId: token(map, "transfer_id", 16),
    manifestId: token(map, "manifest_id", 32),
    index: number(map, "index"),
    bytes: readBytes(getRequiredEntry(map, "bytes"), "bytes")
  };
  validateImageTransferChunk(value);
  return value;
}

export function validateImageTransferManifest(manifest: ImageTransferManifest): void {
  validateImageShape(manifest.mediaType, manifest.width, manifest.height);
  validateCaption(manifest.caption);
  if (manifest.version !== imageTransferVersion || !tokenIs(manifest.transferId, 16) || !tokenIs(manifest.manifestId, 32) || !tokenIs(manifest.messageId, 16) || !tokenIs(manifest.sha256, 32) || (manifest.replyToMessageId !== undefined && !tokenIs(manifest.replyToMessageId, 16)) || manifest.signature.byteLength !== 64 || !isSafeTime(manifest.issuedAt) || !isSafeTime(manifest.expiresAt) || manifest.expiresAt <= manifest.issuedAt || manifest.expiresAt - manifest.issuedAt > maxImageTransferTTLms || !Number.isSafeInteger(manifest.byteCount) || manifest.byteCount < 1 || manifest.byteCount > maxImageDirectBytes || !Number.isSafeInteger(manifest.chunkBytes) || manifest.chunkBytes < 256 || manifest.chunkBytes > maxImageTransferChunkBytes || !Number.isSafeInteger(manifest.chunkCount) || manifest.chunkCount < 1 || manifest.chunkCount > maxImageTransferChunks || manifest.chunkCount !== Math.ceil(manifest.byteCount / manifest.chunkBytes)) {
    throw new Error("invalid image transfer manifest");
  }
}

export function validateImageTransferChunk(chunk: ImageTransferChunk): void {
  if (chunk.version !== imageTransferVersion || !tokenIs(chunk.transferId, 16) || !tokenIs(chunk.manifestId, 32) || !Number.isSafeInteger(chunk.index) || chunk.index < 0 || chunk.bytes.byteLength === 0 || chunk.bytes.byteLength > maxImageTransferChunkBytes) {
    throw new Error("invalid image transfer chunk");
  }
}

export function validateImageTransferChunkForManifest(chunk: ImageTransferChunk, manifest: ImageTransferManifest): void {
  validateImageTransferChunk(chunk);
  validateImageTransferManifest(manifest);
  if (chunk.transferId !== manifest.transferId || chunk.manifestId !== manifest.manifestId || chunk.index >= manifest.chunkCount || chunk.bytes.byteLength > manifest.chunkBytes || (chunk.index + 1 < manifest.chunkCount && chunk.bytes.byteLength !== manifest.chunkBytes)) {
    throw new Error("image transfer chunk does not match manifest");
  }
}

export function validateImageManifestForMessage(manifest: ImageTransferManifest, messageId: string): void {
  validateImageTransferManifest(manifest);
  if (!tokenIs(messageId, 16) || manifest.messageId !== messageId) throw new Error("image transfer message identity mismatch");
}

export function encodeImageCapabilities(capabilities: ImageCapabilities): Uint8Array {
  validateImageCapabilities(capabilities);
  const bytes = encodeDeterministicCbor(cborMap([
    { key: "version", value: capabilities.version },
    { key: "max_inline_bytes", value: capabilities.maxInlineBytes },
    { key: "max_relay_bytes", value: capabilities.maxRelayBytes },
    { key: "max_direct_bytes", value: capabilities.maxDirectBytes },
    { key: "max_width", value: capabilities.maxWidth },
    { key: "max_height", value: capabilities.maxHeight },
    { key: "max_pixels", value: capabilities.maxPixels }
  ]));
  if (bytes.byteLength > maxImageCapabilitiesBytes) throw new Error("image capabilities body too large");
  return bytes;
}

export function decodeImageCapabilities(bytes: Uint8Array): ImageCapabilities {
  const map = strictMap(bytes, "image capabilities", ["version", "max_inline_bytes", "max_relay_bytes", "max_direct_bytes", "max_width", "max_height", "max_pixels"], maxImageCapabilitiesBytes);
  const value: ImageCapabilities = {
    version: readImageMessageVersion(map),
    maxInlineBytes: number(map, "max_inline_bytes"),
    maxRelayBytes: number(map, "max_relay_bytes"),
    maxDirectBytes: number(map, "max_direct_bytes"),
    maxWidth: number(map, "max_width"),
    maxHeight: number(map, "max_height"),
    maxPixels: number(map, "max_pixels")
  };
  validateImageCapabilities(value);
  return value;
}

export function validateImageCapabilities(capabilities: ImageCapabilities): void {
  if (capabilities.version !== imageMessageVersion || !isBoundedInteger(capabilities.maxInlineBytes, 0, maxInlineImageBytes) || !isBoundedInteger(capabilities.maxRelayBytes, 0, maxImageRelayBytes) || !isBoundedInteger(capabilities.maxDirectBytes, 0, maxImageDirectBytes) || !isBoundedInteger(capabilities.maxWidth, 1, maxImageWidth) || !isBoundedInteger(capabilities.maxHeight, 1, maxImageHeight) || !isBoundedInteger(capabilities.maxPixels, 1, maxImagePixels) || capabilities.maxPixels > capabilities.maxWidth * capabilities.maxHeight) {
    throw new Error("invalid image capabilities");
  }
}

// This deliberately performs only bounded signature recognition, not image
// decoding. Endpoint adapters must still decode and compare actual dimensions
// before projection. It is exported for the completed-transfer admission path.
export function hasRasterImageMagic(mediaType: RasterImageMediaType, bytes: Uint8Array): boolean {
  if (mediaType === "image/jpeg") return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mediaType === "image/png") return bytes.byteLength >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  if (mediaType === "image/webp") return bytes.byteLength >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  return false;
}

// These pure predicates deliberately do not verify a signature, clock, magic
// bytes, or decoded pixels. The application-control and image decoder adapters
// own those independent admission checks before projection.
export function capabilityAllowsInlineImage(capabilities: ImageCapabilities, image: InlineImage): boolean {
  try {
    validateImageCapabilities(capabilities);
    validateInlineImage(image);
    return image.bytes.byteLength <= capabilities.maxInlineBytes && shapeFits(image.width, image.height, capabilities);
  } catch { return false; }
}

export function capabilityAllowsImageTransfer(capabilities: ImageCapabilities, manifest: ImageTransferManifest, route: ImageRoute): boolean {
  try {
    validateImageCapabilities(capabilities);
    validateImageTransferManifest(manifest);
    const maxBytes = route === "relay" ? capabilities.maxRelayBytes : capabilities.maxDirectBytes;
    return manifest.byteCount <= maxBytes && shapeFits(manifest.width, manifest.height, capabilities);
  } catch { return false; }
}

function validateInlineImage(image: InlineImage): void {
  validateImageShape(image.mediaType, image.width, image.height);
  if (image.version !== imageMessageVersion || image.bytes.byteLength === 0 || image.bytes.byteLength > maxInlineImageBytes || !hasRasterImageMagic(image.mediaType, image.bytes)) throw new Error("invalid inline image");
  validateCaption(image.caption);
  if (image.replyToMessageId !== undefined && !tokenIs(image.replyToMessageId, 16)) throw new Error("invalid inline image reply target");
}

function validateImageShape(mediaType: RasterImageMediaType, width: number, height: number): void {
  if (!isRasterImageMediaType(mediaType) || !isBoundedInteger(width, 1, maxImageWidth) || !isBoundedInteger(height, 1, maxImageHeight) || width * height > maxImagePixels) throw new Error("invalid image shape");
}

function isRasterImageMediaType(value: string): value is RasterImageMediaType { return value === "image/jpeg" || value === "image/png" || value === "image/webp"; }
function inlineMap(image: InlineImage): CborMap { return cborMap([{ key: "version", value: image.version }, { key: "media_type", value: image.mediaType }, { key: "width", value: image.width }, { key: "height", value: image.height }, { key: "bytes", value: image.bytes }, ...(image.caption === undefined ? [] : [{ key: "caption", value: image.caption }]), ...(image.replyToMessageId === undefined ? [] : [{ key: "reply_to_message_id", value: decodeBase64URL(image.replyToMessageId) }])]); }
function manifestMap(value: ImageTransferManifest, signature: boolean): CborMap { const entries = baseManifest(value); if (signature) entries.push({ key: "signature", value: value.signature }); return cborMap(entries); }
function baseManifest(value: ImageTransferManifest) { return [{ key: "version", value: value.version }, { key: "transfer_id", value: decodeBase64URL(value.transferId) }, { key: "manifest_id", value: decodeBase64URL(value.manifestId) }, { key: "message_id", value: decodeBase64URL(value.messageId) }, { key: "issued_at", value: value.issuedAt }, { key: "expires_at", value: value.expiresAt }, { key: "media_type", value: value.mediaType }, { key: "width", value: value.width }, { key: "height", value: value.height }, { key: "byte_count", value: value.byteCount }, { key: "chunk_bytes", value: value.chunkBytes }, { key: "chunk_count", value: value.chunkCount }, { key: "sha256", value: decodeBase64URL(value.sha256) }, ...(value.caption === undefined ? [] : [{ key: "caption", value: value.caption }]), ...(value.replyToMessageId === undefined ? [] : [{ key: "reply_to_message_id", value: decodeBase64URL(value.replyToMessageId) }])]; }
function chunkMap(value: ImageTransferChunk): CborMap { return cborMap([{ key: "version", value: value.version }, { key: "transfer_id", value: decodeBase64URL(value.transferId) }, { key: "manifest_id", value: decodeBase64URL(value.manifestId) }, { key: "index", value: value.index }, { key: "bytes", value: value.bytes }]); }
function signed(map: CborMap): Uint8Array { const prefix = new TextEncoder().encode(`${imageTransferSignatureDomain}\0`); const body = encodeDeterministicCbor(map); const bytes = new Uint8Array(prefix.byteLength + body.byteLength); bytes.set(prefix); bytes.set(body, prefix.byteLength); return bytes; }
function strictMap(bytes: Uint8Array, label: string, names: readonly string[], maximumBytes: number): CborMap { if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) throw new Error(`invalid ${label} size`); const map = readCborMap(decodeDeterministicCbor(bytes, maximumBytes), label.replaceAll(" ", "_")); rejectUnknownEntries(map, names); return map; }
function readImageMessageVersion(map: CborMap): typeof imageMessageVersion { if (readText(getRequiredEntry(map, "version"), "version") !== imageMessageVersion) throw new Error("unsupported image message version"); return imageMessageVersion; }
function readImageTransferVersion(map: CborMap): typeof imageTransferVersion { if (readText(getRequiredEntry(map, "version"), "version") !== imageTransferVersion) throw new Error("unsupported image transfer version"); return imageTransferVersion; }
function readRasterMediaType(map: CborMap, key: string): RasterImageMediaType { const value = readText(getRequiredEntry(map, key), key); if (!isRasterImageMediaType(value)) throw new Error("unsupported image media type"); return value; }
function token(map: CborMap, key: string, size: number): string { return encodeBase64URL(readBytes(getRequiredEntry(map, key), key, size)); }
function number(map: CborMap, key: string): number { return readUint(getRequiredEntry(map, key), key); }
function readCaption(map: CborMap, key: string): string { const value = readText(getRequiredEntry(map, key), key); validateCaption(value); return value; }
function validateCaption(value: string | undefined): void { if (value !== undefined && (new TextEncoder().encode(value).byteLength > maxImageCaptionBytes || value.trim() === "")) throw new Error("invalid image caption"); }
function tokenIs(value: string, size: number): boolean { try { return decodeBase64URL(value).byteLength === size; } catch { return false; } }
function isSafeTime(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function isBoundedInteger(value: number, minimum: number, maximum: number): boolean { return Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
function shapeFits(width: number, height: number, capabilities: ImageCapabilities): boolean { return width <= capabilities.maxWidth && height <= capabilities.maxHeight && width * height <= capabilities.maxPixels; }
