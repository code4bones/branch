// IndexedDB storage boundary for local identity material, owned by the PWA
// (not by @code4bones/branch-core, which stays UI/storage-neutral). Only this
// module and src/identity/identity-keys.ts ever see the private CryptoKeys.

import { IDENTITY_STORE, openDatabase } from "./database.js";

const RECORD_KEY = "local";

export interface StoredIdentityRecord {
  readonly peerId: string;
  readonly relayPublicKey: string;
  readonly relayPrivateKey: CryptoKey;
  readonly hpkePublicKey: string;
  readonly hpkePrivateKey: CryptoKey;
  readonly displayName: string | null;
  readonly createdAt: number;
}

export async function loadStoredIdentity(): Promise<StoredIdentityRecord | null> {
  const db = await openDatabase();
  try {
    return await new Promise<StoredIdentityRecord | null>((resolve, reject) => {
      const request = db.transaction(IDENTITY_STORE, "readonly").objectStore(IDENTITY_STORE).get(RECORD_KEY);
      request.onsuccess = () => { resolve((request.result as StoredIdentityRecord | undefined) ?? null); };
      request.onerror = () => { reject(request.error ?? new Error("failed to read identity")); };
    });
  } finally {
    db.close();
  }
}

export async function saveStoredIdentity(record: StoredIdentityRecord): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(IDENTITY_STORE, "readwrite");
      transaction.objectStore(IDENTITY_STORE).put(record, RECORD_KEY);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to write identity")); };
    });
  } finally {
    db.close();
  }
}

export async function clearStoredIdentity(): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(IDENTITY_STORE, "readwrite");
      transaction.objectStore(IDENTITY_STORE).delete(RECORD_KEY);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to clear identity")); };
    });
  } finally {
    db.close();
  }
}
