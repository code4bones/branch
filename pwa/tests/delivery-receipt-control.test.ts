import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  applicationControlSigningBytes,
  cborMap,
  decodeApplicationControl,
  encodeApplicationControl,
  encodeBase64URL,
  encodeDeterministicCbor,
  prepareOutboundApplicationControl,
  SameRelayTransportClient
} from "@code4bones/branch-core";

import {
  decodeReceiptBody,
  deliveryReceiptControlDescriptor,
  deliveryReceiptControlKind,
  encodeReceiptBody,
  receiveDeliveryReceipt
} from "../src/connectivity/delivery-receipt-control.js";

void test("a canonical signed receipt binds the live sender and is accepted only once", async () => {
  const [sender, recipient] = await Promise.all([
    SameRelayTransportClient.createIdentity(),
    SameRelayTransportClient.createIdentity()
  ]);
  const targetDeliveryId = encodeBase64URL(new Uint8Array(16).fill(7));
  const plaintext = await signedReceipt(sender, recipient.peerId, { kind: "delivered", targetDeliveryId });

  assert.deepEqual(
    await receiveDeliveryReceipt({ plaintext, localPeerId: recipient.peerId, senderPeerId: sender.peerId, knownContactId: "alice" }),
    { handled: true, outcome: "accepted", receipt: { kind: "delivered", targetDeliveryId } }
  );
  assert.deepEqual(
    await receiveDeliveryReceipt({ plaintext, localPeerId: recipient.peerId, senderPeerId: sender.peerId, knownContactId: "alice" }),
    { handled: true, outcome: "replay" }
  );
});

void test("receipt parsing rejects altered source, unknown contacts, invalid signatures and non-canonical body fields", async () => {
  const [sender, recipient, stranger] = await Promise.all([
    SameRelayTransportClient.createIdentity(),
    SameRelayTransportClient.createIdentity(),
    SameRelayTransportClient.createIdentity()
  ]);
  const targetDeliveryId = encodeBase64URL(new Uint8Array(16).fill(8));
  const plaintext = await signedReceipt(sender, recipient.peerId, { kind: "read", targetDeliveryId });
  assert.deepEqual(
    await receiveDeliveryReceipt({ plaintext, localPeerId: recipient.peerId, senderPeerId: stranger.peerId, knownContactId: "alice" }),
    { handled: true, outcome: "source_mismatch" }
  );
  assert.deepEqual(
    await receiveDeliveryReceipt({ plaintext, localPeerId: recipient.peerId, senderPeerId: sender.peerId, knownContactId: null }),
    { handled: true, outcome: "unknown_contact" }
  );

  const now = Date.now();
  const expired = await resign(sender.privateKey, { ...decodeApplicationControl(plaintext), issuedAt: now - 20_000, expiresAt: now - 10_000 });
  assert.deepEqual(
    await receiveDeliveryReceipt({ plaintext: expired, localPeerId: recipient.peerId, senderPeerId: sender.peerId, knownContactId: "alice" }),
    { handled: true, outcome: "expired" }
  );
  const future = await resign(sender.privateKey, { ...decodeApplicationControl(plaintext), issuedAt: now + 2_000, expiresAt: now + 12_000 });
  assert.deepEqual(
    await receiveDeliveryReceipt({ plaintext: future, localPeerId: recipient.peerId, senderPeerId: sender.peerId, knownContactId: "alice" }),
    { handled: true, outcome: "future_issued" }
  );
  const wrongRecipient = await resign(sender.privateKey, { ...decodeApplicationControl(plaintext), recipientPeerId: stranger.peerId });
  assert.deepEqual(
    await receiveDeliveryReceipt({ plaintext: wrongRecipient, localPeerId: recipient.peerId, senderPeerId: sender.peerId, knownContactId: "alice" }),
    { handled: true, outcome: "recipient_mismatch" }
  );

  const envelope = decodeApplicationControl(plaintext);
  const signature = new Uint8Array(envelope.signature);
  signature[0] = (signature[0] ?? 0) ^ 1;
  const tampered = encodeApplicationControl({ ...envelope, signature });
  assert.deepEqual(
    await receiveDeliveryReceipt({ plaintext: tampered, localPeerId: recipient.peerId, senderPeerId: sender.peerId, knownContactId: "alice" }),
    { handled: true, outcome: "signature_invalid" }
  );
  assert.throws(() => decodeReceiptBody(encodeDeterministicCbor(cborMap([
    { key: "receipt_kind", value: "delivered" },
    { key: "target_delivery_id", value: new Uint8Array(16) },
    { key: "extra", value: 1 }
  ]))));
});

void test("receipt body has a closed deterministic shape", () => {
  const targetDeliveryId = encodeBase64URL(new Uint8Array(16).fill(9));
  const body = encodeReceiptBody({ kind: "read", targetDeliveryId });
  assert.deepEqual(decodeReceiptBody(body), { kind: "read", targetDeliveryId });
  assert.throws(() => encodeReceiptBody({ kind: "read", targetDeliveryId: "wrong" }));
});

void test("read receipt sender deduplicates a successfully handed-off target", async () => {
  const source = await readFile(resolve(process.cwd(), "src/connectivity/delivery-receipt-control.ts"), "utf8");
  assert.match(source, /if \(emittedReceiptTargets\.has\(emittedKey\)\) return "skipped"/);
  assert.match(source, /if \(emittedReceiptTargets\.has\(emittedKey\)\) return false/);
  assert.doesNotMatch(source, /allowTargetRetry/);
});

async function signedReceipt(
  sender: Awaited<ReturnType<typeof SameRelayTransportClient.createIdentity>>,
  recipientPeerId: string,
  body: { readonly kind: "delivered" | "read"; readonly targetDeliveryId: string }
): Promise<Uint8Array> {
  const now = Date.now();
  const unsigned = prepareOutboundApplicationControl({
    kind: deliveryReceiptControlKind,
    controlId: encodeBase64URL(crypto.getRandomValues(new Uint8Array(16))),
    issuedAt: now,
    expiresAt: now + 10_000,
    senderPeerId: sender.peerId,
    recipientPeerId,
    body
  }, deliveryReceiptControlDescriptor, {
    now,
    localPeerId: sender.peerId,
    isKnownContact: () => true,
    isAllowed: () => true,
    consumeRateLimit: () => true,
    maxClockSkewMs: 1_000
  });
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", sender.privateKey, arrayBuffer(applicationControlSigningBytes(unsigned))));
  return encodeApplicationControl({ ...unsigned, signature });
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

async function resign(privateKey: CryptoKey, envelope: ReturnType<typeof decodeApplicationControl>): Promise<Uint8Array> {
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, arrayBuffer(applicationControlSigningBytes(envelope))));
  return encodeApplicationControl({ ...envelope, signature });
}
