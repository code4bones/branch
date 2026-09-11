import {
  CHAT_TIMELINE_STORE,
  LOCALLY_DELETED_MESSAGES_STORE,
  MESSAGES_STORE,
  MESSAGE_DELIVERY_TARGETS_STORE,
  MESSAGE_OUTBOX_STORE,
  openDatabase
} from "./database.js";
import type { MessageSummary } from "../state/slices/conversations-slice.js";
import { type ImageMessageProjection, validImageMessageProjection } from "../state/slices/image-message-projections-slice.js";

export const initialConversationTimelineEntries = 64;
export const conversationTimelinePageEntries = 48;
export const maxConversationTimelineEntries = 192;

export interface ConversationTimelineCursor {
  readonly sentAt: number;
  readonly messageId: string;
}

export type ConversationTimelineEntry =
  | { readonly kind: "text"; readonly message: MessageSummary; readonly messageId: string; readonly sentAt: number }
  | { readonly kind: "image"; readonly image: ImageMessageProjection; readonly messageId: string; readonly sentAt: number };

export interface ConversationTimelinePage {
  readonly entries: readonly ConversationTimelineEntry[];
  readonly hasOlder: boolean;
}

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

/**
 * Reads a bounded local history page in chronological order. The exclusive
 * cursor is a presentation key only: it is never a protocol, transport, or
 * relay identifier.
 */
export async function loadStoredTimelinePage(contactId: string, before: ConversationTimelineCursor | null, limit: number): Promise<ConversationTimelinePage> {
  if (!validContactId(contactId) || !validTimelineLimit(limit)) return { entries: [], hasOlder: false };
  const db = await openDatabase();
  try {
    return await new Promise<ConversationTimelinePage>((resolve, reject) => {
      const index = db.transaction(CHAT_TIMELINE_STORE, "readonly").objectStore(CHAT_TIMELINE_STORE).index("byContactChronology");
      const upper = before === null
        ? [contactId, Number.MAX_SAFE_INTEGER, "\uffff"]
        : [contactId, before.sentAt, before.messageId];
      const range = IDBKeyRange.bound([contactId, 0, ""], upper, false, before !== null);
      const entries: ConversationTimelineEntry[] = [];
      const request = index.openCursor(range, "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null || entries.length >= limit + 1) {
          const hasOlder = entries.length > limit;
          resolve({ entries: entries.slice(0, limit).reverse(), hasOlder });
          return;
        }
        const entry = timelineEntry(cursor.value);
        if (entry !== null) entries.push(entry);
        cursor.continue();
      };
      request.onerror = () => { reject(request.error ?? new Error("failed to read local conversation timeline")); };
    });
  } finally {
    db.close();
  }
}

export async function loadStoredTimelineEntryByApplicationMessageId(applicationMessageId: string): Promise<ConversationTimelineEntry | null> {
  if (!validMessageId(applicationMessageId)) return null;
  const db = await openDatabase();
  try {
    return await new Promise<ConversationTimelineEntry | null>((resolve, reject) => {
      const request = db.transaction(CHAT_TIMELINE_STORE, "readonly").objectStore(CHAT_TIMELINE_STORE).index("byApplicationMessageId").get(applicationMessageId);
      request.onsuccess = () => { resolve(timelineEntry(request.result)); };
      request.onerror = () => { reject(request.error ?? new Error("failed to read local timeline entry")); };
    });
  } finally {
    db.close();
  }
}

/** Reads the bounded newer half of a local target-centred history window. */
export async function loadStoredTimelineEntriesAfter(contactId: string, after: ConversationTimelineCursor, limit: number): Promise<readonly ConversationTimelineEntry[]> {
  if (!validContactId(contactId) || !validTimelineCursor(after) || !validTimelineLimit(limit)) return [];
  const db = await openDatabase();
  try {
    return await new Promise<readonly ConversationTimelineEntry[]>((resolve, reject) => {
      const index = db.transaction(CHAT_TIMELINE_STORE, "readonly").objectStore(CHAT_TIMELINE_STORE).index("byContactChronology");
      const range = IDBKeyRange.bound(
        [contactId, after.sentAt, after.messageId],
        [contactId, Number.MAX_SAFE_INTEGER, "\uffff"],
        true,
        false
      );
      const entries: ConversationTimelineEntry[] = [];
      const request = index.openCursor(range, "next");
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null || entries.length >= limit) {
          resolve(entries);
          return;
        }
        const entry = timelineEntry(cursor.value);
        if (entry !== null) entries.push(entry);
        cursor.continue();
      };
      request.onerror = () => { reject(request.error ?? new Error("failed to read newer local timeline entries")); };
    });
  } finally {
    db.close();
  }
}

