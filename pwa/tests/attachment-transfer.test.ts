import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applicationPayloadVersion,
  attachmentDecisionSigningBytes,
  decodeApplicationPayload,
  decodeAttachmentChunk,
  decodeAttachmentDecision,
  decodeAttachmentManifest,
  encodeAttachmentChunk,
  encodeAttachmentDecision,
  encodeApplicationPayload,
  encodeAttachmentManifest,
  encodeBase64URL,
  sha256Base64URL,
  type ApplicationCapabilities,
  type AttachmentManifest
} from "@code4bones/branch-core";

import {
  AttachmentTransferController,
  attachmentChunkKind,
  attachmentDecisionKind,
  attachmentManifestKind,
  createSignedAttachmentDecision,
  createSignedAttachmentManifest,
  type AttachmentControllerEvent,
  type InboundAttachmentOffer,
  type AttachmentSendRequest,
  type AttachmentTimerPort,
  type AttachmentTransferPorts
} from "../src/connectivity/attachment-transfer.js";

const now = 1_700_000_000_000;
const peerId = "known-peer";

interface TimerHandle {
  readonly delayMs: number;
  readonly callback: () => void;
  active: boolean;
}

class FakeTimers implements AttachmentTimerPort {
  readonly #handles: TimerHandle[] = [];

  schedule(delayMs: number, callback: () => void): TimerHandle {
    const handle: TimerHandle = { delayMs, callback, active: true };
    this.#handles.push(handle);
    return handle;
  }

  cancel(handle: unknown): void {
    if (isTimerHandle(handle)) handle.active = false;
  }

  fireOne(delayMs: number): boolean {
    const handle = this.#handles.find((candidate) => candidate.active && candidate.delayMs === delayMs);
    if (handle === undefined) return false;
    handle.active = false;
    handle.callback();
    return true;
  }

  active(delayMs: number): number {
    return this.#handles.filter((handle) => handle.active && handle.delayMs === delayMs).length;
  }
}

interface Harness {
  readonly controller: AttachmentTransferController;
  readonly sent: AttachmentSendRequest[];
  readonly events: AttachmentControllerEvent[];
  readonly timers: FakeTimers;
  readonly local: CryptoKeyPair;
  readonly remote: CryptoKeyPair;
  readonly completed: Array<{ readonly offer: InboundAttachmentOffer; readonly bytes: Uint8Array }>;
}

async function harness(options: { readonly known?: boolean; readonly trustedRemote?: CryptoKey; readonly capabilities?: ApplicationCapabilities } = {}): Promise<Harness> {
  const local = await signingKeys();
  const remote = await signingKeys();
  const sent: AttachmentSendRequest[] = [];
  const events: AttachmentControllerEvent[] = [];
  const completed: Array<{ readonly offer: InboundAttachmentOffer; readonly bytes: Uint8Array }> = [];
  const timers = new FakeTimers();
  let randomCounter = 0;
  const capabilities: ApplicationCapabilities = {
    applicationVersions: [applicationPayloadVersion],
    kinds: [attachmentChunkKind, attachmentDecisionKind, attachmentManifestKind],
    maxInlineBytes: 3_000,
    attachmentMode: "receiver-accept",
    maxRelayAttachmentBytes: 4 * 1024 * 1024,
    maxDirectAttachmentBytes: 4 * 1024 * 1024
  };
  const ports: AttachmentTransferPorts = {
    now: () => now,
    randomBytes: (bytes) => {
      for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = (randomCounter + index) & 0xff;
      randomCounter += bytes.byteLength;
      return bytes;
    },
    localPeerId: () => "local-peer",
    localSigningKey: () => local.privateKey,
    isKnownPeer: (candidate) => options.known ?? true ? candidate === peerId : false,
    knownPeerSigningKey: (candidate) => candidate === peerId ? options.trustedRemote ?? remote.publicKey : null,
    peerCapabilities: (candidate) => candidate === peerId ? options.capabilities ?? capabilities : null,
    send: (request) => { sent.push(request); },
    timers,
    onInboundComplete: (offer, bytes) => { completed.push({ offer, bytes }); },
    onEvent: (event) => { events.push(event); }
  };
  return { controller: new AttachmentTransferController(ports), sent, events, timers, local, remote, completed };
}

