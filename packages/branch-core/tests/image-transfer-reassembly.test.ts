import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  decodeBase64URL,
  ImageTransferReassemblyRegistry,
  sha256Base64URL,
  type ImageTransferChunk,
  type ImageTransferManifest
} from "../src/index.js";

const fixtureURL = new URL("../../testdata/image-transfer-reassembly-vectors.json", import.meta.url);
const now = 1_700_000_000_000;

test("image transfer reassembly vectors accept reordered exact chunks and retain bounded replay rejection", async () => {
  const fixture = await vectors();
  const manifest = vectorManifest(fixture.valid);
  const chunk = seededChunk(fixture.valid);
  const registry = new ImageTransferReassemblyRegistry({ sha256Base64URL });

  assert.deepEqual(registry.open(fixture.valid.peer_id, manifest, now), { status: "opened" });
  assert.deepEqual(await registry.receiveChunk(fixture.valid.peer_id, { ...chunk, index: 1 }, now), { status: "chunk_stored" });
  const complete = await registry.receiveChunk(fixture.valid.peer_id, chunk, now);
  assert.equal(complete.status, "completed");
  if (complete.status !== "completed") throw new Error("expected completed image reassembly");
  assert.equal(complete.bytes.byteLength, manifest.byteCount);
  assert.equal(await sha256Base64URL(complete.bytes), fixture.valid.sha256);
  assert.deepEqual(registry.open(fixture.valid.peer_id, manifest, now), { status: "replayed", reason: "no_transfer" });
});

test("image transfer reassembly rejects hostile duplicate, range and reorder inputs without retaining chunks", async () => {
  const fixture = await vectors();
  const manifest = vectorManifest(fixture.valid);
  const chunk = seededChunk(fixture.valid);

  const conflict = new ImageTransferReassemblyRegistry({ sha256Base64URL });
  assert.equal(conflict.open("peer-conflict", manifest, now).status, "opened");
  assert.equal((await conflict.receiveChunk("peer-conflict", chunk, now)).status, "chunk_stored");
  const conflictingBytes = new Uint8Array(chunk.bytes);
  conflictingBytes[0] = 8;
  assert.deepEqual(await conflict.receiveChunk("peer-conflict", { ...chunk, bytes: conflictingBytes }, now), { status: "aborted", reason: "conflicting_duplicate" });

  const range = new ImageTransferReassemblyRegistry({ sha256Base64URL });
  assert.equal(range.open("peer-range", manifest, now).status, "opened");
  assert.deepEqual(await range.receiveChunk("peer-range", { ...chunk, index: manifest.chunkCount }, now), { status: "aborted", reason: "invalid_chunk" });

  const reorder = new ImageTransferReassemblyRegistry({ sha256Base64URL }, { maximumReorderChunks: 0 });
  assert.equal(reorder.open("peer-reorder", manifest, now).status, "opened");
  assert.deepEqual(await reorder.receiveChunk("peer-reorder", { ...chunk, index: 1 }, now), { status: "aborted", reason: "reorder_limit" });

  const digestMismatch = new ImageTransferReassemblyRegistry({ sha256Base64URL: async () => "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
  assert.equal(digestMismatch.open("peer-digest", manifest, now).status, "opened");
  assert.equal((await digestMismatch.receiveChunk("peer-digest", chunk, now)).status, "chunk_stored");
  assert.deepEqual(await digestMismatch.receiveChunk("peer-digest", { ...chunk, index: 1 }, now), { status: "aborted", reason: "integrity_failed" });
});

interface ReassemblyFixture {
  readonly valid: {
    readonly peer_id: string;
    readonly transfer_id: string;
    readonly manifest_id: string;
    readonly message_id: string;
    readonly issued_at: number;
    readonly expires_at: number;
    readonly chunk_seed_base64url: string;
    readonly chunk_repeat: number;
    readonly chunk_count: number;
    readonly sha256: string;
  };
}

async function vectors(): Promise<ReassemblyFixture> {
  return JSON.parse(await readFile(fileURLToPath(fixtureURL), "utf8")) as ReassemblyFixture;
}

function vectorManifest(value: ReassemblyFixture["valid"]): ImageTransferManifest {
  return {
    version: "branch.image-transfer/0.draft",
    transferId: value.transfer_id,
    manifestId: value.manifest_id,
    messageId: value.message_id,
    issuedAt: value.issued_at,
    expiresAt: value.expires_at,
    mediaType: "image/png",
    width: 1,
    height: 1,
    byteCount: value.chunk_repeat * value.chunk_count,
    chunkBytes: value.chunk_repeat,
    chunkCount: value.chunk_count,
    sha256: value.sha256,
    signature: new Uint8Array(64)
  };
}

function seededChunk(value: ReassemblyFixture["valid"]): ImageTransferChunk {
  const seed = decodeBase64URL(value.chunk_seed_base64url);
  assert.equal(seed.byteLength, 1);
  return {
    version: "branch.image-transfer/0.draft",
    transferId: value.transfer_id,
    manifestId: value.manifest_id,
    index: 0,
    bytes: new Uint8Array(value.chunk_repeat).fill(seed[0]!)
  };
}
