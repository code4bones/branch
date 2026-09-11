import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";
import { maxConversationTimelineEntries } from "../../storage/messages-store.js";

/** Only these verified raster formats have a v0 image-message presentation. */
export type ImageMessageMediaType = "image/jpeg" | "image/png" | "image/webp";

/**
 * Serializable local presentation data for one already-verified image message.
 * The bytes, Blob and object URL belong to the storage/presentation boundary,
 * never this Zustand slice.
 */
export interface ImageMessageProjection {
  readonly messageId: string;
  readonly contactId: string;
  readonly direction: "incoming" | "outgoing";
  readonly sentAt: number;
  readonly mediaType: ImageMessageMediaType;
  readonly byteCount: number;
  readonly width: number;
  readonly height: number;
  readonly caption?: string;
  /** Exact application identity of a local source message, if still present. */
  readonly replyToMessageId?: string;
}

export const maxImageMessageProjections = 256;

export interface ImageMessageProjectionsSlice {
  readonly imageMessageProjectionsById: Readonly<Record<string, ImageMessageProjection>>;
  readonly hydrateImageMessageProjections: (projections: readonly ImageMessageProjection[]) => void;
  /** Replaces one chat's bounded metadata projection; it never reads Blob bytes. */
  readonly replaceImageMessageProjectionWindow: (contactId: string, projections: readonly ImageMessageProjection[]) => void;
  readonly stageImageMessageProjection: (projection: ImageMessageProjection) => boolean;
  readonly removeImageMessageProjections: (messageIds: readonly string[]) => void;
  readonly clearImageMessageProjectionsForContact: (contactId: string) => void;
  readonly clearImageMessageProjections: () => void;
}

export const createImageMessageProjectionsSlice: StateCreator<AppStore, [], [], ImageMessageProjectionsSlice> = (set) => ({
  imageMessageProjectionsById: {},
  hydrateImageMessageProjections: (projections) => {
    const next: Record<string, ImageMessageProjection> = {};
    for (const projection of projections) {
      if (!validImageMessageProjection(projection) || next[projection.messageId] !== undefined) continue;
      if (Object.keys(next).length >= maxImageMessageProjections) break;
      next[projection.messageId] = projection;
    }
    set({ imageMessageProjectionsById: next });
  },
  replaceImageMessageProjectionWindow: (contactId, projections) => {
    if (!boundedText(contactId, 128)) return;
    set((state) => {
      const next: Record<string, ImageMessageProjection> = {};
      for (const [messageId, projection] of Object.entries(state.imageMessageProjectionsById)) {
        if (projection.contactId !== contactId) next[messageId] = projection;
      }
      for (const projection of projections
        .filter((candidate) => candidate.contactId === contactId && validImageMessageProjection(candidate))
        .sort((left, right) => left.sentAt - right.sentAt || left.messageId.localeCompare(right.messageId))
        .slice(-maxConversationTimelineEntries)) {
        next[projection.messageId] = projection;
      }
      return { imageMessageProjectionsById: next };
    });
  },
  stageImageMessageProjection: (projection) => {
    if (!validImageMessageProjection(projection)) return false;
    let accepted = false;
    set((state) => {
      const existing = state.imageMessageProjectionsById[projection.messageId];
      if (existing !== undefined) {
        accepted = sameProjection(existing, projection);
        return state;
      }
      if (Object.keys(state.imageMessageProjectionsById).length >= maxImageMessageProjections) return state;
      accepted = true;
      return {
        imageMessageProjectionsById: {
          ...state.imageMessageProjectionsById,
          [projection.messageId]: projection
        }
      };
    });
    return accepted;
  },
  removeImageMessageProjections: (messageIds) => {
    const wanted = new Set(messageIds.filter((messageId) => boundedText(messageId, 128)).slice(0, maxImageMessageProjections));
    if (wanted.size === 0) return;
    set((state) => {
      let changed = false;
      const next: Record<string, ImageMessageProjection> = {};
      for (const [messageId, projection] of Object.entries(state.imageMessageProjectionsById)) {
        if (wanted.has(messageId)) {
          changed = true;
          continue;
        }
        next[messageId] = projection;
      }
      return changed ? { imageMessageProjectionsById: next } : state;
    });
  },
  clearImageMessageProjectionsForContact: (contactId) => {
    if (!boundedText(contactId, 128)) return;
    set((state) => {
      let changed = false;
      const next: Record<string, ImageMessageProjection> = {};
      for (const [messageId, projection] of Object.entries(state.imageMessageProjectionsById)) {
        if (projection.contactId === contactId) {
          changed = true;
          continue;
        }
        next[messageId] = projection;
      }
      return changed ? { imageMessageProjectionsById: next } : state;
    });
  },
  clearImageMessageProjections: () => { set({ imageMessageProjectionsById: {} }); }
});

export function validImageMessageProjection(value: unknown): value is ImageMessageProjection {
  if (!isRecord(value) ||
    !boundedText(value.messageId, 128) || !boundedText(value.contactId, 128) ||
    (value.direction !== "incoming" && value.direction !== "outgoing") ||
    !validTimestamp(value.sentAt) || !validImageMessageMediaType(value.mediaType) ||
    !positiveSafeInteger(value.byteCount) || !positiveSafeInteger(value.width) || !positiveSafeInteger(value.height) ||
    !optionalMessageId(value.replyToMessageId)) {
    return false;
  }
  // This keeps a malformed persisted record from forcing an unsafe arithmetic
  // value into a renderer, without fixing the protocol's image-pixel limit.
  return value.width <= Number.MAX_SAFE_INTEGER / value.height;
}

export function validImageMessageMediaType(value: unknown): value is ImageMessageMediaType {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp";
}

function sameProjection(left: ImageMessageProjection, right: ImageMessageProjection): boolean {
  return left.messageId === right.messageId && left.contactId === right.contactId &&
    left.direction === right.direction && left.sentAt === right.sentAt &&
    left.mediaType === right.mediaType && left.byteCount === right.byteCount &&
    left.width === right.width && left.height === right.height &&
    left.caption === right.caption && left.replyToMessageId === right.replyToMessageId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= maximumBytes;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function optionalMessageId(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && /^[A-Za-z0-9_-]{22}$/.test(value));
}
