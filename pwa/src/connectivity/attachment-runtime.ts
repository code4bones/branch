import { decodeBase64URL, type AttachmentManifest } from "@code4bones/branch-core";

import { installAttachmentSendBridge, notifyAttachmentSendProgress } from "../app/attachment-send-bridge.js";
import { getLocalIdentityKeys } from "../identity/identity-keys.js";
import type { AppStoreApi } from "../state/store.js";
import { peerApplicationCapabilities } from "./application-capabilities-control.js";
import {
  AttachmentTransferController,
  type InboundAttachmentOffer
} from "./attachment-transfer.js";
import { hasAttachedRelaySession, setLiveForwardedAckListener } from "./relay-session.js";
import { sendApplicationPayload } from "./seal-and-send.js";

// One tab owns one volatile transfer controller. It is deliberately separate
// from Zustand and from relay-session: neither a File nor partial plaintext
// bytes can become UI state, relay state, or durable storage.
let active: {
  readonly storeApi: AppStoreApi;
  readonly controller: AttachmentTransferController;
  readonly clearSendBridge: () => void;
} | null = null;

/**
 * The UI may install one in-tab receiver for a verified file. This bridge is
 * intentionally not a store: it owns no bytes, Blob, object URL, transfer
 * metadata, or persistence lifecycle. `clear` releases a UI-owned staged
 * presentation without unregistering the app-root handler on relay reconnect.
 */
export interface InboundAttachmentPresentationHandler {
  complete(offer: InboundAttachmentOffer, bytes: Uint8Array): void;
  clear(peerId?: string): void;
}

let inboundAttachmentPresentationHandler: InboundAttachmentPresentationHandler | null = null;

export function setInboundAttachmentPresentationHandler(handler: InboundAttachmentPresentationHandler | null): () => void {
  inboundAttachmentPresentationHandler = handler;
  return () => {
    if (inboundAttachmentPresentationHandler === handler) {
      inboundAttachmentPresentationHandler = null;
    }
  };
}

export function attachmentTransferController(storeApi: AppStoreApi): AttachmentTransferController {
  if (active?.storeApi === storeApi) {
    return active.controller;
  }
  clearAttachmentTransferController();

  let controller: AttachmentTransferController | null = null;
  const stagedInboundOffer = ({ peerId, manifest }: { readonly peerId: string; readonly manifest: AttachmentManifest }): boolean => {
    if (controller === null) return false;
    return stageInboundOffer(storeApi, controller, peerId, manifest);
  };
  const created = new AttachmentTransferController({
    now: () => Date.now(),
    randomBytes: (bytes) => crypto.getRandomValues(bytes),
    localPeerId: () => storeApi.getState().identity?.peerId ?? "",
    localSigningKey: () => getLocalIdentityKeys()?.relayPrivateKey ?? null,
    isKnownPeer: (peerId) => knownContact(storeApi, peerId) !== null,
    knownPeerSigningKey: async (peerId) => await knownPeerSigningKey(storeApi, peerId),
    peerCapabilities: (peerId) => peerApplicationCapabilities(peerId),
    send: async ({ peerId, deliveryId, plaintext }) => {
      const state = storeApi.getState();
      const identity = state.identity;
      const contact = knownContact(storeApi, peerId);
      if (identity === null || contact === null || contact.hpkePublicKey === null) {
        throw new Error("attachment peer is unavailable");
      }
      await sendApplicationPayload({
        senderPeerId: identity.peerId,
        recipientPeerId: peerId,
        recipientHpkePublicKey: contact.hpkePublicKey,
        deliveryId,
        plaintext
      });
    },
    timers: {
      schedule: (delayMs, callback) => setTimeout(callback, delayMs),
      cancel: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); }
    },
    onInboundOffer: stagedInboundOffer,
    onInboundComplete: (offer, bytes) => {
      // A UI consumer is optional. Its failure must not change cleanup,
      // integrity, relay behavior, or the byte lifetime held by this runtime.
      try { inboundAttachmentPresentationHandler?.complete(offer, bytes); } catch { /* Optional UI boundary. */ }
    },
    onEvent: (event) => {
      // Stable lifecycle labels only: never record names, manifests, IDs,
      // capability values, chunk bytes, or cryptographic material.
      storeApi.getState().recordTransportTrace(`attachment: ${event.event} ${event.direction} ${event.reason}`);
      notifyAttachmentSendProgress(storeApi, event);
      if (event.event === "attachment.transfer.ended" && event.direction === "inbound") {
        storeApi.getState().dismissInboundAttachmentOffer(event.peerId);
        // A successful completion was just staged for the UI. Every other
        // terminal outcome invalidates any prior volatile presentation.
        if (event.reason !== "accepted") {
          try { inboundAttachmentPresentationHandler?.clear(event.peerId); } catch { /* Optional UI boundary. */ }
        }
      }
    }
  });
  controller = created;
  const clearSendBridge = installAttachmentSendBridge(storeApi, {
    canSelect: (peerId) => {
      if (!hasAttachedRelaySession()) {
        return { status: "unavailable" };
      }
      const admission = created.canOffer(peerId);
      if (admission.status === "ready") {
        return { status: "ready" };
      }
      switch (admission.reason) {
        case "unsupported": return { status: "unsupported" };
        case "busy": return { status: "busy" };
        case "unknown_peer": return { status: "unavailable" };
        case "unavailable": return { status: "unavailable" };
      }
    },
    offer: async (peerId, file) => await created.offer(peerId, file)
  });
  active = { storeApi, controller: created, clearSendBridge };
  setLiveForwardedAckListener((deliveryId) => { created.onRelayForwarded(deliveryId); });
  return created;
}

