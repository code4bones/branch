import { cborMap, decodeDeterministicCbor, encodeDeterministicCbor, getRequiredEntry, readBytes, readCborMap, readText, readUint, rejectUnknownEntries, type CborMap } from "../protocol/v0/cbor.js";
import { decodeBase64URL, encodeBase64URL } from "../protocol/v0/base64url.js";

export const attachmentVersion = "branch.attachment/0.draft" as const;
export const attachmentSignatureDomain = "branch.attachment.signature/0.draft" as const;
export const maxAttachmentChunkBytes = 3_072;
export const maxRelayAttachmentBytes = 4 * 1024 * 1024;
export const maxDirectAttachmentBytes = 16 * 1024 * 1024;
export const maxAttachmentTTLms = 15 * 60 * 1_000;
export const maxAttachmentChunks = 8_192;

export interface AttachmentManifest {
  readonly version: typeof attachmentVersion;
  readonly transferId: string;
  readonly manifestId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteCount: number;
  readonly chunkBytes: number;
  readonly chunkCount: number;
  readonly sha256: string;
  readonly signature: Uint8Array;
}

export interface AttachmentChunk {
  readonly version: typeof attachmentVersion;
  readonly transferId: string;
  readonly manifestId: string;
  readonly index: number;
  readonly bytes: Uint8Array;
}

export type AttachmentDecisionKind = "accept" | "reject" | "cancel";
export interface AttachmentDecision {
  readonly version: typeof attachmentVersion;
  readonly kind: AttachmentDecisionKind;
  readonly transferId: string;
  readonly manifestId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly signature: Uint8Array;
}

export function encodeAttachmentManifest(manifest: AttachmentManifest): Uint8Array { validateManifest(manifest); return encodeDeterministicCbor(manifestMap(manifest, true)); }
export function attachmentManifestSigningBytes(manifest: AttachmentManifest): Uint8Array { validateManifest(manifest); return signed(manifestMap(manifest, false)); }
export function encodeAttachmentDecision(decision: AttachmentDecision): Uint8Array { validateDecision(decision); return encodeDeterministicCbor(decisionMap(decision, true)); }
export function attachmentDecisionSigningBytes(decision: AttachmentDecision): Uint8Array { validateDecision(decision); return signed(decisionMap(decision, false)); }

export function decodeAttachmentManifest(bytes: Uint8Array): AttachmentManifest {
  const map = strictMap(bytes, ["version", "transfer_id", "manifest_id", "issued_at", "expires_at", "file_name", "media_type", "byte_count", "chunk_bytes", "chunk_count", "sha256", "signature"]);
  const result: AttachmentManifest = {
    version: readVersion(map), transferId: token(map, "transfer_id", 16), manifestId: token(map, "manifest_id", 32), issuedAt: number(map, "issued_at"), expiresAt: number(map, "expires_at"), fileName: boundedText(map, "file_name", 160), mediaType: boundedText(map, "media_type", 128), byteCount: number(map, "byte_count"), chunkBytes: number(map, "chunk_bytes"), chunkCount: number(map, "chunk_count"), sha256: token(map, "sha256", 32), signature: readBytes(getRequiredEntry(map, "signature"), "signature", 64)
  };
  validateManifest(result); return result;
}

export function encodeAttachmentChunk(chunk: AttachmentChunk): Uint8Array { validateChunk(chunk); return encodeDeterministicCbor(chunkMap(chunk)); }
export function decodeAttachmentChunk(bytes: Uint8Array): AttachmentChunk {
  const map = strictMap(bytes, ["version", "transfer_id", "manifest_id", "index", "bytes"]);
  const result: AttachmentChunk = { version: readVersion(map), transferId: token(map, "transfer_id", 16), manifestId: token(map, "manifest_id", 32), index: number(map, "index"), bytes: readBytes(getRequiredEntry(map, "bytes"), "bytes") };
  validateChunk(result); return result;
}

export function validateChunkForManifest(chunk: AttachmentChunk, manifest: AttachmentManifest): void {
  validateChunk(chunk); validateManifest(manifest);
  if (chunk.transferId !== manifest.transferId || chunk.manifestId !== manifest.manifestId || chunk.index >= manifest.chunkCount || chunk.bytes.byteLength > manifest.chunkBytes || (chunk.index + 1 < manifest.chunkCount && chunk.bytes.byteLength !== manifest.chunkBytes)) throw new Error("attachment chunk does not match manifest");
}

// WebCrypto belongs to the application adapter boundary. Hashing is async so
// this browser-safe core never imports Node crypto or a relay implementation.
export async function sha256Base64URL(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  return encodeBase64URL(new Uint8Array(await crypto.subtle.digest("SHA-256", input)));
}

