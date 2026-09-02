import {
  SameRelayTransportClient,
  type BrowserRelaySocketFactory,
  type RelayRouteHint,
  type RelayRouteMaterial,
  type SameRelayIdentity,
  type SameRelayPendingEnvelope,
  type SameRelayTransportEvent
} from "./same-relay.js";
import {
  createBetaPayloadKeyPair,
  makeBetaPayloadAAD,
  openBetaPayload,
  sealBetaPayload,
  type BetaPayloadKeyPair
} from "./payload-crypto.js";
import { encodeBase64URL } from "../protocol/v0/base64url.js";
import { protocolID } from "../protocol/v0/envelope.js";

export type CarrierHoppingPoCStatus = "ok" | "degraded" | "failed";

export interface CarrierHoppingPoCReport {
  readonly status: CarrierHoppingPoCStatus;
  readonly reason: string;
  readonly activeRoute: string | null;
  readonly migrationRoute: string | null;
  readonly migrated: boolean;
  readonly relayAckCount: number;
  readonly peerReceiptCount: number;
  readonly unavailableCount: number;
  readonly pendingCount: number;
  readonly events: readonly string[];
}

export interface CarrierHoppingPoCOptions {
  readonly routes: readonly RelayRouteMaterial[];
  readonly routeHints?: readonly RelayRouteHint[];
  readonly socketFactory?: BrowserRelaySocketFactory;
  readonly crypto?: Crypto;
  readonly stepTimeoutMs?: number;
  readonly relayPropagationWaitMs?: number;
  readonly onEvent?: (event: string) => void;
}

interface TransportPair {
  readonly alice: SameRelayTransportClient;
  readonly bob: SameRelayTransportClient;
  readonly unsubscribe: () => void;
  readonly events: readonly SameRelayTransportEvent[];
}

interface CarrierHoppingCounters {
  relayAckCount: number;
  peerReceiptCount: number;
  unavailableCount: number;
}

const maxRoutes = 4;
const maxEventCount = 32;
const defaultStepTimeoutMs = 3_000;
const defaultRelayPropagationWaitMs = 250;
const defaultStreamID = 0;
const defaultPathEpoch = 0;

export async function runCarrierHoppingPoC(options: CarrierHoppingPoCOptions): Promise<CarrierHoppingPoCReport> {
  const routes = options.routes.slice(0, maxRoutes);
  const events: string[] = [];
  const counters: CarrierHoppingCounters = {
    relayAckCount: 0,
    peerReceiptCount: 0,
    unavailableCount: 0
  };
  const record = (event: string): void => {
    events.unshift(event);
    if (events.length > maxEventCount) {
      events.pop();
    }
    options.onEvent?.(event);
  };

  if (routes.length === 0) {
    return makeReport("failed", "no accepted relay route from discovery", null, null, false, counters, 0, events);
  }
  const primaryRoute = routes[0];
  if (primaryRoute === undefined) {
    return makeReport("failed", "no accepted relay route from discovery", null, null, false, counters, 0, events);
  }
  const routeHints = options.routeHints ?? [];

  const [aliceIdentity, bobIdentity] = await Promise.all([
    SameRelayTransportClient.createIdentity(options.crypto),
    SameRelayTransportClient.createIdentity(options.crypto)
  ]);
  const bobPayloadKey = await createBetaPayloadKeyPair();
  const timeoutMs = boundedTimeout(options.stepTimeoutMs ?? defaultStepTimeoutMs);
  const relayPropagationWaitMs = boundedRelayPropagationWait(options.relayPropagationWaitMs ?? defaultRelayPropagationWaitMs);
  let activePair: TransportPair | null = null;
  let pendingAfterUnavailable: readonly SameRelayPendingEnvelope[] = [];

  try {
    record(`route.selected ${routeLabel(primaryRoute)}`);
    activePair = await attachPair(primaryRoute, undefined, [], [], aliceIdentity, bobIdentity, bobPayloadKey, options.socketFactory, options.crypto, relayPropagationWaitMs, record, counters);
    record("carrier.disabled discovery snapshot retained");
    const carrierOffDeliveryId = await sendEncryptedEnvelope(activePair.alice, activePair.bob, bobPayloadKey, primaryRoute, "carrier disabled opaque payload", options.crypto);
    await waitForEvent(activePair.events, (event) => event.type === "peer_receipt" && event.deliveryId === carrierOffDeliveryId, timeoutMs);
    record("carrier.disabled delivery continued");

    if (routes.length < 2) {
      return makeReport(
        "degraded",
        "one accepted route; carrier-off delivery works but relay migration is not available",
        routeLabel(primaryRoute),
        null,
        false,
        counters,
        activePair.alice.pendingCount,
        events
      );
    }
    const secondaryRoute = routes[1];
    if (secondaryRoute === undefined) {
      return makeReport(
        "degraded",
        "one accepted route; carrier-off delivery works but relay migration is not available",
        routeLabel(primaryRoute),
        null,
        false,
        counters,
        activePair.alice.pendingCount,
        events
      );
    }

    const federatedRouteHints = routeHintsForRoute(routeHints, secondaryRoute);
    if (federatedRouteHints.length > 0) {
      activePair.unsubscribe();
      activePair.alice.disconnect();
      activePair.bob.disconnect();
      record(`route.federation.started ${routeLabel(primaryRoute)} -> ${routeLabel(secondaryRoute)}`);
      activePair = await attachPair(
        primaryRoute,
        secondaryRoute,
        federatedRouteHints,
        [],
        aliceIdentity,
        bobIdentity,
        bobPayloadKey,
        options.socketFactory,
        options.crypto,
        relayPropagationWaitMs,
        record,
        counters
      );
      const federatedDeliveryId = await sendEncryptedEnvelope(activePair.alice, activePair.bob, bobPayloadKey, primaryRoute, "route-hinted federation opaque payload", options.crypto);
      await waitForEvent(activePair.events, (event) => event.type === "peer_receipt" && event.deliveryId === federatedDeliveryId, timeoutMs);
      record("route.federation.delivery completed");
    }

    activePair.bob.disconnect();
    await settle();
    const migrationDeliveryId = await sendEncryptedEnvelope(activePair.alice, activePair.bob, bobPayloadKey, primaryRoute, "client-owned migration retry payload", options.crypto);
    await waitForEvent(activePair.events, (event) => event.type === "peer_unavailable", timeoutMs);
    pendingAfterUnavailable = activePair.alice.exportPendingEnvelopes();
    record(`route.unavailable pending=${String(pendingAfterUnavailable.length)}`);
    activePair.unsubscribe();
    activePair.alice.disconnect();
    activePair.bob.disconnect();

    record(`route.migration.started ${routeLabel(secondaryRoute)}`);
    activePair = await attachPair(secondaryRoute, undefined, [], pendingAfterUnavailable, aliceIdentity, bobIdentity, bobPayloadKey, options.socketFactory, options.crypto, relayPropagationWaitMs, record, counters);
    activePair.alice.retryPending();
    await waitForEvent(activePair.events, (event) => event.type === "peer_receipt" && event.deliveryId === migrationDeliveryId, timeoutMs);
    record("route.migration.completed");

    return makeReport(
      "ok",
      "carrier disabled and client migrated pending envelope to a second validated relay route",
      routeLabel(primaryRoute),
      routeLabel(secondaryRoute),
      true,
      counters,
      activePair.alice.pendingCount,
      events
    );
  } catch (error) {
    const secondaryRoute = routes[1];
    return makeReport(
      "failed",
      errorMessage(error),
      routeLabel(primaryRoute),
      secondaryRoute === undefined ? null : routeLabel(secondaryRoute),
      false,
      counters,
      pendingAfterUnavailable.length,
      events
    );
  } finally {
    activePair?.unsubscribe();
    activePair?.alice.disconnect();
    activePair?.bob.disconnect();
  }
}

