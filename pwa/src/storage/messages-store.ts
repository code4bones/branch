import {
  LOCALLY_DELETED_MESSAGES_STORE,
  MESSAGES_STORE,
  MESSAGE_DELIVERY_TARGETS_STORE,
  MESSAGE_OUTBOX_STORE,
  openDatabase
} from "./database.js";
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
      const transaction = db.transaction([MESSAGES_STORE, LOCALLY_DELETED_MESSAGES_STORE], "readwrite");
      const tombstones = transaction.objectStore(LOCALLY_DELETED_MESSAGES_STORE);
      const existingDeletion = tombstones.getKey(message.messageId);
      existingDeletion.onsuccess = () => {
        // A local delete wins over an older queued persistence operation. The
        // tombstone is local UI safety metadata, never a network dedup record.
        if (existingDeletion.result === undefined) {
          transaction.objectStore(MESSAGES_STORE).put(message);
        }
      };
      existingDeletion.onerror = () => { reject(existingDeletion.error ?? new Error("failed to read local deletion marker")); };
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to write message")); };
    });
  } finally {
    db.close();
  }
}

const maxStoredLocalDeletionTombstones = 256;

// Delete only user-owned local projections and their source-addressable local
// retry/receipt metadata. This one IndexedDB transaction cannot signal a peer,
// alter an already-live relay delivery, or remove anything outside this device.
export async function deleteStoredMessagesLocally(messageIds: readonly string[], deletedAt: number): Promise<void> {
  const uniqueMessageIds = [...new Set(messageIds)].filter((messageId) => messageId !== "").slice(0, maxStoredLocalDeletionTombstones);
  if (uniqueMessageIds.length === 0) return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([
        MESSAGES_STORE,
        MESSAGE_OUTBOX_STORE,
        MESSAGE_DELIVERY_TARGETS_STORE,
        LOCALLY_DELETED_MESSAGES_STORE
      ], "readwrite");
      const messages = transaction.objectStore(MESSAGES_STORE);
      const outbox = transaction.objectStore(MESSAGE_OUTBOX_STORE);
      const targets = transaction.objectStore(MESSAGE_DELIVERY_TARGETS_STORE);
      const tombstones = transaction.objectStore(LOCALLY_DELETED_MESSAGES_STORE);
      for (const messageId of uniqueMessageIds) {
        messages.delete(messageId);
        outbox.delete(messageId);
        targets.delete(messageId);
        tombstones.put({ messageId, deletedAt });
      }
      // Keep this crash-safe local guard bounded. It only protects currently
      // possible delayed writes; it is not history, transport state, or export.
      let retained = 0;
      const cursorRequest = tombstones.index("byDeletedAt").openCursor(null, "prev");
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor === null) return;
        retained += 1;
        if (retained > maxStoredLocalDeletionTombstones) cursor.delete();
        cursor.continue();
      };
      cursorRequest.onerror = () => { reject(cursorRequest.error ?? new Error("failed to trim local deletion markers")); };
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to delete local messages")); };
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
