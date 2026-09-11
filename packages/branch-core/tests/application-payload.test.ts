import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as branchCore from "../src/index.js";
import { assertContactCardBranchIDBinding, attachmentManifestSigningBytes, branchIDFromPublicKey, classifyApplicationPayload, createApplicationPayloadRegistry, decodeAttachmentChunk, decodeAttachmentDecision, decodeAttachmentManifest, decodeApplicationPayload, decodeContactCard, encodeAttachmentChunk, encodeAttachmentDecision, encodeAttachmentManifest, encodeApplicationPayload, encodeContactCard, inlineBinaryKind, maxInlineBinaryBytes, type AttachmentManifest } from "../src/index.js";
import { decodeBase64URL, encodeBase64URL } from "../src/protocol/v0/base64url.js";

const fixtureURL = new URL("../../../../testdata/vectors/protocol-v0/application-payload-vectors.json", import.meta.url);

test("branch-core root barrel excludes browser-only canvas helpers", () => {
  assert.equal("loadLocalImage" in branchCore, false);
  assert.equal("imageToData" in branchCore, false);
  assert.equal("canvasToPngBlob" in branchCore, false);
});

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

test("attachment decisions canonical-decode through the shared core", () => {
  const decision = {
    version: "branch.attachment/0.draft" as const,
    kind: "accept" as const,
    transferId: Buffer.alloc(16, 1).toString("base64url"),
    manifestId: Buffer.alloc(32, 2).toString("base64url"),
    issuedAt: 1,
    expiresAt: 2,
    signature: new Uint8Array(64)
  };
  const bytes = encodeAttachmentDecision(decision);
  assert.deepEqual(encodeAttachmentDecision(decodeAttachmentDecision(bytes)), bytes);
  assert.throws(() => decodeAttachmentDecision(bytes.subarray(0, bytes.byteLength - 1)));
});

test("live contact-card vector is closed canonical CBOR", async () => {
  const fixture = await vectors();
  const card = fixture.valid.contact_card;
  const encoded = encodeContactCard({
    requestId: card.request_id,
    branchId: card.branch_id,
    peerId: card.peer_id,
    hpkePublicKey: card.hpke_public_key,
    displayName: card.display_name
  });
  assert.equal(encodeBase64URL(encoded), card.canonical_body);
  assert.deepEqual(decodeContactCard(encoded), {
    requestId: card.request_id,
    branchId: card.branch_id,
    peerId: card.peer_id,
    hpkePublicKey: card.hpke_public_key,
    displayName: card.display_name
  });
  assert.throws(() => decodeContactCard(encoded.subarray(0, encoded.byteLength - 1)));
});

test("contact-card BranchID binding is shared, self-certifying, and bounded", async () => {
  const fixture = await vectors();
  const fixtureCard = fixture.valid.contact_card;
  const peerKey = new Uint8Array(32).fill(0x3a);
  const decoded = decodeContactCard(encodeContactCard({
    requestId: fixtureCard.request_id,
    branchId: await branchIDFromPublicKey(peerKey),
    peerId: encodeBase64URL(peerKey),
    hpkePublicKey: fixtureCard.hpke_public_key,
    displayName: fixtureCard.display_name
  }));
  await assert.doesNotReject(assertContactCardBranchIDBinding(decoded));

  await assert.rejects(assertContactCardBranchIDBinding({
    ...decoded,
    peerId: encodeBase64URL(new Uint8Array(32).fill(0xa5))
  }), /contact card branch id mismatch/);

  assert.throws(() => decodeContactCard(new Uint8Array()));
  assert.throws(() => decodeContactCard(new Uint8Array(513)));
});

type FixturePayload = { readonly kind: string; readonly message_id: string; readonly body: string };
type FixtureManifest = { readonly transfer_id: string; readonly manifest_id: string; readonly issued_at: number; readonly expires_at: number; readonly file_name: string; readonly media_type: string; readonly byte_count: number; readonly chunk_bytes: number; readonly chunk_count: number; readonly sha256: string; readonly signature: string };
type FixtureContactCard = { readonly request_id: string; readonly branch_id: string; readonly peer_id: string; readonly hpke_public_key: string; readonly display_name: string; readonly canonical_body: string };
async function vectors(): Promise<{ readonly valid: { readonly text: FixturePayload; readonly inline_binary: FixturePayload; readonly unknown_kind: FixturePayload; readonly manifest: FixtureManifest; readonly first_chunk: { readonly index: number; readonly body: string }; readonly last_chunk: { readonly index: number; readonly body: string }; readonly contact_card: FixtureContactCard } }> { return JSON.parse(await readFile(fileURLToPath(fixtureURL), "utf8")) as Awaited<ReturnType<typeof vectors>>; }
function toPayload(value: FixturePayload) { return { version: "branch.application-payload/0.draft" as const, kind: value.kind, messageId: value.message_id, body: decodeBase64URL(value.body) }; }
function toManifest(value: FixtureManifest): AttachmentManifest { return { version: "branch.attachment/0.draft", transferId: value.transfer_id, manifestId: value.manifest_id, issuedAt: value.issued_at, expiresAt: value.expires_at, fileName: value.file_name, mediaType: value.media_type, byteCount: value.byte_count, chunkBytes: value.chunk_bytes, chunkCount: value.chunk_count, sha256: value.sha256, signature: decodeBase64URL(value.signature) }; }
