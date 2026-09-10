import {
  SameRelayTransportClient,
  type RelayRouteMaterial,
  type SameRelayIdentity,
  type SameRelayTransportEvent
} from "@code4bones/branch-core";

import { DeliveryDedupWindow } from "./delivery-dedup-window.js";

// Module-singleton holder for the one live relay session this tab keeps.
// Deliberately outside the Zustand store: a WebSocket-backed client and its
// pending-delivery bookkeeping are canonical protocol state, not UI state.
let client: SameRelayTransportClient | null = null;
let unsubscribe: (() => void) | null = null;
const trackedDeliveries = new Map<string, TrackedDelivery>();
const incomingDeliveryIds = new DeliveryDedupWindow();
let liveForwardedAckListener: ((deliveryId: string) => void) | null = null;

const maxTrackedDeliveries = 64;
const relayAcknowledgementTimeoutMs = 12_000;
export const bestEffortEnvelopeTimeoutMs = 8_000;

interface PendingEnvelopeClient {
  abandonPendingEnvelope(deliveryId: string): boolean;
}

const pendingAbandonmentTimers = new Map<string, { readonly client: PendingEnvelopeClient; readonly timeout: ReturnType<typeof setTimeout> }>();

interface TrackedDelivery {
  readonly contactId: string;
  // A retried generic application message has a new outer delivery ID but
  // still projects onto this original local conversation message.
  readonly messageId: string;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly onTimeout: () => void;
}

export function getRelaySessionClient(): SameRelayTransportClient | null {
  return client;
}

// Presentation state is updated asynchronously from relay events. Callers
// that are about to emit live traffic must instead consult the authoritative
// client, so a non-fatal relay notice cannot turn into a false detach.
export function hasAttachedRelaySession(): boolean {
  return client !== null && client.routeId !== null;
}

// One future attachment sender may observe the terminal opaque-forwarding ACK
// for its small live window. This is volatile adapter state, not a receipt and
// not a general relay event bus.
export function setLiveForwardedAckListener(listener: ((deliveryId: string) => void) | null): void {
  liveForwardedAckListener = listener;
}

export function notifyLiveForwardedAck(deliveryId: string): void {
  try {
    liveForwardedAckListener?.(deliveryId);
  } catch {
    // Observer failure must not alter the transport's bounded ACK handling.
  }
}

export async function attachRelaySession(
  route: RelayRouteMaterial,
  identity: SameRelayIdentity,
  onEvent: (event: SameRelayTransportEvent) => void
): Promise<SameRelayTransportClient> {
  disconnectRelaySession();
  const nextClient = new SameRelayTransportClient({ route, identity });
  // Publish the in-flight client before awaiting the handshake. This gives
  // teardown a handle to close a socket when React unmounts mid-attachment.
  client = nextClient;
  unsubscribe = nextClient.addEventListener(onEvent);
  try {
    await nextClient.attach();
    if (client !== nextClient) {
      throw new Error("relay attachment cancelled");
    }
    nextClient.announcePresence();
    return nextClient;
  } catch (cause) {
    if (client === nextClient) {
      disconnectRelaySession();
    }
    throw cause;
  }
}

export function disconnectRelaySession(): void {
  unsubscribe?.();
  unsubscribe = null;
  client?.disconnect();
  client = null;
  liveForwardedAckListener = null;
  clearPendingAbandonments();
  clearTrackedDeliveries();
  incomingDeliveryIds.reset();
}

export function reserveIncomingDelivery(deliveryId: string): boolean {
  return incomingDeliveryIds.reserve(deliveryId);
}

export function trackDelivery(deliveryId: string, contactId: string, messageId: string, onTimeout: () => void): void {
  clearDelivery(deliveryId);
  if (trackedDeliveries.size === maxTrackedDeliveries) {
    const oldestDeliveryId = trackedDeliveries.keys().next().value;
    if (typeof oldestDeliveryId === "string") {
      const oldest = trackedDeliveries.get(oldestDeliveryId);
      if (oldest !== undefined) {
        clearTimeout(oldest.timeout);
        trackedDeliveries.delete(oldestDeliveryId);
        abandonCurrentPendingEnvelope(oldestDeliveryId);
        oldest.onTimeout();
      }
    }
  }
  const timeout = setTimeout(() => {
    if (trackedDeliveries.delete(deliveryId)) {
      abandonCurrentPendingEnvelope(deliveryId);
      onTimeout();
    }
  }, relayAcknowledgementTimeoutMs);
  trackedDeliveries.set(deliveryId, { contactId, messageId, timeout, onTimeout });
}

export function messageForDelivery(deliveryId: string): { readonly contactId: string; readonly messageId: string } | undefined {
  const delivery = trackedDeliveries.get(deliveryId);
  return delivery === undefined ? undefined : { contactId: delivery.contactId, messageId: delivery.messageId };
}

export function clearDelivery(deliveryId: string): void {
  const delivery = trackedDeliveries.get(deliveryId);
  if (delivery !== undefined) {
    clearTimeout(delivery.timeout);
    trackedDeliveries.delete(deliveryId);
  }
}

// Controls do not have a message projection or an ACK-driven transfer
// window. Arm their one local expiry here, beside the sole tab session, so a
// missing terminal relay ACK cannot turn best-effort traffic into a queue.
export function armBestEffortPendingAbandonment(clientForDelivery: PendingEnvelopeClient, deliveryId: string, delayMs: number = bestEffortEnvelopeTimeoutMs): void {
  clearPendingAbandonment(deliveryId);
  const timeout = setTimeout(() => {
    const pending = pendingAbandonmentTimers.get(deliveryId);
    if (pending?.client !== clientForDelivery) return;
    pendingAbandonmentTimers.delete(deliveryId);
    clientForDelivery.abandonPendingEnvelope(deliveryId);
  }, Math.max(0, delayMs));
  pendingAbandonmentTimers.set(deliveryId, { client: clientForDelivery, timeout });
}

export function clearPendingAbandonment(deliveryId: string): void {
  const pending = pendingAbandonmentTimers.get(deliveryId);
  if (pending !== undefined) {
    clearTimeout(pending.timeout);
    pendingAbandonmentTimers.delete(deliveryId);
  }
}

export function abandonCurrentPendingEnvelope(deliveryId: string): void {
  clearPendingAbandonment(deliveryId);
  client?.abandonPendingEnvelope(deliveryId);
}

export function takeTrackedDeliveries(): readonly { readonly deliveryId: string; readonly contactId: string; readonly messageId: string }[] {
  const deliveries = Array.from(trackedDeliveries, ([deliveryId, delivery]) => ({ deliveryId, contactId: delivery.contactId, messageId: delivery.messageId }));
  clearTrackedDeliveries();
  return deliveries;
}

function clearTrackedDeliveries(): void {
  for (const delivery of trackedDeliveries.values()) {
    clearTimeout(delivery.timeout);
  }
  trackedDeliveries.clear();
}

function clearPendingAbandonments(): void {
  for (const pending of pendingAbandonmentTimers.values()) {
    clearTimeout(pending.timeout);
  }
  pendingAbandonmentTimers.clear();
}
