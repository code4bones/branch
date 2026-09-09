// Single shared IndexedDB database for the whole PWA. Every storage module
// opens it through here so there is exactly one DATABASE_VERSION and one
// onupgradeneeded handler — opening the same database at different versions
// from different modules is a real way to deadlock IndexedDB upgrades.

const DATABASE_NAME = "branch-pwa";
const DATABASE_VERSION = 3;

export const IDENTITY_STORE = "identity";
export const CONTACTS_STORE = "contacts";
export const MESSAGES_STORE = "messages";
export const READ_STATE_STORE = "readState";
export const MESSAGE_REQUESTS_STORE = "messageRequests";

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDENTITY_STORE)) {
        db.createObjectStore(IDENTITY_STORE);
      }
      if (!db.objectStoreNames.contains(CONTACTS_STORE)) {
        db.createObjectStore(CONTACTS_STORE, { keyPath: "contactId" });
      }
      if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
        const messagesStore = db.createObjectStore(MESSAGES_STORE, { keyPath: "messageId" });
        messagesStore.createIndex("byContactId", "contactId");
      }
      if (!db.objectStoreNames.contains(READ_STATE_STORE)) {
        db.createObjectStore(READ_STATE_STORE);
      }
      if (!db.objectStoreNames.contains(MESSAGE_REQUESTS_STORE)) {
        db.createObjectStore(MESSAGE_REQUESTS_STORE, { keyPath: "requestId" });
      }
    };
    request.onsuccess = () => { resolve(request.result); };
    request.onerror = () => { reject(request.error ?? new Error("failed to open branch-pwa database")); };
  });
}