export function clearAttachmentTransferController(): void {
  const current = active;
  active = null;
  current?.clearSendBridge();
  // The app-root presentation handler remains registered across a relay
  // reconnect, but any of its staged bytes must be released immediately.
  try { inboundAttachmentPresentationHandler?.clear(); } catch { /* Optional UI boundary. */ }
  setLiveForwardedAckListener(null);
  current?.controller.close();
  current?.storeApi.getState().clearInboundAttachmentOffers();
}

function knownContact(storeApi: AppStoreApi, peerId: string) {
  return storeApi.getState().contacts.find((candidate) => candidate.peerId === peerId && candidate.hpkePublicKey !== null) ?? null;
}

async function knownPeerSigningKey(storeApi: AppStoreApi, peerId: string): Promise<CryptoKey | null> {
  if (knownContact(storeApi, peerId) === null) {
    return null;
  }
  try {
    const raw = decodeBase64URL(peerId);
    if (raw.byteLength !== 32) return null;
    return await crypto.subtle.importKey("raw", toArrayBuffer(raw), "Ed25519", false, ["verify"]);
  } catch {
    return null;
  }
}

function stageInboundOffer(
  storeApi: AppStoreApi,
  controller: AttachmentTransferController,
  peerId: string,
  manifest: AttachmentManifest
): boolean {
  // A newly verified offer replaces any earlier completed presentation from
  // this peer. Release UI-owned bytes before exposing the next consent card.
  try { inboundAttachmentPresentationHandler?.clear(peerId); } catch { /* Optional UI boundary. */ }
  return storeApi.getState().stageVerifiedInboundAttachmentOffer({
    peerId,
    transferId: manifest.transferId,
    fileName: manifest.fileName,
    mediaType: manifest.mediaType,
    byteCount: manifest.byteCount,
    expiresAt: manifest.expiresAt,
    receivedAt: Date.now(),
    onAccept: async () => { requireSent(await controller.accept(peerId)); },
    onReject: async () => { requireSent(await controller.reject(peerId)); }
  });
}

function requireSent(result: { readonly status: "sent" } | { readonly status: "rejected"; readonly reason: string }): void {
  if (result.status !== "sent") {
    throw new Error(`attachment decision ${result.reason}`);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}
