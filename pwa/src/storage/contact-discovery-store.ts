import { CONTACT_DISCOVERY_STORE, openDatabase } from "./database.js";

export type StoredContactDiscovery = {
  readonly branchId: string;
  readonly displayName: string | null;
  readonly peerId: string | null;
  readonly hpkePublicKey: string | null;
  readonly lastCheckedAt: number | null;
  readonly retryRequestedAt: number;
};

export async function loadStoredContactDiscoveries(): Promise<readonly StoredContactDiscovery[]> {
  const db = await openDatabase();
  try {
    return await new Promise<readonly StoredContactDiscovery[]>((resolve, reject) => {
      const request = db.transaction(CONTACT_DISCOVERY_STORE, "readonly").objectStore(CONTACT_DISCOVERY_STORE).getAll();
      request.onsuccess = () => { resolve((request.result as StoredContactDiscovery[]).sort((left, right) => left.branchId.localeCompare(right.branchId))); };
      request.onerror = () => { reject(request.error ?? new Error("failed to read contact discovery")); };
    });
  } finally { db.close(); }
}

export async function saveStoredContactDiscovery(value: StoredContactDiscovery): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(CONTACT_DISCOVERY_STORE, "readwrite");
      transaction.objectStore(CONTACT_DISCOVERY_STORE).put(value);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to save contact discovery")); };
    });
  } finally { db.close(); }
}

export async function deleteStoredContactDiscovery(branchId: string): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(CONTACT_DISCOVERY_STORE, "readwrite");
      transaction.objectStore(CONTACT_DISCOVERY_STORE).delete(branchId);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to delete contact discovery")); };
    });
  } finally { db.close(); }
}
