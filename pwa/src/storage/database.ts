// Single shared IndexedDB database for the whole PWA. Every storage module
// opens it through here so there is exactly one DATABASE_VERSION and one
// onupgradeneeded handler — opening the same database at different versions
// from different modules is a real way to deadlock IndexedDB upgrades.

const DATABASE_NAME = "branch-pwa";
// v15 adds one bounded, user-owned view of already verified public relay
// bootstrap material. It contains no messages, peers, routes-in-use, or
// attachment state; the normal live attachment challenge is still required.
// v14 adds an application-message-ID lookup index to the compact timeline.
// It resolves local reply targets without confusing a presentation message ID
// with the authenticated application identity.
// v13 adds a compact mixed text/image timeline index. It keeps the browser
// from hydrating every local conversation just to render one selected chat.
// v12 adds the split image-message projection/media stores. Metadata is
// serializable, while the corresponding Blob bytes never leave the media
// store for Zustand, diagnostics, or profile export.
// v11 adds bounded device-local deletion tombstones. They prevent an older
// asynchronous message write from reviving a locally deleted bubble; neither
// they nor the deletion action ever leave this browser's DB.
const DATABASE_VERSION = 15;

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
// Projection metadata and image bytes intentionally use distinct stores. A
// metadata bootstrap must never read every Blob into the application state.
export const IMAGE_MESSAGE_PROJECTIONS_STORE = "imageMessageProjections";
export const IMAGE_MEDIA_STORE = "imageMedia";
// This contains serializable text summaries or image projection metadata only.
// Image Blob bytes remain in IMAGE_MEDIA_STORE and never enter this index.
export const CHAT_TIMELINE_STORE = "chatTimeline";
export const RELAY_BOOTSTRAP_VIEW_STORE = "relayBootstrapView";

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
      if (!db.objectStoreNames.contains(IMAGE_MESSAGE_PROJECTIONS_STORE)) {
        const projections = db.createObjectStore(IMAGE_MESSAGE_PROJECTIONS_STORE, { keyPath: "messageId" });
        projections.createIndex("byContactId", "contactId");
        projections.createIndex("byStoredAt", "storedAt");
      }
      if (!db.objectStoreNames.contains(IMAGE_MEDIA_STORE)) {
        db.createObjectStore(IMAGE_MEDIA_STORE, { keyPath: "messageId" });
      }
      if (!db.objectStoreNames.contains(RELAY_BOOTSTRAP_VIEW_STORE)) {
        db.createObjectStore(RELAY_BOOTSTRAP_VIEW_STORE);
      }
      let timeline: IDBObjectStore;
      if (!db.objectStoreNames.contains(CHAT_TIMELINE_STORE)) {
        timeline = db.createObjectStore(CHAT_TIMELINE_STORE, { keyPath: "messageId" });
        timeline.createIndex("byContactChronology", ["contactId", "sentAt", "messageId"]);
        // The upgrade transaction migrates only existing local metadata. It
        // does not read Blobs, perform transport work, or add a durable queue.
        const messages = request.transaction?.objectStore(MESSAGES_STORE);
        const images = request.transaction?.objectStore(IMAGE_MESSAGE_PROJECTIONS_STORE);
        if (messages !== undefined) {
          const cursor = messages.openCursor();
          cursor.onsuccess = () => {
            const current = cursor.result;
            if (current === null) return;
            const value = current.value as { readonly messageId?: unknown; readonly applicationMessageId?: unknown; readonly contactId?: unknown; readonly sentAt?: unknown };
            if (typeof value.messageId === "string" && typeof value.contactId === "string" && typeof value.sentAt === "number") {
              const message: unknown = current.value;
              timeline.put({
                messageId: value.messageId,
                applicationMessageId: typeof value.applicationMessageId === "string" ? value.applicationMessageId : value.messageId,
                contactId: value.contactId,
                sentAt: value.sentAt,
                kind: "text",
                message
              });
            }
            current.continue();
          };
        }
        if (images !== undefined) {
          const cursor = images.openCursor();
          cursor.onsuccess = () => {
            const current = cursor.result;
            if (current === null) return;
            const value = current.value as { readonly messageId?: unknown; readonly contactId?: unknown; readonly sentAt?: unknown };
            if (typeof value.messageId === "string" && typeof value.contactId === "string" && typeof value.sentAt === "number") {
              const { storedAt: ignored, ...projection } = current.value as Record<string, unknown>;
              void ignored;
              timeline.put({ messageId: value.messageId, applicationMessageId: value.messageId, contactId: value.contactId, sentAt: value.sentAt, kind: "image", image: projection });
            }
            current.continue();
          };
        }
      } else {
        timeline = request.transaction?.objectStore(CHAT_TIMELINE_STORE) as IDBObjectStore;
      }
      if (!timeline.indexNames.contains("byApplicationMessageId")) {
        timeline.createIndex("byApplicationMessageId", "applicationMessageId");
        const cursor = timeline.openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (current === null) return;
          const value = current.value as Record<string, unknown>;
          const text = value.kind === "text" && typeof value.message === "object" && value.message !== null
            ? value.message as Record<string, unknown>
            : null;
          const applicationMessageId = typeof value.applicationMessageId === "string"
            ? value.applicationMessageId
            : typeof text?.applicationMessageId === "string"
              ? text.applicationMessageId
              : typeof value.messageId === "string"
                ? value.messageId
                : null;
          if (applicationMessageId !== null) current.update({ ...value, applicationMessageId });
          current.continue();
        };
      }
    };
    request.onsuccess = () => { resolve(request.result); };
    request.onerror = () => { reject(request.error ?? new Error("failed to open branch-pwa database")); };
  });
}
