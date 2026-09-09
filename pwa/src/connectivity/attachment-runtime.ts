import { decodeBase64URL, type AttachmentManifest } from "@code4bones/branch-core";

import { getLocalIdentityKeys } from "../identity/identity-keys.js";
import type { AppStoreApi } from "../state/store.js";
import { peerApplicationCapabilities } from "./application-capabilities-control.js";
import { AttachmentTransferController } from "./attachment-transfer.js";
import { setLiveForwardedAckListener } from "./relay-session.js";
import { sendApplicationPayload } from "./seal-and-send.js";

// One tab owns one volatile transfer controller. It is deliberately separate
// from Zustand and from relay-session: neither a File nor partial plaintext
// bytes can become UI state, relay state, or durable storage.
let active: { readonly storeApi: AppStoreApi; readonly controller: AttachmentTransferController } | null = null;

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
    onEvent: (event) => {
      // Stable lifecycle labels only: never record names, manifests, IDs,
      // capability values, chunk bytes, or cryptographic material.
      storeApi.getState().recordTransportTrace(`attachment: ${event.event} ${event.direction} ${event.reason}`);
      if (event.event === "attachment.transfer.ended" && event.direction === "inbound") {
        storeApi.getState().dismissInboundAttachmentOffer(event.peerId);
      }
    }
  });
  controller = created;
  active = { storeApi, controller: created };
  setLiveForwardedAckListener((deliveryId) => { created.onRelayForwarded(deliveryId); });
  return created;
}

export function clearAttachmentTransferController(): void {
  const current = active;
  active = null;
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
