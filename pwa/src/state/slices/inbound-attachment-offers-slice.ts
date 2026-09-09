import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";

/** This is an intentionally small UI admission bound, separate from transfer state. */
export const maxInboundAttachmentOffers = 16;

export type InboundAttachmentOfferDecision = "accept" | "reject";
export type InboundAttachmentOfferResponse = "sent" | "failed" | "not_found";

/**
 * Metadata surfaced only after the attachment adapter has verified a manifest.
 * File bytes, a manifest signature, digest, and chunk state never enter this
 * UI projection.
 */
export interface InboundAttachmentOffer {
  readonly peerId: string;
  readonly transferId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteCount: number;
  readonly expiresAt: number;
  readonly receivedAt: number;
  readonly responseState: "pending" | "responding";
  readonly responseError: string | null;
}

/**
 * Connectivity may stage an offer only after signature, known-contact, replay,
 * expiry, and controller admission checks. The callbacks are deliberately not
 * retained in Zustand: they are live tab-local bridges to the adapter only.
 */
export interface VerifiedInboundAttachmentOffer {
  readonly peerId: string;
  readonly transferId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteCount: number;
  readonly expiresAt: number;
  readonly receivedAt: number;
  readonly onAccept: () => Promise<void>;
  readonly onReject: () => Promise<void>;
}

export interface InboundAttachmentOffersSlice {
  readonly inboundAttachmentOffersByPeerId: Readonly<Record<string, InboundAttachmentOffer>>;
  readonly stageVerifiedInboundAttachmentOffer: (offer: VerifiedInboundAttachmentOffer) => boolean;
  readonly respondToInboundAttachmentOffer: (peerId: string, decision: InboundAttachmentOfferDecision) => Promise<InboundAttachmentOfferResponse>;
  readonly dismissInboundAttachmentOffer: (peerId: string) => void;
  readonly clearInboundAttachmentOffers: () => void;
}

interface OfferCallbacks {
  readonly transferId: string;
  readonly onAccept: () => Promise<void>;
  readonly onReject: () => Promise<void>;
}

// This map is allocated per app-store instance, remains outside persisted UI
// state, and is emptied when an offer leaves the visible projection. It avoids
// giving a renderer either a controller instance or an identity/transport key.
export const createInboundAttachmentOffersSlice: StateCreator<AppStore, [], [], InboundAttachmentOffersSlice> = (set, get) => {
  const callbacksByPeerId = new Map<string, OfferCallbacks>();

  const dismiss = (peerId: string): void => {
    callbacksByPeerId.delete(peerId);
    set((state) => {
      const { [peerId]: removed, ...inboundAttachmentOffersByPeerId } = state.inboundAttachmentOffersByPeerId;
      void removed;
      return { inboundAttachmentOffersByPeerId };
    });
  };

  return {
    inboundAttachmentOffersByPeerId: {},
    stageVerifiedInboundAttachmentOffer: (offer) => {
      if (!validOffer(offer) || get().inboundAttachmentOffersByPeerId[offer.peerId] !== undefined) {
        return false;
      }
      const current = get().inboundAttachmentOffersByPeerId;
      if (Object.keys(current).length >= maxInboundAttachmentOffers) {
        return false;
      }
      callbacksByPeerId.set(offer.peerId, {
        transferId: offer.transferId,
        onAccept: offer.onAccept,
        onReject: offer.onReject
      });
      set({
        inboundAttachmentOffersByPeerId: {
          ...current,
          [offer.peerId]: {
            peerId: offer.peerId,
            transferId: offer.transferId,
            fileName: offer.fileName,
            mediaType: offer.mediaType,
            byteCount: offer.byteCount,
            expiresAt: offer.expiresAt,
            receivedAt: offer.receivedAt,
            responseState: "pending",
            responseError: null
          }
        }
      });
      return true;
    },
    respondToInboundAttachmentOffer: async (peerId, decision) => {
      const offer = get().inboundAttachmentOffersByPeerId[peerId];
      const callbacks = callbacksByPeerId.get(peerId);
      if (offer === undefined || callbacks === undefined || callbacks.transferId !== offer.transferId || offer.responseState === "responding") {
        return "not_found";
      }
      set((state) => ({
        inboundAttachmentOffersByPeerId: {
          ...state.inboundAttachmentOffersByPeerId,
          [peerId]: { ...offer, responseState: "responding", responseError: null }
        }
      }));
      try {
        await (decision === "accept" ? callbacks.onAccept() : callbacks.onReject());
        // The adapter may synchronously receive a cancellation while the
        // decision is in flight. Never dismiss a newer offer for that peer.
        if (get().inboundAttachmentOffersByPeerId[peerId]?.transferId === offer.transferId) {
          dismiss(peerId);
        }
        return "sent";
      } catch {
        if (get().inboundAttachmentOffersByPeerId[peerId]?.transferId === offer.transferId) {
          set((state) => ({
            inboundAttachmentOffersByPeerId: {
              ...state.inboundAttachmentOffersByPeerId,
              [peerId]: { ...offer, responseState: "pending", responseError: "Could not send your decision while this live offer is available." }
            }
          }));
        }
        return "failed";
      }
    },
    dismissInboundAttachmentOffer: dismiss,
    clearInboundAttachmentOffers: () => {
      callbacksByPeerId.clear();
      set({ inboundAttachmentOffersByPeerId: {} });
    }
  };
};

function validOffer(offer: VerifiedInboundAttachmentOffer): boolean {
  return boundedText(offer.peerId, 512) && boundedText(offer.transferId, 128) && boundedText(offer.fileName, 160) &&
    boundedText(offer.mediaType, 128) && Number.isSafeInteger(offer.byteCount) && offer.byteCount > 0 &&
    Number.isSafeInteger(offer.expiresAt) && offer.expiresAt > 0 && Number.isSafeInteger(offer.receivedAt) && offer.receivedAt > 0;
}

function boundedText(value: string, maximumBytes: number): boolean {
  return value.length > 0 && new TextEncoder().encode(value).byteLength <= maximumBytes;
}
