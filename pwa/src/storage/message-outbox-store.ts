import { MESSAGE_OUTBOX_STORE, openDatabase } from "./database.js";

export const maxStoredOutboxEntries = 128;

export interface StoredOutboxEntry {
  readonly messageId: string;
  readonly contactId: string;
  readonly applicationMessageId: string;
  readonly createdAt: number;
  readonly nextAttemptAt: number;
  readonly attempts: number;
  readonly lastDeliveryId: string | null;
  // Positive endpoint delivery prevents retries, but this local record stays
  // boundedly available to correlate a later signed Read receipt.
  readonly deliveredAt: number | null;
}

export async function loadStoredOutbox(): Promise<readonly StoredOutboxEntry[]> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(MESSAGE_OUTBOX_STORE, "readonly").objectStore(MESSAGE_OUTBOX_STORE).getAll();
      request.onsuccess = () => { resolve(request.result as StoredOutboxEntry[]); };
      request.onerror = () => { reject(request.error ?? new Error("failed to read message outbox")); };
    });
  } finally { db.close(); }
}

export async function saveStoredOutbox(entry: StoredOutboxEntry): Promise<void> {
  const db = await openDatabase();
  try {
    await transaction(db, (store) => { store.put(entry); });
  } finally { db.close(); }
}

export async function deleteStoredOutbox(messageId: string): Promise<void> {
  const db = await openDatabase();
  try {
    await transaction(db, (store) => { store.delete(messageId); });
  } finally { db.close(); }
}

export async function deleteStoredOutboxForContact(contactId: string): Promise<void> {
  const entries = await loadStoredOutbox();
  await Promise.all(entries.filter((entry) => entry.contactId === contactId).map(async (entry) => { await deleteStoredOutbox(entry.messageId); }));
}

function transaction(db: IDBDatabase, action: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MESSAGE_OUTBOX_STORE, "readwrite");
    action(tx.objectStore(MESSAGE_OUTBOX_STORE));
    tx.oncomplete = () => { resolve(); };
    tx.onerror = () => { reject(tx.error ?? new Error("failed to write message outbox")); };
  });
}
