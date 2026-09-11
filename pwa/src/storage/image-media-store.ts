import {
  CHAT_TIMELINE_STORE,
  IMAGE_MEDIA_STORE,
  IMAGE_MESSAGE_PROJECTIONS_STORE,
  openDatabase
} from "./database.js";
import {
  maxImageMessageProjections,
  type ImageMessageProjection,
  validImageMessageProjection
} from "../state/slices/image-message-projections-slice.js";

/** Device-local media quota. This is not a relay or wire-protocol limit. */
export const maxStoredImageMediaBytes = 64 * 1024 * 1024;

export type StoreVerifiedImageMessageResult = "stored" | "already_stored" | "capacity_exceeded" | "conflict" | "invalid";

export interface ImageMessageMediaStorePort {
  readonly storeVerified: (projection: ImageMessageProjection, bytes: Uint8Array) => Promise<StoreVerifiedImageMessageResult>;
  readonly loadProjectionMetadata: () => Promise<readonly ImageMessageProjection[]>;
  readonly loadBlob: (messageId: string) => Promise<Blob | null>;
  readonly deleteMessages: (messageIds: readonly string[]) => Promise<void>;
  readonly deleteContact: (contactId: string) => Promise<void>;
  readonly clear: () => Promise<void>;
}

interface StoredProjection extends ImageMessageProjection {
  readonly storedAt: number;
}

interface StoredImageMedia {
  readonly messageId: string;
  readonly bytes: Blob;
}

/**
 * Browser-owned byte storage. It accepts bytes only after the caller's image
 * descriptor/transfer layer has completed authentication and media checks.
 * The storage adapter intentionally never logs, hashes, serializes or exposes
 * bytes through Zustand.
 */
export const imageMessageMediaStore: ImageMessageMediaStorePort = {
  storeVerified: storeVerifiedImageMessage,
  loadProjectionMetadata: loadStoredImageMessageProjections,
  loadBlob: loadStoredImageMessageBlob,
  deleteMessages: deleteStoredImageMessages,
  deleteContact: deleteStoredImageMessagesForContact,
  clear: clearStoredImageMessages
};

export async function storeVerifiedImageMessage(projection: ImageMessageProjection, bytes: Uint8Array): Promise<StoreVerifiedImageMessageResult> {
  if (!validImageMessageProjection(projection) || bytes.byteLength !== projection.byteCount || projection.byteCount > maxStoredImageMediaBytes) {
    return "invalid";
  }
  const db = await openDatabase();
  try {
    return await new Promise<StoreVerifiedImageMessageResult>((resolve, reject) => {
      const transaction = db.transaction([IMAGE_MESSAGE_PROJECTIONS_STORE, IMAGE_MEDIA_STORE, CHAT_TIMELINE_STORE], "readwrite");
      const projections = transaction.objectStore(IMAGE_MESSAGE_PROJECTIONS_STORE);
      const media = transaction.objectStore(IMAGE_MEDIA_STORE);
      const timeline = transaction.objectStore(CHAT_TIMELINE_STORE);
      const existingRequest = projections.get(projection.messageId);
      let result: StoreVerifiedImageMessageResult = "invalid";
      existingRequest.onsuccess = () => {
        const existing = storedProjection(existingRequest.result);
        if (existing !== null) {
          result = sameProjection(existing, projection) ? "already_stored" : "conflict";
          return;
        }
        const allRequest = projections.getAll();
        allRequest.onsuccess = () => {
          const current = allRequest.result.flatMap((value) => {
            const record = storedProjection(value);
            return record === null ? [] : [record];
          });
          const storedBytes = current.reduce((total, record) => total + record.byteCount, 0);
          if (current.length >= maxImageMessageProjections || storedBytes + projection.byteCount > maxStoredImageMediaBytes) {
            result = "capacity_exceeded";
            return;
          }
          const copied = new Uint8Array(bytes);
          const record: StoredProjection = { ...projection, storedAt: Date.now() };
          const mediaRecord: StoredImageMedia = {
            messageId: projection.messageId,
            bytes: new Blob([copied.buffer], { type: projection.mediaType })
          };
          projections.put(record);
          media.put(mediaRecord);
          timeline.put({ messageId: projection.messageId, contactId: projection.contactId, sentAt: projection.sentAt, kind: "image", image: projection });
          result = "stored";
        };
        allRequest.onerror = () => { transaction.abort(); reject(allRequest.error ?? new Error("failed to inspect image media capacity")); };
      };
      existingRequest.onerror = () => { transaction.abort(); reject(existingRequest.error ?? new Error("failed to inspect stored image")); };
      transaction.oncomplete = () => { resolve(result); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to store verified image")); };
      transaction.onabort = () => { reject(transaction.error ?? new Error("failed to store verified image")); };
    });
  } finally {
    db.close();
  }
}

export async function loadStoredImageMessageProjections(): Promise<readonly ImageMessageProjection[]> {
  const db = await openDatabase();
  try {
    return await new Promise<readonly ImageMessageProjection[]>((resolve, reject) => {
      const request = db.transaction(IMAGE_MESSAGE_PROJECTIONS_STORE, "readonly").objectStore(IMAGE_MESSAGE_PROJECTIONS_STORE).getAll();
      request.onsuccess = () => {
        resolve(request.result.flatMap((value) => {
          const record = storedProjection(value);
          return record === null ? [] : [withoutStoredAt(record)];
        }).slice(0, maxImageMessageProjections));
      };
      request.onerror = () => { reject(request.error ?? new Error("failed to read image projections")); };
    });
  } finally {
    db.close();
  }
}

export async function loadStoredImageMessageBlob(messageId: string): Promise<Blob | null> {
  if (!validMessageId(messageId)) return null;
  const db = await openDatabase();
  try {
    return await new Promise<Blob | null>((resolve, reject) => {
      const request = db.transaction(IMAGE_MEDIA_STORE, "readonly").objectStore(IMAGE_MEDIA_STORE).get(messageId);
      request.onsuccess = () => {
        const record: unknown = request.result;
        resolve(isStoredImageMedia(record, messageId) ? record.bytes : null);
      };
      request.onerror = () => { reject(request.error ?? new Error("failed to read image media")); };
    });
  } finally {
    db.close();
  }
}

export async function deleteStoredImageMessages(messageIds: readonly string[]): Promise<void> {
  const unique = [...new Set(messageIds.filter(validMessageId))].slice(0, maxImageMessageProjections);
  if (unique.length === 0) return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([IMAGE_MESSAGE_PROJECTIONS_STORE, IMAGE_MEDIA_STORE, CHAT_TIMELINE_STORE], "readwrite");
      const projections = transaction.objectStore(IMAGE_MESSAGE_PROJECTIONS_STORE);
      const media = transaction.objectStore(IMAGE_MEDIA_STORE);
      const timeline = transaction.objectStore(CHAT_TIMELINE_STORE);
      for (const messageId of unique) {
        projections.delete(messageId);
        media.delete(messageId);
        timeline.delete(messageId);
      }
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to delete image media")); };
      transaction.onabort = () => { reject(transaction.error ?? new Error("failed to delete image media")); };
    });
  } finally {
    db.close();
  }
}

