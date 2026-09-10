import type { SameRelayTransportClient, SameRelayTransportEvent } from "@code4bones/branch-core";
import { useEffect, useRef } from "react";

import { openIncomingEnvelope } from "./open-envelope.js";
import { receiveApplicationCapabilities, sendApplicationCapabilities } from "./application-capabilities-control.js";
import { attachmentTransferController, clearAttachmentTransferController } from "./attachment-runtime.js";
import { receiveDeliveryReceipt, sendDeliveryReceipt } from "./delivery-receipt-control.js";
import { classifyIncomingMessage } from "./incoming-message.js";
import { orderedAttachmentRoutes } from "./relay-route-selection.js";
import { sendPresencePong } from "./seal-and-send.js";
import { receiveTypingControl } from "./typing-control.js";
import { consumePendingContactDiscovery, startContactDiscoveryRuntime, stopContactDiscoveryRuntime } from "./contact-discovery-runtime.js";
import { startContactPresenceRuntime, stopContactPresenceRuntime } from "./contact-presence-runtime.js";
import { receiveContactCard, respondToContactProbe } from "./contact-card-control.js";
import {
  attachRelaySession,
  clearDelivery,
  contactIdForDelivery,
  disconnectRelaySession,
  getRelaySessionClient,
  hasAttachedRelaySession,
  notifyLiveForwardedAck,
  reserveIncomingDelivery,
  takeTrackedDeliveries
} from "./relay-session.js";
import { getLocalIdentityKeys } from "../identity/identity-keys.js";
import type { AppStoreApi } from "../state/store.js";
import { useAppStoreApi } from "../state/StoreProvider.js";

const reconnectBaseDelayMs = 1_000;
const reconnectMaxDelayMs = 8_000;
const reconnectMaxAttempts = 6;

