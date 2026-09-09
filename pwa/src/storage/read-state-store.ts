import { READ_STATE_STORE, openDatabase } from "./database.js";

export async function loadStoredReadState(): Promise<Readonly<Record<string, number>>> {
  const db = await openDatabase();
  try {
    return await new Promise<Record<string, number>>((resolve, reject) => {
      const result: Record<string, number> = {};
      const request = db.transaction(READ_STATE_STORE, "readonly").objectStore(READ_STATE_STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) {
          resolve(result);
          return;
        }
        // Keys in this store are always contact ids written by
        // saveStoredReadState, i.e. always strings.
        result[cursor.key as string] = cursor.value as number;
        cursor.continue();
      };
      request.onerror = () => { reject(request.error ?? new Error("failed to read read-state")); };
    });
  } finally {
    db.close();
  }
}

export async function saveStoredReadState(contactId: string, timestamp: number): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(READ_STATE_STORE, "readwrite");
      transaction.objectStore(READ_STATE_STORE).put(timestamp, contactId);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to write read-state")); };
    });
  } finally {
    db.close();
  }
}

export async function deleteStoredReadState(contactId: string): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(READ_STATE_STORE, "readwrite");
      transaction.objectStore(READ_STATE_STORE).delete(contactId);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to delete contact read-state")); };
    });
  } finally {
    db.close();
  }
}
