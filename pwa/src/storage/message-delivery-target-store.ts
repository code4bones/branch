import { MESSAGE_DELIVERY_TARGETS_STORE, openDatabase } from "./database.js";

export const maxStoredMessageDeliveryTargets = 128;

// The outer delivery id is transport metadata. Keeping it outside MessageSummary
// prevents it from becoming portable conversation content or an E2EE payload.
export interface StoredMessageDeliveryTarget {
  readonly messageId: string;
  readonly contactId: string;
  readonly deliveryId: string;
  readonly createdAt: number;
}

export async function saveStoredMessageDeliveryTarget(entry: StoredMessageDeliveryTarget): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(MESSAGE_DELIVERY_TARGETS_STORE, "readwrite");
      const store = transaction.objectStore(MESSAGE_DELIVERY_TARGETS_STORE);
      store.put(entry);
      let retained = 0;
      const cursorRequest = store.index("byCreatedAt").openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor === null) return;
        retained += 1;
        if (retained > maxStoredMessageDeliveryTargets) cursor.delete();
        cursor.continue();
      };
      cursorRequest.onerror = () => { reject(cursorRequest.error ?? new Error("failed to trim receipt targets")); };
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to write receipt target")); };
    });
  } finally { db.close(); }
}

export async function findStoredMessageDeliveryTarget(contactId: string, deliveryId: string): Promise<StoredMessageDeliveryTarget | null> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(MESSAGE_DELIVERY_TARGETS_STORE, "readonly").objectStore(MESSAGE_DELIVERY_TARGETS_STORE).index("byDeliveryId").get(deliveryId);
      request.onsuccess = () => {
        const entry = request.result as StoredMessageDeliveryTarget | undefined;
        resolve(entry?.contactId === contactId ? entry : null);
      };
      request.onerror = () => { reject(request.error ?? new Error("failed to read receipt target")); };
    });
  } finally { db.close(); }
}

export async function deleteStoredMessageDeliveryTarget(messageId: string): Promise<void> {
  const db = await openDatabase();
  try {
    await transact(db, (store) => { store.delete(messageId); });
  } finally { db.close(); }
}

export async function deleteStoredMessageDeliveryTargetsForContact(contactId: string): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(MESSAGE_DELIVERY_TARGETS_STORE, "readwrite");
      const request = transaction.objectStore(MESSAGE_DELIVERY_TARGETS_STORE).index("byContactId").openCursor(IDBKeyRange.only(contactId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor !== null) {
          cursor.delete();
          cursor.continue();
        }
      };
      request.onerror = () => { reject(request.error ?? new Error("failed to delete contact receipt targets")); };
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to delete contact receipt targets")); };
    });
  } finally { db.close(); }
}

function transact(db: IDBDatabase, action: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(MESSAGE_DELIVERY_TARGETS_STORE, "readwrite");
    action(transaction.objectStore(MESSAGE_DELIVERY_TARGETS_STORE));
    transaction.oncomplete = () => { resolve(); };
    transaction.onerror = () => { reject(transaction.error ?? new Error("failed to write receipt target")); };
  });
}
