import assert from "node:assert/strict";
import test from "node:test";

import {
  AttachmentTransferState,
  AttachmentTransferRegistry,
  type AttachmentChunk,
  type AttachmentDecision,
  type AttachmentManifest
} from "../src/index.js";
import { encodeBase64URL } from "../src/protocol/v0/base64url.js";

const now = 1_700_000_000_000;
const digest = { async sha256Base64URL(bytes: Uint8Array): Promise<string> { const input = new Uint8Array(bytes.byteLength); input.set(bytes); return encodeBase64URL(new Uint8Array(await crypto.subtle.digest("SHA-256", input))); } };

test("an inbound transfer needs acceptance, tolerates bounded reorder, and verifies the exact completed file", async () => {
  const bytes = sampleBytes(513);
  const manifest = await sampleManifest(bytes, 256);
  const transfer = AttachmentTransferState.open("inbound", manifest, digest, { maximumReorderChunks: 2 }, now);
  assert.equal((await transfer.receiveChunk(chunk(manifest, 0, bytes.slice(0, 256)), now)).status, "ignored");
  assert.equal(transfer.accept(decision(manifest, "accept"), now).status, "accepted");
  assert.equal((await transfer.receiveChunk(chunk(manifest, 1, bytes.slice(256, 512)), now)).status, "chunk_stored");
  assert.equal((await transfer.receiveChunk(chunk(manifest, 0, bytes.slice(0, 256)), now)).status, "chunk_stored");
  const completed = await transfer.receiveChunk(chunk(manifest, 2, bytes.slice(512)), now);
  assert.equal(completed.status, "completed");
  if (completed.status === "completed") assert.deepEqual(completed.bytes, bytes);
  assert.equal(transfer.phase, "completed");
});

test("a conflicting replay aborts and releases buffered attachment bytes", async () => {
  const bytes = sampleBytes(512);
  const manifest = await sampleManifest(bytes, 256);
  const transfer = AttachmentTransferState.open("inbound", manifest, digest, {}, now);
  transfer.accept(decision(manifest, "accept"), now);
  await transfer.receiveChunk(chunk(manifest, 0, bytes.slice(0, 256)), now);
  const result = await transfer.receiveChunk(chunk(manifest, 0, new Uint8Array(256).fill(9)), now);
  assert.deepEqual(result, { status: "aborted", phase: "aborted", reason: "conflicting_duplicate" });
  assert.equal(transfer.snapshot().receivedBytes, 0);
});

test("reorder, cancellation, expiry, and sender acceptance remain bounded live state", async () => {
  const bytes = sampleBytes(768);
  const manifest = await sampleManifest(bytes, 256);
  const inbound = AttachmentTransferState.open("inbound", manifest, digest, { maximumReorderChunks: 1 }, now);
  inbound.accept(decision(manifest, "accept"), now);
  assert.deepEqual(await inbound.receiveChunk(chunk(manifest, 2, bytes.slice(512)), now), { status: "aborted", phase: "aborted", reason: "reorder_limit" });

  const outbound = AttachmentTransferState.open("outbound", manifest, digest, {}, now);
  assert.equal(outbound.admitOutboundChunk(chunk(manifest, 0, bytes.slice(0, 256)), now).status, "ignored");
  assert.equal(outbound.receiveDecision(decision(manifest, "accept"), now).status, "accepted");
  assert.equal(outbound.admitOutboundChunk(chunk(manifest, 0, bytes.slice(0, 256)), now).status, "chunk_stored");
  assert.deepEqual(outbound.cancel(decision(manifest, "cancel"), now), { status: "cancelled", phase: "cancelled", reason: "cancelled" });

  const expired = AttachmentTransferState.open("inbound", manifest, digest, {}, now);
  assert.deepEqual(expired.expire(manifest.expiresAt), { status: "expired", phase: "expired", reason: "expired" });
});

test("a peer-direction registry permits one active transfer and remembers terminal replay only within a bound", async () => {
  const bytes = sampleBytes(256);
  const first = await sampleManifest(bytes, 256);
  const second = { ...await sampleManifest(bytes, 256), transferId: encodeBase64URL(new Uint8Array(16).fill(3)) };
  const registry = new AttachmentTransferRegistry("inbound", digest, { maximumRememberedTransfers: 1 });
  const opened = registry.open(first, now);
  assert.equal(opened.status, "opened");
  assert.equal(registry.open(second, now).status, "busy");
  if (opened.status !== "opened") throw new Error("expected transfer");
  opened.transfer.cancel(decision(first, "cancel"), now);
  assert.equal(registry.open(first, now).status, "replayed");
  assert.equal(registry.open(second, now).status, "opened");
});

async function sampleManifest(bytes: Uint8Array, chunkBytes: number): Promise<AttachmentManifest> {
  return {
    version: "branch.attachment/0.draft",
    transferId: encodeBase64URL(new Uint8Array(16).fill(1)),
    manifestId: encodeBase64URL(new Uint8Array(32).fill(2)),
    issuedAt: now - 1,
    expiresAt: now + 60_000,
    fileName: "sample.bin",
    mediaType: "application/octet-stream",
    byteCount: bytes.byteLength,
    chunkBytes,
    chunkCount: Math.ceil(bytes.byteLength / chunkBytes),
    sha256: await digest.sha256Base64URL(bytes),
    signature: new Uint8Array(64)
  };
}

function decision(manifest: AttachmentManifest, kind: AttachmentDecision["kind"]): AttachmentDecision {
  return { version: "branch.attachment/0.draft", kind, transferId: manifest.transferId, manifestId: manifest.manifestId, issuedAt: now - 1, expiresAt: now + 60_000, signature: new Uint8Array(64) };
}

function chunk(manifest: AttachmentManifest, index: number, bytes: Uint8Array): AttachmentChunk {
  return { version: "branch.attachment/0.draft", transferId: manifest.transferId, manifestId: manifest.manifestId, index, bytes };
}

function sampleBytes(length: number): Uint8Array { return Uint8Array.from({ length }, (_, index) => index % 251); }
