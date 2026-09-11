import {
  SameRelayTransportClient,
  type VerifiedRelayRouteMaterial,
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
export const relayAttachmentProbeTimeoutMs = 5_000;
export const maxConcurrentRelayAttachmentProbes = 2;
// A first route through independent relays can include one bounded carrier
// pass and a transient federation attachment before relay.forwarded returns.
// This remains a foreground, client-only wait; it is not a relay queue or a
// delivery promise. Attachment transfer deliberately keeps its own stricter
// per-chunk timer.
export const relayAcknowledgementTimeoutMs = 30_000;
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
  route: VerifiedRelayRouteMaterial,
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

export interface RelayAttachmentProbeResult {
  readonly route: VerifiedRelayRouteMaterial;
  readonly latencyMs: number;
}

/**
 * Performs the normal authenticated attachment challenge without publishing
 * this tab's presence or replacing its live singleton session.  It is only a
 * bounded local ranking probe; success makes no statement about a peer or
 * future forwarding availability.
 */
export async function probeRelayAttachments(
  routes: readonly VerifiedRelayRouteMaterial[],
  identity: SameRelayIdentity,
  signal?: AbortSignal,
  authenticatedTurnReadyRouteKeys: ReadonlySet<string> = new Set<string>()
): Promise<readonly RelayAttachmentProbeResult[]> {
  const candidates = routes.slice(0, 4);
  const results: RelayAttachmentProbeResult[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(maxConcurrentRelayAttachmentProbes, candidates.length) }, async () => {
    while (!signal?.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      const route = candidates[index];
      if (route === undefined) return;
      const result = await probeRelayAttachment(route, identity, signal);
      if (result !== null) results.push(result);
    }
  });
  await Promise.all(workers);
  return orderRelayAttachmentProbeResults(results, authenticatedTurnReadyRouteKeys);
}

/**
 * The TURN preference input is intentionally not carrier metadata. A later
 * RTC capability may populate it only after authenticated acceptance and an
 * actual short-lived ICE configuration; until then this is an empty hook.
 */
export function orderRelayAttachmentProbeResults(
  results: readonly RelayAttachmentProbeResult[],
  authenticatedTurnReadyRouteKeys: ReadonlySet<string> = new Set<string>()
): readonly RelayAttachmentProbeResult[] {
  return [...results].sort((left, right) => {
    const leftTurnReady = authenticatedTurnReadyRouteKeys.has(routeComparisonKey(left.route));
    const rightTurnReady = authenticatedTurnReadyRouteKeys.has(routeComparisonKey(right.route));
    if (leftTurnReady !== rightTurnReady) return leftTurnReady ? -1 : 1;
    const latency = left.latencyMs - right.latencyMs;
    if (latency !== 0) return latency;
    return routeComparisonKey(left.route).localeCompare(routeComparisonKey(right.route));
  });
}

async function probeRelayAttachment(
  route: VerifiedRelayRouteMaterial,
  identity: SameRelayIdentity,
  signal?: AbortSignal
): Promise<RelayAttachmentProbeResult | null> {
  if (signal?.aborted) return null;
  const candidate = new SameRelayTransportClient({ route, identity, handshakeTimeoutMs: relayAttachmentProbeTimeoutMs });
  const startedAt = performance.now();
  let abortListener: (() => void) | null = null;
  const timeout = setTimeout(() => {
    candidate.disconnect();
  }, relayAttachmentProbeTimeoutMs);
  try {
    if (signal !== undefined) {
      abortListener = () => { candidate.disconnect(); };
      signal.addEventListener("abort", abortListener, { once: true });
    }
    await candidate.attach();
    return { route, latencyMs: Math.max(0, Math.round(performance.now() - startedAt)) };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    if (abortListener !== null && signal !== undefined) signal.removeEventListener("abort", abortListener);
    candidate.disconnect();
  }
}

function routeComparisonKey(route: VerifiedRelayRouteMaterial): string {
  return `${route.endpointUri}\n${route.relayPublicKey}\n${route.profileMultihash}`;
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
