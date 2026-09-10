import { RECEIVED_APPLICATION_MESSAGES_STORE, openDatabase } from "./database.js";

// Bound device-local dedup metadata so application-level at-least-once retry
// cannot grow storage indefinitely. This is not a relay replay window and is
// never exported.
export const maxStoredReceivedApplicationMessages = 4096;

export async function hasStoredReceivedApplicationMessage(messageId: string): Promise<boolean> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(RECEIVED_APPLICATION_MESSAGES_STORE, "readonly").objectStore(RECEIVED_APPLICATION_MESSAGES_STORE).getKey(messageId);
      request.onsuccess = () => { resolve(request.result !== undefined); };
      request.onerror = () => { reject(request.error ?? new Error("failed to read received message identity")); };
    });
  } finally { db.close(); }
}

export async function saveStoredReceivedApplicationMessage(messageId: string, receivedAt: number): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(RECEIVED_APPLICATION_MESSAGES_STORE, "readwrite");
      tx.objectStore(RECEIVED_APPLICATION_MESSAGES_STORE).put({ messageId, receivedAt });
      tx.oncomplete = () => { resolve(); };
      tx.onerror = () => { reject(tx.error ?? new Error("failed to save received message identity")); };
    });
  } finally { db.close(); }
}

// Claims one canonical application message identity before the caller projects
// it into the local conversation. The read and write share one transaction so
// concurrent live envelopes cannot both pass a separate has-then-save check.
// This is device-local dedup metadata, never a relay receipt or protocol state.
export async function claimStoredReceivedApplicationMessage(messageId: string, receivedAt: number): Promise<boolean> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(RECEIVED_APPLICATION_MESSAGES_STORE, "readwrite");
      const store = tx.objectStore(RECEIVED_APPLICATION_MESSAGES_STORE);
      let claimed = false;
      const request = store.getKey(messageId);
      request.onsuccess = () => {
        if (request.result !== undefined) {
          return;
        }
        const count = store.count();
        count.onerror = () => { reject(count.error ?? new Error("failed to bound received message identities")); };
        count.onsuccess = () => {
          if (count.result < maxStoredReceivedApplicationMessages) {
            store.put({ messageId, receivedAt });
            claimed = true;
            return;
          }
          const oldest = store.index("byReceivedAt").openCursor();
          oldest.onerror = () => { reject(oldest.error ?? new Error("failed to evict received message identity")); };
          oldest.onsuccess = () => {
            if (oldest.result !== null) oldest.result.delete();
            store.put({ messageId, receivedAt });
            claimed = true;
          };
        };
      };
      request.onerror = () => { reject(request.error ?? new Error("failed to claim received message identity")); };
      tx.oncomplete = () => { resolve(claimed); };
      tx.onerror = () => { reject(tx.error ?? new Error("failed to claim received message identity")); };
    });
  } finally { db.close(); }
}
