import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { attachmentManifestSigningBytes, classifyApplicationPayload, createApplicationPayloadRegistry, decodeAttachmentChunk, decodeAttachmentManifest, decodeApplicationPayload, encodeAttachmentChunk, encodeAttachmentManifest, encodeApplicationPayload, inlineBinaryKind, maxInlineBinaryBytes, type AttachmentManifest } from "../src/index.js";
import { decodeBase64URL, encodeBase64URL } from "../src/protocol/v0/base64url.js";

const fixtureURL = new URL("../../../../testdata/vectors/protocol-v0/application-payload-vectors.json", import.meta.url);

test("shared application payload vectors are canonical and unknown kinds are inert", async () => {
  const fixture = await vectors();
  const registry = createApplicationPayloadRegistry([
    { kind: "branch.chat.text/0.draft", maximumBodyBytes: 3_000, requiredCapability: "application.payloads/0.draft" },
    { kind: inlineBinaryKind, maximumBodyBytes: maxInlineBinaryBytes, requiredCapability: "application.payloads/0.draft" }
  ]);
  const text = toPayload(fixture.valid.text);
  const bytes = encodeApplicationPayload(text);
  assert.deepEqual(encodeApplicationPayload(decodeApplicationPayload(bytes)), bytes);
  assert.equal(classifyApplicationPayload(bytes, registry).status, "accepted");
  const unknown = classifyApplicationPayload(encodeApplicationPayload(toPayload(fixture.valid.unknown_kind)), registry);
  assert.equal(unknown.status, "unknown_kind");
  assert.throws(() => classifyApplicationPayload(encodeApplicationPayload({ ...toPayload(fixture.valid.inline_binary), body: new Uint8Array(maxInlineBinaryBytes + 1) }), registry));
});

test("shared attachment vectors bind chunks to one signed bounded manifest", async () => {
  const fixture = await vectors();
  const manifest = toManifest(fixture.valid.manifest);
  assert.deepEqual(encodeAttachmentManifest(decodeAttachmentManifest(encodeAttachmentManifest(manifest))), encodeAttachmentManifest(manifest));
  assert.ok(attachmentManifestSigningBytes(manifest).byteLength > 0);
  const first = decodeAttachmentChunk(encodeAttachmentChunk({ version: "branch.attachment/0.draft", transferId: manifest.transferId, manifestId: manifest.manifestId, index: fixture.valid.first_chunk.index, bytes: new Uint8Array(manifest.chunkBytes).fill(decodeBase64URL(fixture.valid.first_chunk.body)[0] ?? 0) }));
  const last = decodeAttachmentChunk(encodeAttachmentChunk({ version: "branch.attachment/0.draft", transferId: manifest.transferId, manifestId: manifest.manifestId, index: fixture.valid.last_chunk.index, bytes: decodeBase64URL(fixture.valid.last_chunk.body) }));
  const { validateChunkForManifest } = await import("../src/application-payload/attachment.js");
  validateChunkForManifest(first, manifest);
  validateChunkForManifest(last, manifest);
  assert.throws(() => validateChunkForManifest({ ...first, manifestId: encodeBase64URL(new Uint8Array(32).fill(10)) }, manifest));
  assert.throws(() => decodeAttachmentManifest(encodeAttachmentManifest({ ...manifest, expiresAt: manifest.issuedAt + 900_001 })));
});

type FixturePayload = { readonly kind: string; readonly message_id: string; readonly body: string };
type FixtureManifest = { readonly transfer_id: string; readonly manifest_id: string; readonly issued_at: number; readonly expires_at: number; readonly file_name: string; readonly media_type: string; readonly byte_count: number; readonly chunk_bytes: number; readonly chunk_count: number; readonly sha256: string; readonly signature: string };
async function vectors(): Promise<{ readonly valid: { readonly text: FixturePayload; readonly inline_binary: FixturePayload; readonly unknown_kind: FixturePayload; readonly manifest: FixtureManifest; readonly first_chunk: { readonly index: number; readonly body: string }; readonly last_chunk: { readonly index: number; readonly body: string } } }> { return JSON.parse(await readFile(fileURLToPath(fixtureURL), "utf8")) as Awaited<ReturnType<typeof vectors>>; }
function toPayload(value: FixturePayload) { return { version: "branch.application-payload/0.draft" as const, kind: value.kind, messageId: value.message_id, body: decodeBase64URL(value.body) }; }
function toManifest(value: FixtureManifest): AttachmentManifest { return { version: "branch.attachment/0.draft", transferId: value.transfer_id, manifestId: value.manifest_id, issuedAt: value.issued_at, expiresAt: value.expires_at, fileName: value.file_name, mediaType: value.media_type, byteCount: value.byte_count, chunkBytes: value.chunk_bytes, chunkCount: value.chunk_count, sha256: value.sha256, signature: decodeBase64URL(value.signature) }; }
