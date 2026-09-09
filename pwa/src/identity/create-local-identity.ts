import { createBetaPayloadKeyPair, SameRelayTransportClient } from "@code4bones/branch-core";

import { setLocalIdentityKeys } from "./identity-keys.js";
import type { LocalIdentitySummary } from "../state/slices/identity-slice.js";
import { loadStoredIdentity, saveStoredIdentity, type StoredIdentityRecord } from "../storage/identity-store.js";
import { validateDisplayName } from "../connectivity/message-payload.js";

// Generates the two key pairs a local identity needs: an Ed25519 key that
// authenticates this device to a relay (SameRelayTransportClient.createIdentity,
// same construction the admin transport lab uses), and a separate X25519/HPKE
// key pair recipients use to seal message payloads for this device. Relay
// attachment and payload sealing are not wired yet — this only establishes and
// persists the identity itself.
export async function createLocalIdentity(displayName: string | null): Promise<LocalIdentitySummary> {
  const relayIdentity = await SameRelayTransportClient.createIdentity();
  const hpkeKeyPair = await createBetaPayloadKeyPair();
  const createdAt = Date.now();

  const record: StoredIdentityRecord = {
    peerId: relayIdentity.peerId,
    relayPublicKey: relayIdentity.publicKey,
    relayPrivateKey: relayIdentity.privateKey,
    hpkePublicKey: hpkeKeyPair.publicKey,
    hpkePrivateKey: hpkeKeyPair.privateKey,
    displayName: normalizeDisplayName(displayName),
    createdAt
  };
  await saveStoredIdentity(record);
  setLocalIdentityKeys({ relayPrivateKey: record.relayPrivateKey, hpkePrivateKey: record.hpkePrivateKey });

  return summaryFromRecord(record);
}

export async function updateLocalIdentityDisplayName(displayName: string | null): Promise<LocalIdentitySummary> {
  const record = await loadStoredIdentity();
  if (record === null) {
    throw new Error("local identity not found");
  }
  const updated: StoredIdentityRecord = { ...record, displayName: normalizeDisplayName(displayName) };
  await saveStoredIdentity(updated);
  return summaryFromRecord(updated);
}

export async function loadLocalIdentity(): Promise<LocalIdentitySummary | null> {
  const record = await loadStoredIdentity();
  if (record === null) {
    return null;
  }
  setLocalIdentityKeys({ relayPrivateKey: record.relayPrivateKey, hpkePrivateKey: record.hpkePrivateKey });
  return summaryFromRecord(record);
}

function summaryFromRecord(record: StoredIdentityRecord): LocalIdentitySummary {
  return {
    peerId: record.peerId,
    relayPublicKey: record.relayPublicKey,
    hpkePublicKey: record.hpkePublicKey,
    displayName: record.displayName,
    createdAt: record.createdAt
  };
}

function normalizeDisplayName(displayName: string | null): string | null {
  if (displayName === null) {
    return null;
  }
  const normalized = displayName.trim();
  if (normalized === "") {
    return null;
  }
  validateDisplayName(normalized);
  return normalized;
}
