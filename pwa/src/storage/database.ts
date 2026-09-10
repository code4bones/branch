// Single shared IndexedDB database for the whole PWA. Every storage module
// opens it through here so there is exactly one DATABASE_VERSION and one
// onupgradeneeded handler — opening the same database at different versions
// from different modules is a real way to deadlock IndexedDB upgrades.

const DATABASE_NAME = "branch-pwa";
// v11 adds bounded device-local deletion tombstones. They prevent an older
// asynchronous message write from reviving a locally deleted bubble; neither
// they nor the deletion action ever leave this browser's DB.
const DATABASE_VERSION = 11;

export const IDENTITY_STORE = "identity";
export const CONTACTS_STORE = "contacts";
export const MESSAGES_STORE = "messages";
export const READ_STATE_STORE = "readState";
export const MESSAGE_REQUESTS_STORE = "messageRequests";
export const RECEIPT_POLICY_STORE = "receiptPolicy";
export const CONTACT_DISCOVERY_STORE = "contactDiscovery";
// Folder names and membership are deliberately separate from contacts: they
// are a device-local presentation choice, never portable contact data.
export const CONTACT_FOLDERS_STORE = "contactFolders";
export const CONTACT_FOLDER_ASSIGNMENTS_STORE = "contactFolderAssignments";
// Device-owned retry metadata and received generic message identities. Neither
// store contains relay frames, routes, ciphertext, or relay-owned state.
export const MESSAGE_OUTBOX_STORE = "messageOutbox";
export const RECEIVED_APPLICATION_MESSAGES_STORE = "receivedApplicationMessages";
export const READ_RECEIPT_OUTBOX_STORE = "readReceiptOutbox";
export const MESSAGE_DELIVERY_TARGETS_STORE = "messageDeliveryTargets";
export const LOCALLY_DELETED_MESSAGES_STORE = "locallyDeletedMessages";

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
      if (!db.objectStoreNames.contains(RECEIPT_POLICY_STORE)) {
        db.createObjectStore(RECEIPT_POLICY_STORE);
      }
      if (!db.objectStoreNames.contains(CONTACT_DISCOVERY_STORE)) {
        db.createObjectStore(CONTACT_DISCOVERY_STORE, { keyPath: "branchId" });
      }
      if (!db.objectStoreNames.contains(CONTACT_FOLDERS_STORE)) {
        db.createObjectStore(CONTACT_FOLDERS_STORE, { keyPath: "folderId" });
      }
      if (!db.objectStoreNames.contains(CONTACT_FOLDER_ASSIGNMENTS_STORE)) {
        const assignments = db.createObjectStore(CONTACT_FOLDER_ASSIGNMENTS_STORE, { keyPath: "contactId" });
        assignments.createIndex("byFolderId", "folderId");
      }
      if (!db.objectStoreNames.contains(MESSAGE_OUTBOX_STORE)) {
        db.createObjectStore(MESSAGE_OUTBOX_STORE, { keyPath: "messageId" });
      }
      if (!db.objectStoreNames.contains(RECEIVED_APPLICATION_MESSAGES_STORE)) {
        const received = db.createObjectStore(RECEIVED_APPLICATION_MESSAGES_STORE, { keyPath: "messageId" });
        received.createIndex("byReceivedAt", "receivedAt");
      } else {
        const received = request.transaction?.objectStore(RECEIVED_APPLICATION_MESSAGES_STORE);
        if (received !== undefined && !received.indexNames.contains("byReceivedAt")) {
          received.createIndex("byReceivedAt", "receivedAt");
        }
      }
      if (!db.objectStoreNames.contains(READ_RECEIPT_OUTBOX_STORE)) {
        const readReceipts = db.createObjectStore(READ_RECEIPT_OUTBOX_STORE, { keyPath: "targetDeliveryId" });
        readReceipts.createIndex("byContactId", "contactId");
      }
      if (!db.objectStoreNames.contains(MESSAGE_DELIVERY_TARGETS_STORE)) {
        const deliveryTargets = db.createObjectStore(MESSAGE_DELIVERY_TARGETS_STORE, { keyPath: "messageId" });
        deliveryTargets.createIndex("byDeliveryId", "deliveryId");
        deliveryTargets.createIndex("byContactId", "contactId");
        deliveryTargets.createIndex("byCreatedAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(LOCALLY_DELETED_MESSAGES_STORE)) {
        const tombstones = db.createObjectStore(LOCALLY_DELETED_MESSAGES_STORE, { keyPath: "messageId" });
        tombstones.createIndex("byDeletedAt", "deletedAt");
      }
    };
    request.onsuccess = () => { resolve(request.result); };
    request.onerror = () => { reject(request.error ?? new Error("failed to open branch-pwa database")); };
  });
}
