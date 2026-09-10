import { RECEIPT_POLICY_STORE, openDatabase } from "./database.js";

const sendReadReceiptsKey = "send_read_receipts";

// This is a user-owned local preference, never protocol state. In particular,
// a relay cannot inspect, modify, or restore it after a client restart.
export async function loadStoredReadReceiptPolicy(): Promise<boolean> {
  const db = await openDatabase();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const request = db.transaction(RECEIPT_POLICY_STORE, "readonly").objectStore(RECEIPT_POLICY_STORE).get(sendReadReceiptsKey);
      request.onsuccess = () => { resolve(request.result === true); };
      request.onerror = () => { reject(request.error ?? new Error("failed to read receipt policy")); };
    });
  } finally {
    db.close();
  }
}

export async function saveStoredReadReceiptPolicy(enabled: boolean): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(RECEIPT_POLICY_STORE, "readwrite");
      transaction.objectStore(RECEIPT_POLICY_STORE).put(enabled, sendReadReceiptsKey);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to write receipt policy")); };
    });
  } finally {
    db.close();
  }
}
