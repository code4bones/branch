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

const maxTrackedDeliveries = 64;
const relayAcknowledgementTimeoutMs = 12_000;

interface TrackedDelivery {
  readonly contactId: string;
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
  clearTrackedDeliveries();
  incomingDeliveryIds.reset();
}

export function reserveIncomingDelivery(deliveryId: string): boolean {
  return incomingDeliveryIds.reserve(deliveryId);
}

export function trackDelivery(deliveryId: string, contactId: string, onTimeout: () => void): void {
  clearDelivery(deliveryId);
  if (trackedDeliveries.size === maxTrackedDeliveries) {
    const oldestDeliveryId = trackedDeliveries.keys().next().value;
    if (typeof oldestDeliveryId === "string") {
      const oldest = trackedDeliveries.get(oldestDeliveryId);
      if (oldest !== undefined) {
        clearTimeout(oldest.timeout);
        trackedDeliveries.delete(oldestDeliveryId);
        oldest.onTimeout();
      }
    }
  }
  const timeout = setTimeout(() => {
    if (trackedDeliveries.delete(deliveryId)) {
      onTimeout();
    }
  }, relayAcknowledgementTimeoutMs);
  trackedDeliveries.set(deliveryId, { contactId, timeout, onTimeout });
}

export function contactIdForDelivery(deliveryId: string): string | undefined {
  return trackedDeliveries.get(deliveryId)?.contactId;
}

export function clearDelivery(deliveryId: string): void {
  const delivery = trackedDeliveries.get(deliveryId);
  if (delivery !== undefined) {
    clearTimeout(delivery.timeout);
    trackedDeliveries.delete(deliveryId);
  }
}

export function takeTrackedDeliveries(): readonly { readonly deliveryId: string; readonly contactId: string }[] {
  const deliveries = Array.from(trackedDeliveries, ([deliveryId, delivery]) => ({ deliveryId, contactId: delivery.contactId }));
  clearTrackedDeliveries();
  return deliveries;
}

function clearTrackedDeliveries(): void {
  for (const delivery of trackedDeliveries.values()) {
    clearTimeout(delivery.timeout);
  }
  trackedDeliveries.clear();
}
