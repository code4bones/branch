import { MESSAGE_REQUESTS_STORE, openDatabase } from "./database.js";
import type { IncomingMessageRequest } from "../state/slices/message-requests-slice.js";

export async function loadStoredMessageRequests(): Promise<readonly IncomingMessageRequest[]> {
  const db = await openDatabase();
  try {
    return await new Promise<readonly IncomingMessageRequest[]>((resolve, reject) => {
      const request = db.transaction(MESSAGE_REQUESTS_STORE, "readonly").objectStore(MESSAGE_REQUESTS_STORE).getAll();
      request.onsuccess = () => { resolve(request.result as IncomingMessageRequest[]); };
      request.onerror = () => { reject(request.error ?? new Error("failed to read message requests")); };
    });
  } finally {
    db.close();
  }
}

export async function saveStoredMessageRequest(request: IncomingMessageRequest): Promise<void> {
  const db = await openDatabase();
  try {
    await runRequestTransaction(db, (store) => { store.put(request); });
  } finally {
    db.close();
  }
}

export async function deleteStoredMessageRequest(requestId: string): Promise<void> {
  const db = await openDatabase();
  try {
    await runRequestTransaction(db, (store) => { store.delete(requestId); });
  } finally {
    db.close();
  }
}

function runRequestTransaction(db: IDBDatabase, operation: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(MESSAGE_REQUESTS_STORE, "readwrite");
    operation(transaction.objectStore(MESSAGE_REQUESTS_STORE));
    transaction.oncomplete = () => { resolve(); };
    transaction.onerror = () => { reject(transaction.error ?? new Error("failed to write message request")); };
  });
}