void test("attachment offer is explicitly accepted and the decision uses the shared canonical decoder", async () => {
  const fixture = await harness();
  const manifest = await signedManifest(fixture.remote.privateKey, new Uint8Array([1, 2, 3]));

  const received = await fixture.controller.receive(peerId, applicationEnvelope(attachmentManifestKind, encodeAttachmentManifest(manifest)));
  assert.deepEqual(received, { status: "handled", kind: attachmentManifestKind });
  assert.equal(fixture.sent.length, 0, "the receiver must not accept or send chunks automatically");

  assert.deepEqual(await fixture.controller.accept(peerId), { status: "sent" });
  assert.equal(fixture.sent.length, 1);
  const decisionPayload = decodeApplicationPayload(required(fixture.sent[0]).plaintext);
  assert.equal(decisionPayload.kind, attachmentDecisionKind);
  const decision = decodeAttachmentDecision(decisionPayload.body);
  assert.equal(decision.kind, "accept");
  assert.equal(decision.transferId, manifest.transferId);
  assert.equal(decision.manifestId, manifest.manifestId);
  assert.ok(await crypto.subtle.verify("Ed25519", fixture.local.publicKey, arrayBuffer(decision.signature), arrayBuffer(attachmentDecisionSigningBytes(decision))));
});

void test("attachment input rejects unknown peers and manifests whose signer is not the admitted peer", async () => {
  const fixture = await harness();
  const manifest = await signedManifest(fixture.remote.privateKey, new Uint8Array([5]));
  const payload = applicationEnvelope(attachmentManifestKind, encodeAttachmentManifest(manifest));

  assert.deepEqual(await fixture.controller.receive("unadmitted-peer", payload), { status: "ignored", reason: "unknown_peer" });

  const untrusted = await signingKeys();
  const invalidSignatureFixture = await harness({ trustedRemote: untrusted.publicKey });
  assert.deepEqual(await invalidSignatureFixture.controller.receive(peerId, payload), { status: "ignored", reason: "invalid_signature" });
  assert.equal(invalidSignatureFixture.sent.length, 0);
});

void test("attachment offers require a current receiver-accept relay capability and never read an over-limit File", async () => {
  const unsupported: ApplicationCapabilities = {
    applicationVersions: [applicationPayloadVersion],
    kinds: [attachmentChunkKind, attachmentDecisionKind, attachmentManifestKind],
    maxInlineBytes: 3_000,
    attachmentMode: "none",
    maxRelayAttachmentBytes: 0,
    maxDirectAttachmentBytes: 0
  };
  const fixture = await harness({ capabilities: unsupported });
  assert.deepEqual(fixture.controller.canOffer(peerId), { status: "rejected", reason: "unsupported" });
  const file = new File([new Uint8Array([1])], "not-offered.bin");
  assert.deepEqual(await fixture.controller.offer(peerId, file), { status: "rejected", reason: "unsupported" });
  assert.equal(fixture.sent.length, 0);

  const supported = await harness();
  assert.deepEqual(supported.controller.canOffer(peerId), { status: "ready", maximumBytes: 4 * 1024 * 1024 });
  const empty = new File([], "empty.bin");
  assert.deepEqual(await supported.controller.offer(peerId, empty), { status: "rejected", reason: "unsupported" });
  assert.equal(supported.sent.length, 0);

  const tooLarge = new File([new Uint8Array(4 * 1024 * 1024 + 1)], "too-large.bin");
  assert.deepEqual(await supported.controller.offer(peerId, tooLarge), { status: "rejected", reason: "unsupported" });
  assert.equal(supported.sent.length, 0);
});

