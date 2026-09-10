import { RECEIPT_POLICY_STORE, openDatabase } from "./database.js";

const allowContactDiscoveryKey = "allow_contact_discovery";

// A device-local preference. It neither creates an account nor changes a
// relay's volatile state until an already attached client explicitly announces
// the chosen value.
export async function loadStoredContactDiscoveryPolicy(): Promise<boolean> {
  const db = await openDatabase();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const request = db.transaction(RECEIPT_POLICY_STORE, "readonly").objectStore(RECEIPT_POLICY_STORE).get(allowContactDiscoveryKey);
      request.onsuccess = () => { resolve(request.result !== false); };
      request.onerror = () => { reject(request.error ?? new Error("failed to read contact discovery policy")); };
    });
  } finally { db.close(); }
}

export async function saveStoredContactDiscoveryPolicy(enabled: boolean): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(RECEIPT_POLICY_STORE, "readwrite");
      transaction.objectStore(RECEIPT_POLICY_STORE).put(enabled, allowContactDiscoveryKey);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to save contact discovery policy")); };
    });
  } finally { db.close(); }
}
