import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  decodeApplicationControl,
  decodeApplicationPayload,
  decodeBase64URL,
  decodeImageTransferManifest,
  encodeApplicationPayload,
  encodeBase64URL,
  encodeImageTransferManifest,
  encodeApplicationControl,
  SameRelayTransportClient
} from "@code4bones/branch-core";

import {
  ImageCapabilitiesController,
  defaultImageCapabilities,
  type ImageCapabilitiesControlPorts
} from "../src/connectivity/image-capabilities-control.js";
import {
  ImageTransferController,
  imageInlineKind,
  imageTransferManifestKind,
  type ImageTransferSendRequest,
  type ImageTransferTimerPort,
  type VerifiedImageMessage
} from "../src/connectivity/image-transfer.js";

const now = 1_700_000_000_000;

void test("image capability is signed, expiring receiver consent and not merely a configured local limit", async () => {
  const fixture = await capabilityFixture();
  assert.equal(fixture.receiver.inboundCapabilities(fixture.senderIdentity.peerId), null);
  assert.equal(await fixture.receiver.advertise(fixture.senderIdentity.peerId), "sent");
  assert.equal(fixture.controlMessages.length, 1);
  const advertised = required(fixture.controlMessages.pop());
  assert.deepEqual(await fixture.sender.receive(fixture.receiverIdentity.peerId, advertised.plaintext), {
    handled: true,
    outcome: "accepted",
    capabilities: defaultImageCapabilities(),
    expiresAt: now + 5 * 60_000
  });
  assert.deepEqual(fixture.sender.peerCapabilities(fixture.receiverIdentity.peerId), defaultImageCapabilities());
  assert.deepEqual(fixture.receiver.inboundCapabilities(fixture.senderIdentity.peerId), defaultImageCapabilities());
  // A sender can lose its volatile cache on reload. A recipient that already
  // advertised must answer the renewed signed request once, without creating
  // a reciprocal capability-control loop.
  assert.equal(fixture.receiver.shouldReplyTo(fixture.senderIdentity.peerId), true);
  assert.equal(fixture.receiver.shouldReplyTo(fixture.senderIdentity.peerId), false);

  const invalidFixture = await capabilityFixture();
  await invalidFixture.receiver.advertise(invalidFixture.senderIdentity.peerId);
  const decoded = decodeApplicationControl(required(invalidFixture.controlMessages.pop()).plaintext);
  const signature = new Uint8Array(decoded.signature);
  signature[0] = (signature[0] ?? 0) ^ 1;
  assert.deepEqual(await invalidFixture.sender.receive(invalidFixture.receiverIdentity.peerId, encodeApplicationControl({ ...decoded, signature })), {
    handled: true,
    outcome: "signature_invalid"
  });
});

void test("a valid inline image auto-admits only within receiver capability and has no accept control", async () => {
  const fixture = await transferFixture();
  const bytes = pngBytes(128);
  const result = await fixture.senderTransfer.sendImage({
    peerId: fixture.receiverIdentity.peerId,
    route: "relay",
    messageId: encodeBase64URL(new Uint8Array(16).fill(7)),
    mediaType: "image/png",
    width: 1,
    height: 1,
    bytes
  });
  assert.equal(result.status, "sent");
  assert.equal(result.mode, "inline");
  assert.equal(fixture.sent.length, 1);
  assert.deepEqual(await fixture.receiverTransfer.receive(fixture.senderIdentity.peerId, required(fixture.sent[0]).plaintext), {
    status: "handled",
    kind: imageInlineKind
  });
  assert.equal(fixture.completed.length, 1);
  assert.equal(required(fixture.completed[0]).messageId, encodeBase64URL(new Uint8Array(16).fill(7)));
  assert.deepEqual(required(fixture.completed[0]).bytes, bytes);
  assert.equal(fixture.sent.length, 1, "automatic admission must not emit an attachment Accept control");

  const noConsent = await transferFixture({ advertise: false });
  assert.deepEqual(await noConsent.receiverTransfer.receive(noConsent.senderIdentity.peerId, required(fixture.sent[0]).plaintext), {
    status: "ignored",
    reason: "unsupported"
  });
  assert.equal(noConsent.completed.length, 0);
});

void test("chunk transfer verifies manifest signature, capability, digest, magic and decoded dimensions before automatic projection", async () => {
  const fixture = await transferFixture();
  const bytes = pngBytes(3_073);
  const result = await fixture.senderTransfer.sendImage({
    peerId: fixture.receiverIdentity.peerId,
    route: "relay",
    mediaType: "image/png",
    width: 1,
    height: 1,
    bytes
  });
  assert.deepEqual(result.status, "sent");
  assert.equal(result.mode, "transfer");
  assert.equal(fixture.sent.length, 3, "one manifest plus two live chunks, without a decision round trip");
  for (const request of fixture.sent) {
    const received = await fixture.receiverTransfer.receive(fixture.senderIdentity.peerId, request.plaintext);
    assert.equal(received.status, "handled");
  }
  assert.equal(fixture.completed.length, 1);
  assert.deepEqual(fixture.completed[0]?.bytes, bytes);
  assert.equal(fixture.verified.length, 1);

  const invalid = await transferFixture();
  const manifest = required(fixture.sent.find((entry) => messageKind(entry.plaintext) === imageTransferManifestKind));
  const envelope = decodeApplicationPayload(manifest.plaintext);
  const signedManifest = decodeImageTransferManifest(envelope.body);
  const signature = new Uint8Array(signedManifest.signature);
  signature[0] = (signature[0] ?? 0) ^ 1;
  const altered = encodeApplicationPayload({ ...envelope, body: encodeImageTransferManifest({ ...signedManifest, signature }) });
  assert.deepEqual(await invalid.receiverTransfer.receive(invalid.senderIdentity.peerId, altered), {
    status: "ignored",
    reason: "invalid_signature"
  });
  assert.equal(invalid.completed.length, 0);
});