void test("receiver rejection, expiry, and final digest failure all release inbound live state", async () => {
  const rejected = await harness();
  const rejectManifest = await signedManifest(rejected.remote.privateKey, new Uint8Array([1]));
  await rejected.controller.receive(peerId, applicationEnvelope(attachmentManifestKind, encodeAttachmentManifest(rejectManifest)));
  assert.deepEqual(await rejected.controller.reject(peerId), { status: "sent" });
  assert.equal(decodeAttachmentDecision(decodeApplicationPayload(required(rejected.sent[0]).plaintext).body).kind, "reject");
  assert.deepEqual(await rejected.controller.accept(peerId), { status: "rejected", reason: "busy" });

  const expired = await harness();
  const expiryManifest = await createSignedAttachmentManifest({
    transferId: token(16, 40), manifestId: token(32, 60), issuedAt: now, expiresAt: now + 1,
    fileName: "expires.bin", mediaType: "application/octet-stream", byteCount: 1, chunkBytes: 256, chunkCount: 1,
    sha256: await sha256Base64URL(new Uint8Array([1]))
  }, expired.remote.privateKey);
  await expired.controller.receive(peerId, applicationEnvelope(attachmentManifestKind, encodeAttachmentManifest(expiryManifest)));
  assert.equal(expired.timers.fireOne(1), true);
  assert.deepEqual(await expired.controller.accept(peerId), { status: "rejected", reason: "busy" });

  const corrupted = await harness();
  const integrityManifest = await signedManifest(corrupted.remote.privateKey, new Uint8Array([1]));
  await corrupted.controller.receive(peerId, applicationEnvelope(attachmentManifestKind, encodeAttachmentManifest(integrityManifest)));
  await corrupted.controller.accept(peerId);
  assert.deepEqual(
    await corrupted.controller.receive(peerId, applicationEnvelope(attachmentChunkKind, encodeChunk(integrityManifest, new Uint8Array([2])))),
    { status: "handled", kind: attachmentChunkKind }
  );
  assert.equal(corrupted.events.at(-1)?.reason, "integrity_failed");
  assert.equal(corrupted.completed.length, 0, "a mismatched digest must never reach the completion callback");
  assert.deepEqual(await corrupted.controller.accept(peerId), { status: "rejected", reason: "busy" });

  const cancelled = await harness();
  assert.equal((await cancelled.controller.offer(peerId, new File([new Uint8Array([4])], "cancel.bin"))).status, "offered");
  assert.deepEqual(await cancelled.controller.cancel(peerId, "outbound"), { status: "sent" });
  const cancelRequest = required(cancelled.sent.at(-1));
  assert.equal(decodeAttachmentDecision(decodeApplicationPayload(cancelRequest.plaintext).body).kind, "cancel");
  assert.equal(cancelled.controller.onRelayForwarded(required(cancelled.sent[0]).deliveryId), false);
});

void test("only accepted, full-digest-verified inbound bytes reach the one-shot completion callback", async () => {
  const fixture = await harness();
  const bytes = new Uint8Array([8, 6, 7, 5, 3, 0, 9]);
  const manifest = await signedManifest(fixture.remote.privateKey, bytes);
  await fixture.controller.receive(peerId, applicationEnvelope(attachmentManifestKind, encodeAttachmentManifest(manifest)));

  await fixture.controller.receive(peerId, applicationEnvelope(attachmentChunkKind, encodeChunk(manifest, bytes)));
  assert.equal(fixture.completed.length, 0, "chunks before explicit acceptance are not delivered");

  assert.deepEqual(await fixture.controller.accept(peerId), { status: "sent" });
  await fixture.controller.receive(peerId, applicationEnvelope(attachmentChunkKind, encodeChunk(manifest, bytes)));
  assert.equal(fixture.completed.length, 1);
  assert.equal(required(fixture.completed[0]).offer.peerId, peerId);
  assert.equal(required(fixture.completed[0]).offer.manifest.transferId, manifest.transferId);
  assert.deepEqual(required(fixture.completed[0]).bytes, bytes);
  assert.deepEqual(await fixture.controller.accept(peerId), { status: "rejected", reason: "busy" });
});

void test("outbound transfers open no chunks before explicit remote accept and keep a four-chunk forwarded window", async () => {
  const fixture = await harness();
  const bytes = new Uint8Array(3_072 * 5);
  bytes.fill(42);
  const result = await fixture.controller.offer(peerId, new File([bytes], "five-chunks.bin", { type: "application/octet-stream" }));
  assert.equal(result.status, "offered");
  assert.equal(fixture.sent.length, 1);
  const offeredRequest = required(fixture.sent[0]);
  const offered = decodeApplicationPayload(offeredRequest.plaintext);
  assert.equal(offered.kind, attachmentManifestKind);
  const manifest = decodeAttachmentManifest(offered.body);

  assert.equal(fixture.controller.onRelayForwarded(offeredRequest.deliveryId), true);
  const acceptance = await createSignedAttachmentDecision({
    kind: "accept",
    transferId: manifest.transferId,
    manifestId: manifest.manifestId,
    issuedAt: now,
    expiresAt: now + 60_000
  }, fixture.remote.privateKey);
  assert.deepEqual(
    await fixture.controller.receive(peerId, applicationEnvelope(attachmentDecisionKind, encodeAttachmentDecision(acceptance))),
    { status: "handled", kind: attachmentDecisionKind }
  );
  await settle();

  const chunks = sentByKind(fixture.sent, attachmentChunkKind);
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks.map((request) => decodeChunkIndex(request)), [0, 1, 2, 3]);
  assert.equal(fixture.timers.active(12_000), 4);

  assert.equal(fixture.controller.onRelayForwarded(required(chunks[0]).deliveryId), true);
  await settle();
  const refilled = sentByKind(fixture.sent, attachmentChunkKind);
  assert.equal(refilled.length, 5);
  assert.equal(decodeChunkIndex(required(refilled[4])), 4);
  assert.equal(fixture.timers.active(12_000), 4);
});

