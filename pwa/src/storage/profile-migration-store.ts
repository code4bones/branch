import {
  CHAT_TIMELINE_STORE,
  CONTACTS_STORE,
  IDENTITY_STORE,
  MESSAGE_OUTBOX_STORE,
  MESSAGES_STORE,
  MESSAGE_REQUESTS_STORE,
  MESSAGE_DELIVERY_TARGETS_STORE,
  IMAGE_MEDIA_STORE,
  IMAGE_MESSAGE_PROJECTIONS_STORE,
  RECEIVED_APPLICATION_MESSAGES_STORE,
  READ_RECEIPT_OUTBOX_STORE,
  READ_STATE_STORE,
  openDatabase
} from "./database.js";
import type { PortableProfileSnapshot } from "../profile/profile-bundle.js";
import type { ContactSummary } from "../state/slices/contacts-slice.js";
import type { MessageSummary } from "../state/slices/conversations-slice.js";
import type { IncomingMessageRequest } from "../state/slices/message-requests-slice.js";
import type { StoredIdentityRecord } from "./identity-store.js";

const identityRecordKey = "local";

// The portable subset is deliberately explicit. Device-local folders,
// discovery probes/policy, receipt preferences, UI selection, live routes,
// attachment handles, image message bytes/projections, diagnostics, the
// device-local outbox, and received-ID dedup metadata never enter this
// transaction. Image export needs a dedicated bounded encrypted media format;
// it is deliberately absent from the v0 profile container.
export async function loadPortableProfileSnapshot(): Promise<PortableProfileSnapshot> {
  const db = await openDatabase();
  try {
    return await new Promise<PortableProfileSnapshot>((resolve, reject) => {
      const transaction = db.transaction([IDENTITY_STORE, CONTACTS_STORE, MESSAGES_STORE, READ_STATE_STORE, MESSAGE_REQUESTS_STORE], "readonly");
      const identityRequest = transaction.objectStore(IDENTITY_STORE).get(identityRecordKey);
      const contactsRequest = transaction.objectStore(CONTACTS_STORE).getAll();
      const messagesRequest = transaction.objectStore(MESSAGES_STORE).getAll();
      const requestsRequest = transaction.objectStore(MESSAGE_REQUESTS_STORE).getAll();
      const readState: Record<string, number> = {};
      const readStateRequest = transaction.objectStore(READ_STATE_STORE).openCursor();
      readStateRequest.onsuccess = () => {
        const cursor = readStateRequest.result;
        if (cursor !== null) {
          if (typeof cursor.key !== "string" || typeof cursor.value !== "number") {
            transaction.abort();
            return;
          }
          readState[cursor.key] = cursor.value;
          cursor.continue();
        }
      };
      transaction.oncomplete = () => {
        const identity = identityRequest.result as StoredIdentityRecord | undefined;
        if (identity === undefined) {
          reject(new Error("local identity not found"));
          return;
        }
        resolve({
          identity,
          contacts: contactsRequest.result as ContactSummary[],
          messages: messagesRequest.result as MessageSummary[],
          readState,
          messageRequests: requestsRequest.result as IncomingMessageRequest[]
        });
      };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to read portable profile")); };
      transaction.onabort = () => { reject(transaction.error ?? new Error("failed to read portable profile")); };
    });
  } finally {
    db.close();
  }
}

// Called only after crypto and every payload relation has been verified. This
// replacement is one IDB transaction: observers see either the old profile or
// the complete imported portable subset, never a partial history.
export async function replacePortableProfileSnapshot(snapshot: PortableProfileSnapshot): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([
        IDENTITY_STORE,
        CONTACTS_STORE,
        MESSAGES_STORE,
        CHAT_TIMELINE_STORE,
        READ_STATE_STORE,
        MESSAGE_REQUESTS_STORE,
        MESSAGE_OUTBOX_STORE,
        RECEIVED_APPLICATION_MESSAGES_STORE,
        READ_RECEIPT_OUTBOX_STORE,
        MESSAGE_DELIVERY_TARGETS_STORE,
        IMAGE_MESSAGE_PROJECTIONS_STORE,
        IMAGE_MEDIA_STORE
      ], "readwrite");
      const identity = transaction.objectStore(IDENTITY_STORE);
      const contacts = transaction.objectStore(CONTACTS_STORE);
      const messages = transaction.objectStore(MESSAGES_STORE);
      const timeline = transaction.objectStore(CHAT_TIMELINE_STORE);
      const readState = transaction.objectStore(READ_STATE_STORE);
      const requests = transaction.objectStore(MESSAGE_REQUESTS_STORE);
      const outbox = transaction.objectStore(MESSAGE_OUTBOX_STORE);
      const receivedApplicationMessages = transaction.objectStore(RECEIVED_APPLICATION_MESSAGES_STORE);
      const readReceiptOutbox = transaction.objectStore(READ_RECEIPT_OUTBOX_STORE);
      const messageDeliveryTargets = transaction.objectStore(MESSAGE_DELIVERY_TARGETS_STORE);
      const imageMessageProjections = transaction.objectStore(IMAGE_MESSAGE_PROJECTIONS_STORE);
      const imageMedia = transaction.objectStore(IMAGE_MEDIA_STORE);
      identity.clear();
      contacts.clear();
      messages.clear();
      timeline.clear();
      readState.clear();
      requests.clear();
      // These endpoint-local records are deliberately not portable. Clearing
      // them with an identity replacement prevents an old tab's queued retry
      // from being sent under the imported profile.
      outbox.clear();
      receivedApplicationMessages.clear();
      readReceiptOutbox.clear();
      messageDeliveryTargets.clear();
      // A portable profile intentionally contains no image bytes. Remove prior
      // origin-owned media atomically with this identity replacement so it
      // cannot remain attached to an unrelated imported history.
      imageMessageProjections.clear();
      imageMedia.clear();
      identity.put(snapshot.identity, identityRecordKey);
      for (const contact of snapshot.contacts) contacts.put(contact);
      for (const message of snapshot.messages) {
        messages.put(message);
        timeline.put({ messageId: message.messageId, contactId: message.contactId, sentAt: message.sentAt, kind: "text", message });
      }
      for (const [contactId, timestamp] of Object.entries(snapshot.readState)) readState.put(timestamp, contactId);
      for (const request of snapshot.messageRequests) requests.put(request);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to replace portable profile")); };
      transaction.onabort = () => { reject(transaction.error ?? new Error("failed to replace portable profile")); };
    });
  } finally {
    db.close();
  }
}
