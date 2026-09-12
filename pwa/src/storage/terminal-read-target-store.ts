import { TERMINAL_READ_TARGETS_STORE, openDatabase } from "./database.js";

export const maxStoredTerminalReadTargets = 128;

export interface StoredTerminalReadTarget {
  readonly targetDeliveryId: string;
  readonly contactId: string;
  readonly expiresAt: number;
}

export async function rememberTerminalReadTarget(entry: StoredTerminalReadTarget): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(TERMINAL_READ_TARGETS_STORE, "readwrite");
      const store = transaction.objectStore(TERMINAL_READ_TARGETS_STORE);
      store.put(entry);
      let retained = 0;
      const cursor = store.index("byExpiresAt").openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (current === null) return;
        retained += 1;
        if (retained > maxStoredTerminalReadTargets) current.delete();
        current.continue();
      };
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to write terminal read target")); };
    });
  } finally { db.close(); }
}

export async function findTerminalReadTarget(contactId: string, targetDeliveryId: string, now: number = Date.now()): Promise<StoredTerminalReadTarget | null> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(TERMINAL_READ_TARGETS_STORE, "readwrite");
      const store = transaction.objectStore(TERMINAL_READ_TARGETS_STORE);
      const request = store.get(targetDeliveryId);
      request.onsuccess = () => {
        const entry = request.result as StoredTerminalReadTarget | undefined;
        if (entry === undefined || entry.contactId !== contactId || entry.expiresAt <= now) {
          if (entry !== undefined && entry.expiresAt <= now) store.delete(targetDeliveryId);
          resolve(null);
          return;
        }
        resolve(entry);
      };
      request.onerror = () => { reject(request.error ?? new Error("failed to read terminal read target")); };
    });
  } finally { db.close(); }
}

export async function deleteStoredTerminalReadTargetsForContact(contactId: string): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(TERMINAL_READ_TARGETS_STORE, "readwrite");
      const cursor = transaction.objectStore(TERMINAL_READ_TARGETS_STORE).index("byContactId").openCursor(IDBKeyRange.only(contactId));
      cursor.onsuccess = () => { const current = cursor.result; if (current !== null) { current.delete(); current.continue(); } };
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to clear terminal read targets")); };
    });
  } finally { db.close(); }
}