void test("lost forwarded acknowledgement terminates volatile state and never auto-resumes or re-offers", async () => {
  const fixture = await harness();
  const result = await fixture.controller.offer(peerId, new File([new Uint8Array(3_072 * 5)], "lost-ack.bin"));
  assert.equal(result.status, "offered");
  const offeredRequest = required(fixture.sent[0]);
  const manifest = decodeAttachmentManifest(decodeApplicationPayload(offeredRequest.plaintext).body);
  fixture.controller.onRelayForwarded(offeredRequest.deliveryId);
  const acceptance = await createSignedAttachmentDecision({
    kind: "accept",
    transferId: manifest.transferId,
    manifestId: manifest.manifestId,
    issuedAt: now,
    expiresAt: now + 60_000
  }, fixture.remote.privateKey);
  await fixture.controller.receive(peerId, applicationEnvelope(attachmentDecisionKind, encodeAttachmentDecision(acceptance)));
  await settle();
  assert.equal(sentByKind(fixture.sent, attachmentChunkKind).length, 4);

  assert.equal(fixture.timers.fireOne(12_000), true);
  await settle();
  assert.equal(fixture.events.at(-1)?.event, "attachment.transfer.ended");
  assert.equal(fixture.events.at(-1)?.reason, "ack_timeout");
  assert.equal(fixture.timers.active(12_000), 0);
  const sentBeforeLateAck = fixture.sent.length;
  for (const request of sentByKind(fixture.sent, attachmentChunkKind)) fixture.controller.onRelayForwarded(request.deliveryId);
  await settle();
  assert.equal(fixture.sent.length, sentBeforeLateAck, "a late ACK must not restart chunks or recreate an offer");
});

void test("relay loss destroys live transfer state without retrying it after stale timer activity", async () => {
  const fixture = await harness();
  assert.equal((await fixture.controller.offer(peerId, new File([new Uint8Array([7])], "disconnect.bin"))).status, "offered");
  const sentBeforeLoss = fixture.sent.length;
  fixture.controller.unavailable(peerId);
  assert.equal(fixture.events.at(-1)?.reason, "unavailable");
  assert.equal(fixture.timers.active(12_000), 0);
  assert.equal(fixture.timers.fireOne(12_000), false);
  await settle();
  assert.equal(fixture.sent.length, sentBeforeLoss);
});

async function signingKeys(): Promise<CryptoKeyPair> {
  const generated = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  assert.ok("privateKey" in generated);
  return generated;
}

async function signedManifest(privateKey: CryptoKey, bytes: Uint8Array): Promise<AttachmentManifest> {
  return createSignedAttachmentManifest({
    transferId: token(16, 3),
    manifestId: token(32, 20),
    issuedAt: now,
    expiresAt: now + 60_000,
    fileName: "received.bin",
    mediaType: "application/octet-stream",
    byteCount: bytes.byteLength,
    chunkBytes: 256,
    chunkCount: Math.ceil(bytes.byteLength / 256),
    sha256: await sha256Base64URL(bytes)
  }, privateKey);
}

function applicationEnvelope(kind: string, body: Uint8Array): Uint8Array {
  return encodeApplicationPayload({ version: applicationPayloadVersion, kind, messageId: token(16, 90), body });
}

function sentByKind(sent: readonly AttachmentSendRequest[], kind: string): AttachmentSendRequest[] {
  return sent.filter((request) => decodeApplicationPayload(request.plaintext).kind === kind);
}

function decodeChunkIndex(request: AttachmentSendRequest): number {
  const payload = decodeApplicationPayload(request.plaintext);
  return decodeAttachmentChunk(payload.body).index;
}

function encodeChunk(manifest: AttachmentManifest, bytes: Uint8Array): Uint8Array {
  return encodeAttachmentChunk({
    version: manifest.version,
    transferId: manifest.transferId,
    manifestId: manifest.manifestId,
    index: 0,
    bytes
  });
}

function token(length: number, seed: number): string {
  return encodeBase64URL(Uint8Array.from({ length }, (_, index) => (seed + index) & 0xff));
}

function required<T>(value: T | undefined): T {
  if (value === undefined) assert.fail("expected test fixture value");
  return value;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isTimerHandle(value: unknown): value is TimerHandle {
  return typeof value === "object" && value !== null && "active" in value;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
