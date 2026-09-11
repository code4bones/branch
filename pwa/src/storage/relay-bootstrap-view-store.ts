import type { LoadedRelayBootstrapView, StoredRelayBootstrapView } from "../discovery/relay-bootstrap-view.js";
import { decodeStoredRelayBootstrapView } from "../discovery/relay-bootstrap-view.js";
import { RELAY_BOOTSTRAP_VIEW_STORE, openDatabase } from "./database.js";

const relayBootstrapViewKey = "verified-public-v1";

export async function loadStoredRelayBootstrapView(now: number): Promise<LoadedRelayBootstrapView | null> {
  const db = await openDatabase();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(RELAY_BOOTSTRAP_VIEW_STORE, "readonly").objectStore(RELAY_BOOTSTRAP_VIEW_STORE).get(relayBootstrapViewKey);
      request.onsuccess = () => { resolve(request.result); };
      request.onerror = () => { reject(request.error ?? new Error("failed to read relay bootstrap view")); };
    });
    const decoded = decodeStoredRelayBootstrapView(value, now);
    if (value !== undefined && decoded === null) {
      await deleteStoredRelayBootstrapView(db);
    }
    return decoded;
  } finally {
    db.close();
  }
}

export async function saveStoredRelayBootstrapView(view: StoredRelayBootstrapView): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(RELAY_BOOTSTRAP_VIEW_STORE, "readwrite");
      transaction.objectStore(RELAY_BOOTSTRAP_VIEW_STORE).put(view, relayBootstrapViewKey);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to save relay bootstrap view")); };
    });
  } finally {
    db.close();
  }
}

async function deleteStoredRelayBootstrapView(db: IDBDatabase): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(RELAY_BOOTSTRAP_VIEW_STORE, "readwrite");
    transaction.objectStore(RELAY_BOOTSTRAP_VIEW_STORE).delete(relayBootstrapViewKey);
    transaction.oncomplete = () => { resolve(); };
    transaction.onerror = () => { reject(transaction.error ?? new Error("failed to discard invalid relay bootstrap view")); };
  });
}
