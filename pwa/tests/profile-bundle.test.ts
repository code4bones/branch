import assert from "node:assert/strict";
import { test } from "node:test";

import { SameRelayTransportClient, createBetaPayloadKeyPair } from "@code4bones/branch-core";

import { decryptPortableProfile, encryptPortableProfile, portableProfilePbkdf2Iterations } from "../src/profile/profile-bundle.js";
import type { PortableProfileSnapshot } from "../src/profile/profile-bundle.js";

const password = "correct horse battery staple";

void test("portable profile round-trips identity and portable local history under AES-GCM", async () => {
  const snapshot = await makeSnapshot();
  const bundle = await encryptPortableProfile(snapshot, password);
  const envelope = JSON.parse(bundle) as Record<string, unknown>;
  assert.equal(envelope.format, "branch.pwa.profile-export/0.draft");
  assert.equal(envelope.iterations, portableProfilePbkdf2Iterations);
  assert.equal(envelope.kdf, "PBKDF2-SHA-256");
  assert.equal(envelope.cipher, "AES-256-GCM");
  assert.equal(bundle.includes("A local message"), false);

  const restored = await decryptPortableProfile(bundle, password);
  assert.equal(restored.identity.peerId, snapshot.identity.peerId);
  assert.equal(restored.identity.relayPublicKey, snapshot.identity.relayPublicKey);
  assert.equal(restored.identity.hpkePublicKey, snapshot.identity.hpkePublicKey);
  assert.deepEqual(restored.contacts, snapshot.contacts);
  assert.deepEqual(restored.messages, snapshot.messages);
  assert.deepEqual(restored.readState, snapshot.readState);
  assert.deepEqual(restored.messageRequests, snapshot.messageRequests);
  assert.equal(await crypto.subtle.exportKey("jwk", restored.identity.relayPrivateKey) instanceof Object, true);
});

void test("wrong password and ciphertext tampering fail before a profile can be restored", async () => {
  const bundle = await encryptPortableProfile(await makeSnapshot(), password);
  await assert.rejects(decryptPortableProfile(bundle, "a completely different secure password"), /could not be decrypted or verified/);

  const tampered = JSON.parse(bundle) as { ciphertext: string };
  tampered.ciphertext = `${tampered.ciphertext.slice(0, -1)}${tampered.ciphertext.endsWith("A") ? "B" : "A"}`;
  await assert.rejects(decryptPortableProfile(JSON.stringify(tampered), password), /could not be decrypted or verified/);
});

void test("portable profile rejects an envelope that changes the authenticated KDF contract", async () => {
  const bundle = JSON.parse(await encryptPortableProfile(await makeSnapshot(), password)) as { iterations: number };
  bundle.iterations = 1;
  await assert.rejects(decryptPortableProfile(JSON.stringify(bundle), password), /invalid profile envelope/);
});

async function makeSnapshot(): Promise<PortableProfileSnapshot> {
  const relay = await SameRelayTransportClient.createIdentity();
  const hpke = await createBetaPayloadKeyPair();
  return {
    identity: {
      peerId: relay.peerId,
      relayPublicKey: relay.publicKey,
      relayPrivateKey: relay.privateKey,
      hpkePublicKey: hpke.publicKey,
      hpkePrivateKey: hpke.privateKey,
      displayName: "Migrated profile",
      createdAt: 1_700_000_000_000
    },
    contacts: [{ contactId: "contact-a", displayName: "Alice", peerId: null, hpkePublicKey: null, lastRouteHint: null }],
    messages: [{ messageId: "message-a", contactId: "contact-a", direction: "incoming", body: "A local message", sentAt: 1_700_000_000_001, deliveryState: "received" }],
    readState: { "contact-a": 1_700_000_000_001 },
    messageRequests: []
  };
}