async function attachPair(
  aliceRoute: RelayRouteMaterial,
  bobRoute: RelayRouteMaterial | undefined,
  routeHints: readonly RelayRouteHint[],
  alicePending: readonly SameRelayPendingEnvelope[],
  aliceIdentity: SameRelayIdentity,
  bobIdentity: SameRelayIdentity,
  bobPayloadKey: BetaPayloadKeyPair,
  socketFactory: BrowserRelaySocketFactory | undefined,
  crypto: Crypto | undefined,
  relayPropagationWaitMs: number,
  record: (event: string) => void,
  counters: CarrierHoppingCounters
): Promise<TransportPair> {
  const alice = new SameRelayTransportClient({
    route: aliceRoute,
    identity: aliceIdentity,
    pendingEnvelopes: alicePending,
    ...(socketFactory === undefined ? {} : { socketFactory }),
    ...(crypto === undefined ? {} : { crypto })
  });
  const bob = new SameRelayTransportClient({
    route: bobRoute ?? aliceRoute,
    identity: bobIdentity,
    ...(socketFactory === undefined ? {} : { socketFactory }),
    ...(crypto === undefined ? {} : { crypto })
  });
  const events: SameRelayTransportEvent[] = [];
  const subscriptions = [
    alice.addEventListener((event) => {
      events.push(event);
      recordTransportEvent("Alice", event, record, counters);
    }),
    bob.addEventListener((event) => {
      events.push(event);
      if (event.type === "envelope_received") {
        void openBetaPayload({
          recipientPrivateKey: bobPayloadKey.privateKey,
          sealedPayload: event.ciphertext,
          aad: makeEnvelopeAAD(aliceRoute, alice.peerId, bob.peerId, event.deliveryId)
        }).then(() => {
          alice.markPeerReceipt(event.deliveryId);
        }).catch((error: unknown) => {
          record(`Bob: payload rejected ${errorMessage(error)}`);
        });
      }
      recordTransportEvent("Bob", event, record, counters);
    })
  ];
  await Promise.all([alice.attach(), bob.attach()]);
  alice.announcePresence();
  bob.announcePresence();
  alice.heartbeat();
  bob.heartbeat();
  await sleep(relayPropagationWaitMs);
  alice.lookup(bob.peerId);
  alice.rendezvous(bob.peerId, { routeHints });
  return {
    alice,
    bob,
    events,
    unsubscribe: () => {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
    }
  };
}

