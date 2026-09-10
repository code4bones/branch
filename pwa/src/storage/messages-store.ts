import { MESSAGES_STORE, openDatabase } from "./database.js";
import type { MessageSummary } from "../state/slices/conversations-slice.js";

export async function loadStoredMessages(): Promise<readonly MessageSummary[]> {
  const db = await openDatabase();
  try {
    return await new Promise<readonly MessageSummary[]>((resolve, reject) => {
      const request = db.transaction(MESSAGES_STORE, "readonly").objectStore(MESSAGES_STORE).getAll();
      request.onsuccess = () => { resolve(request.result as MessageSummary[]); };
      request.onerror = () => { reject(request.error ?? new Error("failed to read messages")); };
    });
  } finally {
    db.close();
  }
}

export async function saveStoredMessage(message: MessageSummary): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(MESSAGES_STORE, "readwrite");
      transaction.objectStore(MESSAGES_STORE).put(message);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to write message")); };
    });
  } finally {
    db.close();
  }
}

// A manual retry gets a fresh live delivery identifier. Keep the local chat to
// one bubble by replacing the failed record atomically on this device.
export async function replaceStoredMessageForRetry(previousMessageId: string, replacement: MessageSummary): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(MESSAGES_STORE, "readwrite");
      const store = transaction.objectStore(MESSAGES_STORE);
      store.delete(previousMessageId);
      store.put(replacement);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to replace retried message")); };
    });
  } finally {
    db.close();
  }
}

export async function deleteStoredMessagesForContact(contactId: string): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(MESSAGES_STORE, "readwrite");
      const request = transaction.objectStore(MESSAGES_STORE).index("byContactId").openCursor(IDBKeyRange.only(contactId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor !== null) {
          cursor.delete();
          cursor.continue();
        }
      };
      request.onerror = () => { reject(request.error ?? new Error("failed to delete contact messages")); };
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to delete contact messages")); };
    });
  } finally {
    db.close();
  }
}