interface AttachmentLifecycle {
  currentKey: string | null;
  connectingKey: string | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

// Mounted once for the app's lifetime (see ThemedApp). Attaches the primary
// persistent chat session to the first discovered route that accepts the
// attachment as soon as a local identity is ready, keeps a heartbeat alive, and translates
// transport events into store updates (message delivery state, incoming
// messages) via storeApi.getState() so this never goes stale between renders.
export function useRelayTransport(): void {
  const storeApi = useAppStoreApi();
  const lifecycleRef = useRef<AttachmentLifecycle | null>(null);
  lifecycleRef.current ??= {
    currentKey: null,
    connectingKey: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
    stopped: false
  };

  useEffect(() => {
    const lifecycle = lifecycleRef.current;
    if (lifecycle === null) {
      return undefined;
    }
    const unsubscribe = storeApi.subscribe((state, previousState) => {
      if (state.identity === previousState.identity && state.discoveredRoutes === previousState.discoveredRoutes) {
        return;
      }
      lifecycle.reconnectAttempts = 0;
      void tryAttach(storeApi, lifecycle);
    });
    void tryAttach(storeApi, lifecycle);
    return () => {
      unsubscribe();
      lifecycle.stopped = true;
      clearReconnectTimer(lifecycle);
      stopHeartbeat();
      stopContactDiscoveryRuntime();
      stopContactPresenceRuntime();
      clearAttachmentTransferController();
      disconnectRelaySession();
      lifecycle.currentKey = null;
      lifecycle.connectingKey = null;
    };
  }, [storeApi]);
}

async function tryAttach(storeApi: AppStoreApi, lifecycle: AttachmentLifecycle): Promise<void> {
  if (lifecycle.stopped) {
    return;
  }
  const { identity, discoveredRoutes } = storeApi.getState();
  const keys = getLocalIdentityKeys();
  if (identity === null || discoveredRoutes.length === 0 || keys === null) {
    return;
  }
  const attachmentRoutes = orderedAttachmentRoutes(discoveredRoutes);
  const candidateKeys = new Set(attachmentRoutes.map((route) => attachmentKey(route, identity.peerId)));
  if (lifecycle.currentKey !== null && candidateKeys.has(lifecycle.currentKey) && getRelaySessionClient() !== null) {
    return;
  }
  if (lifecycle.connectingKey !== null) {
    return;
  }
  if (lifecycle.currentKey !== null) {
    clearAttachmentTransferController();
    for (const delivery of takeTrackedDeliveries()) {
      storeApi.getState().setMessageDeliveryState(delivery.contactId, delivery.deliveryId, "unavailable");
    }
    lifecycle.currentKey = null;
  }
  clearReconnectTimer(lifecycle);
  const failures: string[] = [];

  // Discovery returns at most four independently signed, already validated
  // candidates. Trying them locally is live transport selection, not carrier
  // discovery, and stores neither routes nor failed messages.
  for (const [index, route] of attachmentRoutes.entries()) {
    const attachKey = attachmentKey(route, identity.peerId);
    lifecycle.connectingKey = attachKey;
    storeApi.getState().recordTransportTrace(`attach attempt: candidate ${String(index + 1)} of ${String(attachmentRoutes.length)}`);
    storeApi.getState().setAttachStatus("attaching", `Attaching to relay ${String(index + 1)} of ${String(attachmentRoutes.length)}…`);
    try {
      const attachedClient = await attachRelaySession(
        route,
        { peerId: identity.peerId, publicKey: identity.relayPublicKey, privateKey: keys.relayPrivateKey },
        (event) => { handleTransportEvent(storeApi, lifecycle, event); }
      );
      if (!isActiveAttachmentAttempt(lifecycle, attachKey) || getRelaySessionClient() !== attachedClient || attachedClient.routeId === null) {
        if (getRelaySessionClient() === attachedClient) {
          disconnectRelaySession();
        }
        lifecycle.connectingKey = null;
        scheduleReconnect(storeApi, lifecycle);
        return;
      }
      lifecycle.connectingKey = null;
      lifecycle.currentKey = attachKey;
      lifecycle.reconnectAttempts = 0;
      storeApi.getState().recordTransportTrace(`attached: candidate ${String(index + 1)} of ${String(attachmentRoutes.length)}`);
      storeApi.getState().setAttachStatus("attached", `Attached to relay ${String(index + 1)} of ${String(attachmentRoutes.length)}`);
      startHeartbeat(attachedClient);
      startContactDiscoveryRuntime(storeApi, attachedClient);
      startContactPresenceRuntime(storeApi, attachedClient);
      // Install the tab-local file bridge at the same successful attachment
      // boundary as the other live adapters. Waiting for an unrelated inbound
      // payload made File intermittently appear unavailable after reload.
      attachmentTransferController(storeApi);
      return;
    } catch (cause) {
      if (!isActiveAttachmentAttempt(lifecycle, attachKey)) {
        return;
      }
      lifecycle.connectingKey = null;
      failures.push(attachmentFailure(route.endpointUri, cause));
      storeApi.getState().recordTransportTrace(`attach failed: candidate ${String(index + 1)} (${attachmentFailureReason(cause)})`);
    }
  }
  if (isLifecycleStopped(lifecycle)) {
    return;
  }
  storeApi.getState().setAttachStatus("error", `No discovered relay accepted attachment: ${failures.join("; ")}`);
  scheduleReconnect(storeApi, lifecycle);
}

function attachmentKey(route: { readonly endpointUri: string; readonly relayPublicKey: string; readonly profileMultihash: string }, peerId: string): string {
  return `${peerId}\n${route.endpointUri}\n${route.relayPublicKey}\n${route.profileMultihash}`;
}

function attachmentFailure(endpointUri: string, cause: unknown): string {
  return `${endpointUri}: ${attachmentFailureReason(cause)}`;
}

function attachmentFailureReason(cause: unknown): string {
  const reason = cause instanceof Error ? cause.message : "relay attach failed";
  return reason.slice(0, 160);
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(client: SameRelayTransportClient): void {
  stopHeartbeat();
  const intervalSeconds = client.heartbeatIntervalSeconds;
  if (intervalSeconds === null) {
    return;
  }
  heartbeatTimer = setInterval(() => {
    if (getRelaySessionClient() !== client) {
      return;
    }
    try {
      client.heartbeat();
    } catch {
      // The close event owns reconnect scheduling and is the source of truth
      // that this live attachment is gone.
    }
  }, intervalSeconds * 1_000);
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect(storeApi: AppStoreApi, lifecycle: AttachmentLifecycle): void {
  if (lifecycle.stopped || lifecycle.reconnectTimer !== null || lifecycle.connectingKey !== null) {
    return;
  }
  if (lifecycle.reconnectAttempts >= reconnectMaxAttempts) {
    storeApi.getState().setAttachStatus("error", "Relay reconnect limit reached; refresh discovery to retry");
    return;
  }
  const delay = Math.min(reconnectBaseDelayMs * (2 ** lifecycle.reconnectAttempts), reconnectMaxDelayMs);
  lifecycle.reconnectAttempts += 1;
  lifecycle.reconnectTimer = setTimeout(() => {
    lifecycle.reconnectTimer = null;
    void tryAttach(storeApi, lifecycle);
  }, delay);
}

function clearReconnectTimer(lifecycle: AttachmentLifecycle): void {
  if (lifecycle.reconnectTimer !== null) {
    clearTimeout(lifecycle.reconnectTimer);
    lifecycle.reconnectTimer = null;
  }
}

function isActiveAttachmentAttempt(lifecycle: AttachmentLifecycle, attachKey: string): boolean {
  return !lifecycle.stopped && lifecycle.connectingKey === attachKey;
}

function isLifecycleStopped(lifecycle: AttachmentLifecycle): boolean {
  return lifecycle.stopped;
}

function handleTransportEvent(storeApi: AppStoreApi, lifecycle: AttachmentLifecycle, event: SameRelayTransportEvent): void {
  const state = storeApi.getState();
  switch (event.type) {
    case "contact_probe": {
      if (state.identity === null || state.identity.displayName === null || !state.allowContactDiscovery) return;
      void respondToContactProbe({
        requestId: event.requestId,
        branchId: event.branchId,
        requesterPeerId: event.requesterPeerId,
        requesterHpkePublicKey: event.requesterHpkePublicKey,
        expiresAt: event.expiresAt,
        localPeerId: state.identity.peerId,
        localHpkePublicKey: state.identity.hpkePublicKey,
        displayName: state.identity.displayName
      }).then((sent) => { state.recordTransportTrace(`contact probe: ${sent ? "responded" : "ignored"}`); }).catch(() => {
        state.recordTransportTrace("contact probe: response_failed");
      });
      return;
    }
    case "frame_sent":
      // The core has validated this frame. Retain only its bounded type, never
      // payload or route material, to correlate a remote policy close.
      state.recordTransportTrace(`outbound frame: ${event.frameType}`);
      return;
    case "relay_ack": {
      if (event.ackType === "relay.forwarded") {
        notifyLiveForwardedAck(event.deliveryId);
      }
      const contactId = contactIdForDelivery(event.deliveryId);
      if (contactId !== undefined) {
        state.setMessageDeliveryState(contactId, event.deliveryId, "relayed");
        clearDelivery(event.deliveryId);
      }
      return;
    }
    case "peer_receipt": {
      // A relay ACK alone cannot prove peer presentation or decryption. The
      // beta client has no authenticated peer-receipt construction yet.
      return;
    }
    case "peer_unavailable": {
      // ERROR has no delivery_id in the draft attachment schema. It therefore
      // cannot truthfully fail every concurrent send; each delivery resolves
      // by its own relay ACK or bounded local timeout.
      return;
    }
    case "envelope_received": {
      if (!reserveIncomingDelivery(event.deliveryId)) {
        state.recordTransportTrace("incoming envelope: duplicate");
        return;
      }
      state.recordTransportTrace("incoming envelope: received");
      void handleIncomingEnvelope(storeApi, event.deliveryId, event.ciphertext, event.originRouteId, event.senderPeerId);
      return;
    }
    case "error": {
      // A relay ERROR frame reports an operation-level rejection (for
      // example, an unavailable peer). It does not close the WebSocket. Only
      // the disconnected event owns attachment state, otherwise the UI can
      // falsely suppress ordinary contact messages while the client is live.
      const notice = transportNotice(event.message);
      state.recordTransportTrace(`relay notice: ${notice}`);
      if (getRelaySessionClient()?.routeId !== null) {
        state.setAttachStatus("attached", `Attached; relay notice: ${notice}`);
      } else {
        state.setAttachStatus("error", notice);
      }
      return;
    }
    case "disconnected":
      stopHeartbeat();
      stopContactDiscoveryRuntime();
      stopContactPresenceRuntime();
      clearAttachmentTransferController();
      state.recordTransportTrace(disconnectTraceDetail(event));
      state.clearAllContactTyping();
      lifecycle.currentKey = null;
      // A close during the small READY -> attached window must invalidate the
      // in-flight attempt. Otherwise its resolved promise could falsely paint
      // the UI attached after relay-session has already cleared the client.
      lifecycle.connectingKey = null;
      for (const delivery of takeTrackedDeliveries()) {
        state.setMessageDeliveryState(delivery.contactId, delivery.deliveryId, "unavailable");
      }
      disconnectRelaySession();
      state.setAttachStatus("error", "disconnected from relay");
      scheduleReconnect(storeApi, lifecycle);
      return;
    default:
      return;
  }
}

function disconnectTraceDetail(event: Extract<SameRelayTransportEvent, { readonly type: "disconnected" }>): string {
  if (event.source === "local") {
    return `relay session closed locally; pending=${String(event.pendingCount)}`;
  }
  const code = event.closeCode === undefined ? "unknown" : String(event.closeCode);
  return `relay closed remotely; code=${code}; pending=${String(event.pendingCount)}`;
}

function transportNotice(message: string): string {
  const candidate = message.trim();
  return /^[a-z_]{1,64}$/u.test(candidate) ? candidate : "protocol_error";
}

async function handleIncomingEnvelope(
  storeApi: AppStoreApi,
  deliveryId: string,
  ciphertext: string,
  originRouteId: string,
  senderPeerId: string | null
): Promise<void> {
  const state = storeApi.getState();
  const keys = getLocalIdentityKeys();
  if (keys === null || senderPeerId === null || state.identity === null) {
    return;
  }
  try {
    const plaintext = await openIncomingEnvelope({
      senderPeerId,
      recipientPeerId: state.identity.peerId,
      originRouteId,
      recipientHpkePrivateKey: keys.hpkePrivateKey,
      deliveryId,
      sealedPayload: ciphertext
    });
    state.recordTransportTrace("incoming envelope: opened");
    const knownContact = state.contacts.find((candidate) => candidate.peerId === senderPeerId) ?? null;
    const knownContactId = knownContact?.contactId ?? null;
    const card = await receiveContactCard({ plaintext, localPeerId: state.identity.peerId, senderPeerId });
    if (card !== null) {
      if (consumePendingContactDiscovery(card.requestId, card.branchId)) {
        state.resolveContactDiscovery(card.branchId, { displayName: card.displayName, peerId: card.peerId, hpkePublicKey: card.hpkePublicKey }, Date.now());
        state.recordTransportTrace("contact card: accepted");
      } else {
        state.recordTransportTrace("contact card: uncorrelated");
      }
      return;
    }
    const typing = await receiveTypingControl({
      plaintext,
      localPeerId: state.identity.peerId,
      senderPeerId,
      knownContactId
    });
    if (typing.handled) {
      state.recordTransportTrace(`typing control: ${typing.outcome ?? "rejected"}`);
      if (typing.contactId !== undefined && typing.expiresAt !== undefined) {
        state.setContactTyping(typing.contactId, typing.expiresAt);
      }
      return;
    }
    const applicationCapabilities = await receiveApplicationCapabilities({
      plaintext,
      localPeerId: state.identity.peerId,
      senderPeerId,
      knownContactId
    });
    if (applicationCapabilities.handled) {
      state.recordTransportTrace(`application capabilities: ${applicationCapabilities.outcome ?? "rejected"}`);
      if (applicationCapabilities.outcome === "accepted" && knownContact !== null && knownContact.hpkePublicKey !== null) {
        // A capability is live, not cached identity metadata. Reply once under
        // the existing per-peer rate limit so an attach/reload race cannot
        // leave the announcing peer unable to learn our current policy.
        void sendApplicationCapabilities({
          senderPeerId: state.identity.peerId,
          recipientPeerId: senderPeerId,
          recipientHpkePublicKey: knownContact.hpkePublicKey,
          attached: hasAttachedRelaySession()
        }).then((result) => {
          state.recordTransportTrace(`application capabilities: reply_${result}`);
        }).catch(() => {
          state.recordTransportTrace("application capabilities: reply_failed");
        });
      }
      return;
    }
    const receipt = await receiveDeliveryReceipt({
      plaintext,
      localPeerId: state.identity.peerId,
      senderPeerId,
      knownContactId
    });
    if (receipt.handled) {
      state.recordTransportTrace(`delivery receipt: ${receipt.outcome ?? "rejected"}`);
      if (receipt.outcome === "accepted" && receipt.receipt !== undefined && knownContactId !== null) {
        state.setMessageDeliveryState(knownContactId, receipt.receipt.targetDeliveryId, receipt.receipt.kind);
      }
      return;
    }
    const attachment = await attachmentTransferController(storeApi).receive(senderPeerId, plaintext);
    if (attachment.status === "handled") {
      state.recordTransportTrace(`attachment: inbound ${attachment.kind}`);
      return;
    }
    // Do not turn arbitrary unknown application bytes into a telemetry
    // surface. These three outcomes can arise only after attachment routing
    // reached a concrete local admission decision and are safe, bounded
    // diagnostics for a missing consent card.
    if (attachment.reason === "invalid_signature" || attachment.reason === "unknown_peer" || attachment.reason === "busy") {
      state.recordTransportTrace(`attachment: ignored ${attachment.reason}`);
    }
    const disposition = classifyIncomingMessage({ plaintext, senderPeerId, knownContactId });
    if (disposition.kind === "known_contact_message") {
      state.recordTransportTrace("incoming envelope: message");
      // A visible message conclusively ends the sender's current typing
      // projection. This is local UI state only; delayed controls still have
      // their own short expiry and never alter message delivery.
      state.clearContactTyping(disposition.contactId);
      state.appendMessage({
        messageId: deliveryId,
        contactId: disposition.contactId,
        direction: "incoming",
        body: disposition.body,
        sentAt: Date.now(),
        deliveryState: "received"
      });
      if (knownContact !== null && knownContact.hpkePublicKey !== null) {
        void sendDeliveryReceipt({
          kind: "delivered",
          targetDeliveryId: deliveryId,
          senderPeerId: state.identity.peerId,
          recipientPeerId: senderPeerId,
          recipientHpkePublicKey: knownContact.hpkePublicKey,
          attached: hasAttachedRelaySession()
        }).then((result) => {
          state.recordTransportTrace(`delivery receipt: delivered_${result}`);
        }).catch(() => {
          // A receipt is one best-effort live control; it has no retry queue
          // and its failure creates no negative claim about the message.
          state.recordTransportTrace("delivery receipt: delivered_failed");
        });
      }
      return;
    }
    if (disposition.kind === "known_contact_presence_ping") {
      state.recordTransportTrace("incoming envelope: presence_ping");
      if (knownContact !== null && knownContact.peerId !== null && knownContact.hpkePublicKey !== null) {
        void sendPresencePong({
          senderPeerId: state.identity.peerId,
          recipientPeerId: knownContact.peerId,
          recipientHpkePublicKey: knownContact.hpkePublicKey,
          pingId: disposition.pingId
        }).catch(() => {
          // A control pong is best-effort live traffic. It is never queued,
          // persisted, or surfaced as a message when the route is absent.
        });
      }
      return;
    }
    if (disposition.kind === "known_contact_presence_pong") {
      state.recordTransportTrace("incoming envelope: presence_pong");
      state.acceptContactPresencePong(disposition.contactId, disposition.pingId);
      return;
    }
    if (disposition.kind === "message_request") {
      state.recordTransportTrace("incoming envelope: message_request");
      state.receiveMessageRequest({
        requestId: deliveryId,
        senderPeerId: disposition.senderPeerId,
        senderHpkePublicKey: disposition.senderHpkePublicKey,
        senderDisplayName: disposition.senderDisplayName,
        body: disposition.body,
        receivedAt: Date.now()
      });
    }
  } catch {
    // Malformed or undecryptable payload: drop it rather than surface
    // ciphertext or throw across an event-handler boundary.
    state.recordTransportTrace("incoming envelope: rejected");
  }
}
