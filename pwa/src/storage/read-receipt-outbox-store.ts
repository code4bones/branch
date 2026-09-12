import { READ_RECEIPT_OUTBOX_STORE, openDatabase } from "./database.js";

// This is deliberately a small, device-local work list rather than a relay
// queue.  Its target is an already encrypted inbound envelope identifier.
export const maxStoredReadReceiptEntries = 128;

export interface StoredReadReceiptEntry {
  readonly targetDeliveryId: string;
  readonly contactId: string;
  readonly readAt: number;
  // A false value is still a durable local presentation fact.  It simply
  // records that this device was not permitted to disclose it remotely.
  readonly receiptPending: boolean;
}

export async function loadStoredReadReceiptOutbox(): Promise<readonly StoredReadReceiptEntry[]> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(READ_RECEIPT_OUTBOX_STORE, "readonly").objectStore(READ_RECEIPT_OUTBOX_STORE).getAll();
      request.onsuccess = () => { resolve(request.result as StoredReadReceiptEntry[]); };
      request.onerror = () => { reject(request.error ?? new Error("failed to read receipt outbox")); };
    });
  } finally { db.close(); }
}

export async function saveStoredReadReceipt(entry: StoredReadReceiptEntry): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(READ_RECEIPT_OUTBOX_STORE, "readwrite");
      const store = transaction.objectStore(READ_RECEIPT_OUTBOX_STORE);
      const readCurrent = store.get(entry.targetDeliveryId);
      readCurrent.onsuccess = () => {
        const current = readCurrent.result as StoredReadReceiptEntry | undefined;
        // A receipt target is immutable presentation history: once this
        // device has settled it, an older asynchronous pending save must never
        // downgrade it back to transport work after a refresh.
        if (!shouldPersistReadReceipt(current, entry)) return;
        store.put(entry);
      };
      readCurrent.onerror = () => { reject(readCurrent.error ?? new Error("failed to read current receipt outbox entry")); };
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to write receipt outbox")); };
    });
  } finally { db.close(); }
}

export function shouldPersistReadReceipt(current: StoredReadReceiptEntry | undefined, next: StoredReadReceiptEntry): boolean {
  return current?.receiptPending !== false || !next.receiptPending;
}

export async function deleteStoredReadReceipt(targetDeliveryId: string): Promise<void> {
  const db = await openDatabase();
  try {
    await transact(db, (store) => { store.delete(targetDeliveryId); });
  } finally { db.close(); }
}

export async function deleteStoredReadReceiptsForContact(contactId: string): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(READ_RECEIPT_OUTBOX_STORE, "readwrite");
      const request = transaction.objectStore(READ_RECEIPT_OUTBOX_STORE).index("byContactId").openCursor(IDBKeyRange.only(contactId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor !== null) {
          cursor.delete();
          cursor.continue();
        }
      };
      request.onerror = () => { reject(request.error ?? new Error("failed to delete contact read receipts")); };
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to delete contact read receipts")); };
    });
  } finally { db.close(); }
}

function transact(db: IDBDatabase, action: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(READ_RECEIPT_OUTBOX_STORE, "readwrite");
    action(transaction.objectStore(READ_RECEIPT_OUTBOX_STORE));
    transaction.oncomplete = () => { resolve(); };
    transaction.onerror = () => { reject(transaction.error ?? new Error("failed to write receipt outbox")); };
  });
}