export async function deleteStoredImageMessagesForContact(contactId: string): Promise<void> {
  if (!validContactId(contactId)) return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([IMAGE_MESSAGE_PROJECTIONS_STORE, IMAGE_MEDIA_STORE, CHAT_TIMELINE_STORE], "readwrite");
      const projections = transaction.objectStore(IMAGE_MESSAGE_PROJECTIONS_STORE);
      const media = transaction.objectStore(IMAGE_MEDIA_STORE);
      const timeline = transaction.objectStore(CHAT_TIMELINE_STORE);
      const cursorRequest = projections.index("byContactId").openCursor(IDBKeyRange.only(contactId));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor === null) return;
        if (typeof cursor.primaryKey === "string") {
          media.delete(cursor.primaryKey);
          timeline.delete(cursor.primaryKey);
        }
        cursor.delete();
        cursor.continue();
      };
      cursorRequest.onerror = () => { transaction.abort(); reject(cursorRequest.error ?? new Error("failed to delete contact image media")); };
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to delete contact image media")); };
      transaction.onabort = () => { reject(transaction.error ?? new Error("failed to delete contact image media")); };
    });
  } finally {
    db.close();
  }
}

export async function clearStoredImageMessages(): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([IMAGE_MESSAGE_PROJECTIONS_STORE, IMAGE_MEDIA_STORE, CHAT_TIMELINE_STORE], "readwrite");
      transaction.objectStore(IMAGE_MESSAGE_PROJECTIONS_STORE).clear();
      transaction.objectStore(IMAGE_MEDIA_STORE).clear();
      const timeline = transaction.objectStore(CHAT_TIMELINE_STORE);
      const cursorRequest = timeline.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor === null) return;
        const value = cursor.value as { readonly kind?: unknown };
        if (value.kind === "image") cursor.delete();
        cursor.continue();
      };
      cursorRequest.onerror = () => { transaction.abort(); reject(cursorRequest.error ?? new Error("failed to clear image timeline metadata")); };
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to clear image media")); };
      transaction.onabort = () => { reject(transaction.error ?? new Error("failed to clear image media")); };
    });
  } finally {
    db.close();
  }
}

function storedProjection(value: unknown): StoredProjection | null {
  if (!isRecord(value) || !validImageMessageProjection(value) || !validTimestamp(value.storedAt)) return null;
  return { ...value, storedAt: value.storedAt } as StoredProjection;
}

function withoutStoredAt(record: StoredProjection): ImageMessageProjection {
  const { storedAt: ignored, ...projection } = record;
  void ignored;
  return projection;
}

function isStoredImageMedia(value: unknown, messageId: string): value is StoredImageMedia {
  return isRecord(value) && value.messageId === messageId && value.bytes instanceof Blob;
}

function sameProjection(left: ImageMessageProjection, right: ImageMessageProjection): boolean {
  return left.messageId === right.messageId && left.contactId === right.contactId && left.direction === right.direction &&
    left.sentAt === right.sentAt && left.mediaType === right.mediaType && left.byteCount === right.byteCount &&
    left.width === right.width && left.height === right.height;
}

function validMessageId(value: unknown): value is string {
  return boundedText(value, 128);
}

function validContactId(value: unknown): value is string {
  return boundedText(value, 128);
}

function boundedText(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= maximumBytes;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
