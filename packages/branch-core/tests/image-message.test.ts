import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  capabilityAllowsImageTransfer,
  capabilityAllowsInlineImage,
  classifyApplicationPayload,
  createApplicationPayloadRegistry,
  decodeImageCapabilities,
  decodeImageTransferChunk,
  decodeImageTransferManifest,
  decodeInlineImage,
  encodeImageCapabilities,
  encodeImageTransferChunk,
  encodeImageTransferManifest,
  encodeApplicationPayload,
  encodeInlineImage,
  encodeBase64URL,
  imageApplicationPayloadDescriptors,
  imageCapabilitiesControlKind,
  imageTransferManifestSigningBytes,
  maxImageTransferManifestBodyBytes,
  maxImagePixels,
  validateImageManifestForMessage,
  validateImageTransferChunkForManifest,
  type ImageCapabilities,
  type ImageTransferManifest,
  type InlineImage
} from "../src/index.js";
import { decodeBase64URL } from "../src/protocol/v0/base64url.js";
import { cborMap, encodeDeterministicCbor } from "../src/protocol/v0/cbor.js";

const fixtureURL = new URL("../../../../testdata/vectors/protocol-v0/image-message-vectors.json", import.meta.url);

test("image message vectors are deterministic and expose compile-time payload descriptors", async () => {
  const fixture = await vectors();
  const inline = inlineImage(fixture.valid.inline);
  const manifest = imageManifest(fixture.valid.manifest);
  const chunk = imageChunk(fixture.valid.chunk);
  const capabilities = imageCapabilities(fixture.valid.capabilities);

  assert.equal(encodeBase64URL(encodeInlineImage(inline)), fixture.valid.inline.canonical_body);
  assert.deepEqual(decodeInlineImage(encodeInlineImage(inline)), inline);
  assert.equal(encodeBase64URL(encodeImageTransferManifest(manifest)), fixture.valid.manifest.canonical_body);
  assert.equal(encodeBase64URL(imageTransferManifestSigningBytes(manifest)), fixture.valid.manifest.signing_bytes);
  assert.deepEqual(decodeImageTransferManifest(encodeImageTransferManifest(manifest)), manifest);
  assert.equal(encodeBase64URL(encodeImageTransferChunk(chunk)), fixture.valid.chunk.canonical_body);
  assert.deepEqual(decodeImageTransferChunk(encodeImageTransferChunk(chunk)), chunk);
  assert.equal(encodeBase64URL(encodeImageCapabilities(capabilities)), fixture.valid.capabilities.canonical_body);
  assert.deepEqual(decodeImageCapabilities(encodeImageCapabilities(capabilities)), capabilities);
  assert.deepEqual(imageApplicationPayloadDescriptors.map((descriptor) => descriptor.requiredCapability), [imageCapabilitiesControlKind, imageCapabilitiesControlKind, imageCapabilitiesControlKind]);
  const envelope = encodeApplicationPayload({ version: "branch.application-payload/0.draft", kind: "branch.image.inline/0.draft", messageId: Buffer.alloc(16, 22).toString("base64url"), body: encodeInlineImage(inline) });
  assert.equal(classifyApplicationPayload(envelope, createApplicationPayloadRegistry([])).status, "unknown_kind");
  assert.equal(classifyApplicationPayload(envelope, createApplicationPayloadRegistry(imageApplicationPayloadDescriptors)).status, "accepted");
  const maximumChunk = encodeImageTransferChunk({ version: "branch.image-transfer/0.draft", transferId: manifest.transferId, manifestId: manifest.manifestId, index: 0, bytes: new Uint8Array(3072).fill(1) });
  assert.ok(maximumChunk.byteLength > 3072 && maximumChunk.byteLength <= 4096);
  assert.equal(classifyApplicationPayload(encodeApplicationPayload({ version: "branch.application-payload/0.draft", kind: "branch.image.transfer.chunk/0.draft", messageId: Buffer.alloc(16, 23).toString("base64url"), body: maximumChunk }), createApplicationPayloadRegistry(imageApplicationPayloadDescriptors)).status, "accepted");
});

test("image capabilities gate automatic inline and live-transfer admission without attachment accept", async () => {
  const fixture = await vectors();
  const inline = inlineImage(fixture.valid.inline);
  const manifest = imageManifest(fixture.valid.manifest);
  const capabilities = imageCapabilities(fixture.valid.capabilities);

  assert.equal(capabilityAllowsInlineImage(capabilities, inline), true);
  assert.equal(capabilityAllowsImageTransfer(capabilities, manifest, "relay"), true);
  assert.equal(capabilityAllowsImageTransfer({ ...capabilities, maxRelayBytes: manifest.byteCount - 1 }, manifest, "relay"), false);
  assert.equal(capabilityAllowsImageTransfer({ ...capabilities, maxPixels: manifest.width * manifest.height - 1 }, manifest, "direct"), false);
});

test("image reply target is an exact authenticated application identity", async () => {
  const fixture = await vectors();
  const replyToMessageId = Buffer.alloc(16, 41).toString("base64url");
  const inline = { ...inlineImage(fixture.valid.inline), replyToMessageId };
  const manifest = { ...imageManifest(fixture.valid.manifest), replyToMessageId };

  assert.equal(decodeInlineImage(encodeInlineImage(inline)).replyToMessageId, replyToMessageId);
  assert.equal(decodeImageTransferManifest(encodeImageTransferManifest(manifest)).replyToMessageId, replyToMessageId);
  assert.throws(() => encodeInlineImage({ ...inline, replyToMessageId: "not-an-application-id" }));
  assert.throws(() => encodeImageTransferManifest({ ...manifest, replyToMessageId: "not-an-application-id" }));
});

