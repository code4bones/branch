import { CONTACTS_STORE, MESSAGES_STORE, READ_STATE_STORE, openDatabase } from "./database.js";

// These IDs belonged exclusively to the early local demo. They were never
// discoverable identities and must not survive as apparent user contacts.
// Keep the cleanup narrowly scoped: it never touches a real contact or chat.
const legacyDemoContactIds = [
  "demo-ribbon-bearer",
  "demo-relay-operator",
  "demo-carrier-hop",
  "echo"
] as const;

// Older PWA installs may still have the seed in IndexedDB. Remove it before
// hydration in one local transaction so the first real empty state is stable
// across reloads. This is local-only migration work; it has no relay effect.
export async function removeLegacyDemoState(): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([CONTACTS_STORE, MESSAGES_STORE, READ_STATE_STORE], "readwrite");
      const contacts = transaction.objectStore(CONTACTS_STORE);
      const messagesByContactId = transaction.objectStore(MESSAGES_STORE).index("byContactId");
      const readState = transaction.objectStore(READ_STATE_STORE);

      for (const contactId of legacyDemoContactIds) {
        contacts.delete(contactId);
        readState.delete(contactId);
        const request = messagesByContactId.openCursor(IDBKeyRange.only(contactId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor !== null) {
            cursor.delete();
            cursor.continue();
          }
        };
      }

      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to remove legacy demo state")); };
      transaction.onabort = () => { reject(transaction.error ?? new Error("legacy demo cleanup aborted")); };
    });
  } finally {
    db.close();
  }
}
