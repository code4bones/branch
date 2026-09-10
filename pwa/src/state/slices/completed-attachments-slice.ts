import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";

/** A renderer-only projection; its byte handle lives outside Zustand. */
export interface CompletedAttachment {
  readonly peerId: string;
  readonly transferId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteCount: number;
  readonly expiresAt: number;
  readonly completedAt: number;
}

export interface CompletedAttachmentsSlice {
  readonly completedAttachmentsByPeerId: Readonly<Record<string, CompletedAttachment>>;
  readonly setCompletedAttachmentProjection: (attachment: CompletedAttachment) => void;
  readonly clearCompletedAttachmentProjection: (peerId: string) => void;
  readonly clearCompletedAttachmentProjections: () => void;
  /** Installs tab-local byte cleanup; the callback itself never enters state. */
  readonly bindCompletedAttachmentHandleCleanup: (cleanup: CompletedAttachmentHandleCleanup | null) => void;
}

export interface CompletedAttachmentHandleCleanup {
  readonly clearPeer: (peerId: string) => void;
  readonly clearAll: () => void;
}

/**
 * This slice intentionally contains metadata only. The matching verified bytes
 * are owned by the tab-local presentation registry, never by Zustand or a
 * persistence adapter.
 */
export const createCompletedAttachmentsSlice: StateCreator<AppStore, [], [], CompletedAttachmentsSlice> = (set) => {
  // Keep the only private-byte cleanup link in the slice closure, not in the
  // serializable Zustand projection. This permits contacts to clean their own
  // transient handle without importing an app feature or storage adapter.
  let handleCleanup: CompletedAttachmentHandleCleanup | null = null;
  return {
    completedAttachmentsByPeerId: {},
    setCompletedAttachmentProjection: (attachment) => {
      set((state) => ({
        completedAttachmentsByPeerId: {
          ...state.completedAttachmentsByPeerId,
          [attachment.peerId]: attachment
        }
      }));
    },
    clearCompletedAttachmentProjection: (peerId) => {
      handleCleanup?.clearPeer(peerId);
      set((state) => {
        const { [peerId]: removed, ...completedAttachmentsByPeerId } = state.completedAttachmentsByPeerId;
        void removed;
        return { completedAttachmentsByPeerId };
      });
    },
    clearCompletedAttachmentProjections: () => {
      handleCleanup?.clearAll();
      set({ completedAttachmentsByPeerId: {} });
    },
    bindCompletedAttachmentHandleCleanup: (cleanup) => {
      handleCleanup = cleanup;
    }
  };
};