test("image transfer manifests accept a full protocol-bounded caption and reject an oversized nested body", async () => {
  const fixture = await vectors();
  const manifest = imageManifest(fixture.valid.manifest);
  const withCaption = { ...manifest, caption: "x".repeat(1_024) };
  const encoded = encodeImageTransferManifest(withCaption);
  assert.ok(encoded.byteLength <= maxImageTransferManifestBodyBytes);
  assert.deepEqual(decodeImageTransferManifest(encoded), withCaption);
  assert.throws(() => decodeImageTransferManifest(new Uint8Array(maxImageTransferManifestBodyBytes + 1)));
});

test("image core rejects hostile image shape, capability and transfer binding values", async () => {
  const fixture = await vectors();
  const inline = inlineImage(fixture.valid.inline);
  const manifest = imageManifest(fixture.valid.manifest);
  const chunk = imageChunk(fixture.valid.chunk);
  const capabilities = imageCapabilities(fixture.valid.capabilities);

  assert.throws(() => encodeInlineImage({ ...inline, mediaType: "image/svg+xml" as never }));
  assert.throws(() => encodeInlineImage({ ...inline, bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]) }));
  assert.throws(() => encodeInlineImage({ ...inline, width: 4097 }));
  assert.throws(() => encodeImageTransferManifest({ ...manifest, width: maxImagePixels, height: 2 }));
  assert.throws(() => validateImageManifestForMessage(manifest, Buffer.alloc(16, 99).toString("base64url")));
  assert.throws(() => validateImageTransferChunkForManifest({ ...chunk, manifestId: Buffer.alloc(32, 99).toString("base64url") }, manifest));
  assert.throws(() => encodeImageCapabilities({ ...capabilities, maxPixels: capabilities.maxWidth * capabilities.maxHeight + 1 }));
  const unknownField = encodeDeterministicCbor(cborMap([
    { key: "version", value: inline.version },
    { key: "media_type", value: inline.mediaType },
    { key: "width", value: inline.width },
    { key: "height", value: inline.height },
    { key: "bytes", value: inline.bytes },
    { key: "url", value: "https://invalid.example/image.png" }
  ]));
  assert.throws(() => decodeInlineImage(unknownField));
});

interface InlineFixture { readonly version: "branch.image-message/0.draft"; readonly media_type: "image/jpeg" | "image/png" | "image/webp"; readonly width: number; readonly height: number; readonly bytes: string; readonly canonical_body: string; }
interface ManifestFixture { readonly version: "branch.image-transfer/0.draft"; readonly transfer_id: string; readonly manifest_id: string; readonly message_id: string; readonly issued_at: number; readonly expires_at: number; readonly media_type: "image/jpeg" | "image/png" | "image/webp"; readonly width: number; readonly height: number; readonly byte_count: number; readonly chunk_bytes: number; readonly chunk_count: number; readonly sha256: string; readonly signature: string; readonly canonical_body: string; readonly signing_bytes: string; }
interface ChunkFixture { readonly version: "branch.image-transfer/0.draft"; readonly transfer_id: string; readonly manifest_id: string; readonly index: number; readonly bytes: string; readonly canonical_body: string; }
interface CapabilityFixture { readonly version: "branch.image-message/0.draft"; readonly max_inline_bytes: number; readonly max_relay_bytes: number; readonly max_direct_bytes: number; readonly max_width: number; readonly max_height: number; readonly max_pixels: number; readonly canonical_body: string; }
interface ImageFixture { readonly valid: { readonly inline: InlineFixture; readonly manifest: ManifestFixture; readonly chunk: ChunkFixture; readonly capabilities: CapabilityFixture; }; }

async function vectors(): Promise<ImageFixture> { return JSON.parse(await readFile(fileURLToPath(fixtureURL), "utf8")) as ImageFixture; }
function inlineImage(value: InlineFixture): InlineImage { return { version: value.version, mediaType: value.media_type, width: value.width, height: value.height, bytes: decodeBase64URL(value.bytes) }; }
function imageManifest(value: ManifestFixture): ImageTransferManifest { return { version: value.version, transferId: value.transfer_id, manifestId: value.manifest_id, messageId: value.message_id, issuedAt: value.issued_at, expiresAt: value.expires_at, mediaType: value.media_type, width: value.width, height: value.height, byteCount: value.byte_count, chunkBytes: value.chunk_bytes, chunkCount: value.chunk_count, sha256: value.sha256, signature: decodeBase64URL(value.signature) }; }
function imageChunk(value: ChunkFixture) { return { version: value.version, transferId: value.transfer_id, manifestId: value.manifest_id, index: value.index, bytes: decodeBase64URL(value.bytes) } as const; }
function imageCapabilities(value: CapabilityFixture): ImageCapabilities { return { version: value.version, maxInlineBytes: value.max_inline_bytes, maxRelayBytes: value.max_relay_bytes, maxDirectBytes: value.max_direct_bytes, maxWidth: value.max_width, maxHeight: value.max_height, maxPixels: value.max_pixels }; }
