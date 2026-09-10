import { RECEIPT_POLICY_STORE, openDatabase } from "./database.js";

const lastOpenedChatKey = "last_opened_chat";

// This is device-local UI state only. It identifies an already-local contact;
// it is neither protocol state nor information a relay can read or restore.
export async function loadStoredLastOpenedChat(): Promise<string | null> {
  const db = await openDatabase();
  try {
    return await new Promise<string | null>((resolve, reject) => {
      const request = db.transaction(RECEIPT_POLICY_STORE, "readonly").objectStore(RECEIPT_POLICY_STORE).get(lastOpenedChatKey);
      request.onsuccess = () => {
        const contactId: unknown = request.result;
        resolve(typeof contactId === "string" && contactId.length > 0 && contactId.length <= 128 ? contactId : null);
      };
      request.onerror = () => { reject(request.error ?? new Error("failed to read last opened chat")); };
    });
  } finally { db.close(); }
}

export async function saveStoredLastOpenedChat(contactId: string): Promise<void> {
  if (contactId.length === 0 || contactId.length > 128) {
    return;
  }
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(RECEIPT_POLICY_STORE, "readwrite");
      transaction.objectStore(RECEIPT_POLICY_STORE).put(contactId, lastOpenedChatKey);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to save last opened chat")); };
    });
  } finally { db.close(); }
}

export async function clearStoredLastOpenedChat(): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(RECEIPT_POLICY_STORE, "readwrite");
      transaction.objectStore(RECEIPT_POLICY_STORE).delete(lastOpenedChatKey);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to clear last opened chat")); };
    });
  } finally { db.close(); }
}