function manifestMap(value: AttachmentManifest, signature: boolean): CborMap { const entries = base(value); if (signature) entries.push({ key: "signature", value: value.signature }); return cborMap(entries); }
function base(value: AttachmentManifest) { return [{ key: "version", value: value.version }, { key: "transfer_id", value: decodeBase64URL(value.transferId) }, { key: "manifest_id", value: decodeBase64URL(value.manifestId) }, { key: "issued_at", value: value.issuedAt }, { key: "expires_at", value: value.expiresAt }, { key: "file_name", value: value.fileName }, { key: "media_type", value: value.mediaType }, { key: "byte_count", value: value.byteCount }, { key: "chunk_bytes", value: value.chunkBytes }, { key: "chunk_count", value: value.chunkCount }, { key: "sha256", value: decodeBase64URL(value.sha256) }]; }
function decisionMap(value: AttachmentDecision, signature: boolean): CborMap { const entries = [{ key: "version", value: value.version }, { key: "kind", value: value.kind }, { key: "transfer_id", value: decodeBase64URL(value.transferId) }, { key: "manifest_id", value: decodeBase64URL(value.manifestId) }, { key: "issued_at", value: value.issuedAt }, { key: "expires_at", value: value.expiresAt }]; if (signature) entries.push({ key: "signature", value: value.signature }); return cborMap(entries); }
function chunkMap(value: AttachmentChunk): CborMap { return cborMap([{ key: "version", value: value.version }, { key: "transfer_id", value: decodeBase64URL(value.transferId) }, { key: "manifest_id", value: decodeBase64URL(value.manifestId) }, { key: "index", value: value.index }, { key: "bytes", value: value.bytes }]); }
function signed(map: CborMap): Uint8Array { const prefix = new TextEncoder().encode(`${attachmentSignatureDomain}\0`); const body = encodeDeterministicCbor(map); const result = new Uint8Array(prefix.byteLength + body.byteLength); result.set(prefix); result.set(body, prefix.byteLength); return result; }
function strictMap(bytes: Uint8Array, names: readonly string[]): CborMap { if (bytes.byteLength === 0 || bytes.byteLength > 4_096) throw new Error("invalid attachment size"); const map = readCborMap(decodeDeterministicCbor(bytes, 4_096), "attachment"); rejectUnknownEntries(map, names); return map; }
function readVersion(map: CborMap): typeof attachmentVersion { if (readText(getRequiredEntry(map, "version"), "version") !== attachmentVersion) throw new Error("unsupported attachment version"); return attachmentVersion; }
function token(map: CborMap, name: string, size: number): string { return encodeBase64URL(readBytes(getRequiredEntry(map, name), name, size)); }
function number(map: CborMap, name: string): number { return readUint(getRequiredEntry(map, name), name); }
function boundedText(map: CborMap, name: string, max: number): string { const value = readText(getRequiredEntry(map, name), name); if (new TextEncoder().encode(value).byteLength > max) throw new Error(`invalid ${name}`); return value; }
function validateManifest(value: AttachmentManifest): void { if (value.version !== attachmentVersion || !validToken(value.transferId, 16) || !validToken(value.manifestId, 32) || !validToken(value.sha256, 32) || value.signature.byteLength !== 64 || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > maxAttachmentTTLms || value.byteCount < 1 || value.byteCount > maxDirectAttachmentBytes || value.chunkBytes < 256 || value.chunkBytes > maxAttachmentChunkBytes || value.chunkCount < 1 || value.chunkCount > maxAttachmentChunks || value.chunkCount !== Math.ceil(value.byteCount / value.chunkBytes) || new TextEncoder().encode(value.fileName).byteLength === 0 || new TextEncoder().encode(value.fileName).byteLength > 160 || new TextEncoder().encode(value.mediaType).byteLength === 0 || new TextEncoder().encode(value.mediaType).byteLength > 128) throw new Error("invalid attachment manifest"); }
function validateDecision(value: AttachmentDecision): void { if (value.version !== attachmentVersion || !["accept", "reject", "cancel"].includes(value.kind) || !validToken(value.transferId, 16) || !validToken(value.manifestId, 32) || value.signature.byteLength !== 64 || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > maxAttachmentTTLms) throw new Error("invalid attachment decision"); }
function validateChunk(value: AttachmentChunk): void { if (value.version !== attachmentVersion || !validToken(value.transferId, 16) || !validToken(value.manifestId, 32) || !Number.isSafeInteger(value.index) || value.index < 0 || value.bytes.byteLength === 0 || value.bytes.byteLength > maxAttachmentChunkBytes) throw new Error("invalid attachment chunk"); }
function validToken(value: string, size: number): boolean { try { return decodeBase64URL(value).byteLength === size; } catch { return false; } }