async function sendEncryptedEnvelope(
  alice: SameRelayTransportClient,
  bob: SameRelayTransportClient,
  bobPayloadKey: BetaPayloadKeyPair,
  route: RelayRouteMaterial,
  plaintext: string,
  crypto: Crypto | undefined
): Promise<string> {
  const deliveryId = randomToken(crypto ?? globalThis.crypto, 16);
  const sealedPayload = await sealBetaPayload({
    recipientPublicKey: bobPayloadKey.publicKey,
    plaintext,
    aad: makeEnvelopeAAD(route, alice.peerId, bob.peerId, deliveryId)
  });
  alice.sendSealedEnvelope(sealedPayload, { deliveryId });
  return deliveryId;
}

function makeEnvelopeAAD(route: RelayRouteMaterial, senderPeerId: string, recipientPeerId: string, deliveryId: string): Uint8Array {
  return makeBetaPayloadAAD({
    protocol: protocolID,
    profileMultihash: route.profileMultihash,
    senderPeerId,
    recipientPeerId,
    deliveryId,
    pathEpoch: defaultPathEpoch,
    streamId: defaultStreamID,
    frameType: "ENVELOPE",
    ackRequested: true
  });
}

function recordTransportEvent(
  side: "Alice" | "Bob",
  event: SameRelayTransportEvent,
  record: (event: string) => void,
  counters: CarrierHoppingCounters
): void {
  switch (event.type) {
    case "relay_ack":
      counters.relayAckCount += 1;
      record(`${side}: relay ${event.ackType} ${shortId(event.deliveryId)}`);
      return;
    case "peer_receipt":
      counters.peerReceiptCount += 1;
      record(`${side}: peer.received ${shortId(event.deliveryId)}`);
      return;
    case "peer_unavailable":
      counters.unavailableCount += 1;
      record(`${side}: peer_unavailable pending=${String(event.pendingCount)}`);
      return;
    case "attached":
      record(`${side}: attached ${shortId(event.sessionId)}`);
      return;
    case "presence_announced":
      record(`${side}: presence ${shortId(event.peerId)}`);
      return;
    case "heartbeat_sent":
      record(`${side}: heartbeat #${String(event.sequence)}`);
      return;
    case "lookup_requested":
      record(`${side}: lookup ${shortId(event.peerId)}`);
      return;
    case "rendezvous_ready":
      record(`${side}: rendezvous ${shortId(event.routeId)}${event.routeHintCount > 0 ? ` hints=${String(event.routeHintCount)}` : ""}`);
      return;
    case "envelope_sent":
      record(`${side}: envelope ${shortId(event.deliveryId)}`);
      return;
    case "envelope_received":
      record(`${side}: envelope received ${shortId(event.deliveryId)}`);
      return;
    case "pending_retried":
      record(`${side}: retried ${String(event.count)}`);
      return;
    case "disconnected":
      record(`${side}: disconnected pending=${String(event.pendingCount)}`);
      return;
    case "error":
      record(`${side}: error ${event.message}`);
      return;
  }
}

async function waitForEvent(
  events: readonly SameRelayTransportEvent[],
  predicate: (event: SameRelayTransportEvent) => boolean,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (events.some(predicate)) {
      return;
    }
    await settle();
  }
  throw new Error("carrier-hopping PoC step timed out");
}

function makeReport(
  status: CarrierHoppingPoCStatus,
  reason: string,
  activeRoute: string | null,
  migrationRoute: string | null,
  migrated: boolean,
  counters: CarrierHoppingCounters,
  pendingCount: number,
  events: readonly string[]
): CarrierHoppingPoCReport {
  return {
    status,
    reason,
    activeRoute,
    migrationRoute,
    migrated,
    relayAckCount: counters.relayAckCount,
    peerReceiptCount: counters.peerReceiptCount,
    unavailableCount: counters.unavailableCount,
    pendingCount,
    events
  };
}

function boundedTimeout(value: number): number {
  if (!Number.isFinite(value)) {
    return defaultStepTimeoutMs;
  }
  return Math.max(100, Math.min(10_000, Math.trunc(value)));
}

function boundedRelayPropagationWait(value: number): number {
  if (!Number.isFinite(value)) {
    return defaultRelayPropagationWaitMs;
  }
  return Math.max(0, Math.min(1_000, Math.trunc(value)));
}

function routeLabel(route: RelayRouteMaterial): string {
  return route.endpointUri;
}

function routeHintsForRoute(hints: readonly RelayRouteHint[], route: RelayRouteMaterial): readonly RelayRouteHint[] {
  return hints
    .filter((hint) => hint.uri === route.endpointUri && hint.relayPublicKey === route.relayPublicKey)
    .slice(0, 8);
}

function shortId(value: string): string {
  return value.length <= 10 ? value : `${value.slice(0, 10)}...`;
}

function randomToken(crypto: Crypto, size: number): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return encodeBase64URL(bytes);
}

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "carrier-hopping PoC failed";
}