export async function saveStoredMessage(message: MessageSummary): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([MESSAGES_STORE, CHAT_TIMELINE_STORE, LOCALLY_DELETED_MESSAGES_STORE], "readwrite");
      const tombstones = transaction.objectStore(LOCALLY_DELETED_MESSAGES_STORE);
      const existingDeletion = tombstones.getKey(message.messageId);
      existingDeletion.onsuccess = () => {
        // A local delete wins over an older queued persistence operation. The
        // tombstone is local UI safety metadata, never a network dedup record.
        if (existingDeletion.result === undefined) {
          transaction.objectStore(MESSAGES_STORE).put(message);
          transaction.objectStore(CHAT_TIMELINE_STORE).put(timelineRecordForMessage(message));
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
        CHAT_TIMELINE_STORE,
        MESSAGE_OUTBOX_STORE,
        MESSAGE_DELIVERY_TARGETS_STORE,
        LOCALLY_DELETED_MESSAGES_STORE
      ], "readwrite");
      const messages = transaction.objectStore(MESSAGES_STORE);
      const timeline = transaction.objectStore(CHAT_TIMELINE_STORE);
      const outbox = transaction.objectStore(MESSAGE_OUTBOX_STORE);
      const targets = transaction.objectStore(MESSAGE_DELIVERY_TARGETS_STORE);
      const tombstones = transaction.objectStore(LOCALLY_DELETED_MESSAGES_STORE);
      for (const messageId of uniqueMessageIds) {
        messages.delete(messageId);
        timeline.delete(messageId);
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
      const transaction = db.transaction([MESSAGES_STORE, CHAT_TIMELINE_STORE], "readwrite");
      const store = transaction.objectStore(MESSAGES_STORE);
      const timeline = transaction.objectStore(CHAT_TIMELINE_STORE);
      store.delete(previousMessageId);
      store.put(replacement);
      timeline.delete(previousMessageId);
      timeline.put(timelineRecordForMessage(replacement));
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to replace retried message")); };
    });
  } finally {
    db.close();
  }
}

export async function deleteStoredMessagesForContact(contactId: string, deletedAt: number = Date.now()): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([MESSAGES_STORE, CHAT_TIMELINE_STORE, LOCALLY_DELETED_MESSAGES_STORE], "readwrite");
      const request = transaction.objectStore(MESSAGES_STORE).index("byContactId").openCursor(IDBKeyRange.only(contactId));
      const timeline = transaction.objectStore(CHAT_TIMELINE_STORE);
      const tombstones = transaction.objectStore(LOCALLY_DELETED_MESSAGES_STORE);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor !== null) {
          if (typeof cursor.primaryKey === "string") {
            timeline.delete(cursor.primaryKey);
            tombstones.put({ messageId: cursor.primaryKey, deletedAt });
          }
          cursor.delete();
          cursor.continue();
        }
      };
      let retained = 0;
      const trimRequest = tombstones.index("byDeletedAt").openCursor(null, "prev");
      trimRequest.onsuccess = () => {
        const cursor = trimRequest.result;
        if (cursor === null) return;
        retained += 1;
        if (retained > maxStoredLocalDeletionTombstones) cursor.delete();
        cursor.continue();
      };
      trimRequest.onerror = () => { reject(trimRequest.error ?? new Error("failed to trim local deletion markers")); };
      request.onerror = () => { reject(request.error ?? new Error("failed to delete contact messages")); };
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to delete contact messages")); };
    });
  } finally {
    db.close();
  }
}

function timelineRecordForMessage(message: MessageSummary): Record<string, unknown> {
  return {
    messageId: message.messageId,
    applicationMessageId: message.applicationMessageId ?? message.messageId,
    contactId: message.contactId,
    sentAt: message.sentAt,
    kind: "text",
    message
  };
}

function timelineEntry(value: unknown): ConversationTimelineEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!validMessageId(record.messageId) || !validTimestamp(record.sentAt)) return null;
  if (record.kind === "text" && validMessageSummary(record.message) && record.message.messageId === record.messageId && record.message.sentAt === record.sentAt) {
    return { kind: "text", message: record.message, messageId: record.messageId, sentAt: record.sentAt };
  }
  if (record.kind === "image" && validImageMessageProjection(record.image) && record.image.messageId === record.messageId && record.image.sentAt === record.sentAt) {
    return { kind: "image", image: record.image, messageId: record.messageId, sentAt: record.sentAt };
  }
  return null;
}

function validMessageSummary(value: unknown): value is MessageSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return validMessageId(message.messageId) && validContactId(message.contactId) && typeof message.body === "string" &&
    validTimestamp(message.sentAt) && (message.direction === "incoming" || message.direction === "outgoing" || message.direction === "service") &&
    (message.deliveryState === "pending" || message.deliveryState === "relayed" || message.deliveryState === "delivered" || message.deliveryState === "read" || message.deliveryState === "received" || message.deliveryState === "unavailable");
}

function validMessageId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function validContactId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validTimelineLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= initialConversationTimelineEntries;
}

function validTimelineCursor(value: ConversationTimelineCursor): boolean {
  return validTimestamp(value.sentAt) && validMessageId(value.messageId);
}