void test("PWA image adapter delegates bounded manifest/chunk reassembly to branch core", async () => {
  const source = await readFile(resolve(process.cwd(), "src/connectivity/image-transfer.ts"), "utf8");
  assert.match(source, /ImageTransferReassemblyRegistry/);
  assert.match(source, /this\.#inbound\.receiveChunk/);
  assert.doesNotMatch(source, /readonly chunks: Map<number, Uint8Array>/);
  assert.doesNotMatch(source, /chunk\.index - inbound\.nextMissingIndex/);
});

interface TimerHandle { active: boolean; readonly callback: () => void; }

class Timers implements ImageTransferTimerPort {
  readonly handles: TimerHandle[] = [];
  schedule(_delayMs: number, callback: () => void): TimerHandle {
    const handle = { active: true, callback };
    this.handles.push(handle);
    return handle;
  }
  cancel(handle: unknown): void {
    if (typeof handle === "object" && handle !== null && "active" in handle) (handle as TimerHandle).active = false;
  }
}

async function capabilityFixture() {
  const [senderIdentity, receiverIdentity] = await Promise.all([
    SameRelayTransportClient.createIdentity(),
    SameRelayTransportClient.createIdentity()
  ]);
  const controlMessages: Array<{ readonly peerId: string; readonly plaintext: Uint8Array }> = [];
  let counter = 1;
  const ports = (identity: typeof senderIdentity, known: typeof receiverIdentity): ImageCapabilitiesControlPorts => ({
    now: () => now,
    randomBytes: (bytes) => { bytes.fill(counter); counter += 1; return bytes; },
    localPeerId: () => identity.peerId,
    localSigningKey: () => identity.privateKey,
    isKnownPeer: (peerId) => peerId === known.peerId,
    knownPeerSigningKey: async (peerId) => peerId === known.peerId ? await signingKey(known.peerId) : null,
    send: ({ peerId, plaintext }) => { controlMessages.push({ peerId, plaintext }); },
    localCapabilities: () => defaultImageCapabilities()
  });
  return {
    senderIdentity,
    receiverIdentity,
    sender: new ImageCapabilitiesController(ports(senderIdentity, receiverIdentity)),
    receiver: new ImageCapabilitiesController(ports(receiverIdentity, senderIdentity)),
    controlMessages
  };
}

async function transferFixture(options: { readonly advertise?: boolean } = {}) {
  const capabilities = await capabilityFixture();
  if (options.advertise ?? true) {
    await capabilities.receiver.advertise(capabilities.senderIdentity.peerId);
    const message = required(capabilities.controlMessages.pop());
    await capabilities.sender.receive(capabilities.receiverIdentity.peerId, message.plaintext);
  }
  const sent: ImageTransferSendRequest[] = [];
  const completed: VerifiedImageMessage[] = [];
  const verified: Array<{ readonly width: number; readonly height: number }> = [];
  const timers = new Timers();
  const senderTransfer = new ImageTransferController({
    now: () => now,
    randomBytes: deterministicRandom(),
    localSigningKey: () => capabilities.senderIdentity.privateKey,
    isKnownPeer: (peerId) => peerId === capabilities.receiverIdentity.peerId,
    knownPeerSigningKey: async (peerId) => peerId === capabilities.receiverIdentity.peerId ? await signingKey(capabilities.receiverIdentity.peerId) : null,
    peerCapabilities: (peerId) => capabilities.sender.peerCapabilities(peerId),
    inboundCapabilities: () => null,
    send: (request) => { sent.push(request); },
    timers,
    verifyRaster: () => true,
    onImage: () => { throw new Error("sender must not receive its own image"); }
  });
  const receiverTransfer = new ImageTransferController({
    now: () => now,
    randomBytes: deterministicRandom(),
    localSigningKey: () => capabilities.receiverIdentity.privateKey,
    isKnownPeer: (peerId) => peerId === capabilities.senderIdentity.peerId,
    knownPeerSigningKey: async (peerId) => peerId === capabilities.senderIdentity.peerId ? await signingKey(capabilities.senderIdentity.peerId) : null,
    peerCapabilities: () => null,
    inboundCapabilities: (peerId) => capabilities.receiver.inboundCapabilities(peerId),
    send: () => { throw new Error("image receiver must not send an accept control"); },
    timers,
    verifyRaster: ({ width, height }) => { verified.push({ width, height }); return width === 1 && height === 1; },
    onImage: (image) => { completed.push(image); }
  });
  return { ...capabilities, senderTransfer, receiverTransfer, sent, completed, verified };
}

function deterministicRandom(): (bytes: Uint8Array) => Uint8Array {
  let counter = 1;
  return (bytes) => { bytes.fill(counter); counter += 1; return bytes; };
}

function pngBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.fill(0x7f, 8);
  return bytes;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("required test fixture value is absent");
  return value;
}

function messageKind(plaintext: Uint8Array): string {
  return decodeApplicationPayload(plaintext).kind;
}

async function signingKey(peerId: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", new Uint8Array(decodeBase64URL(peerId)).buffer, "Ed25519", false, ["verify"]);
}
