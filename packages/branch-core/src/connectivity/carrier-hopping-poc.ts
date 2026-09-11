import {
  SameRelayTransportClient,
  type BrowserRelaySocketFactory,
  type RelayRouteHint,
  type VerifiedRelayRouteMaterial,
  type SameRelayIdentity,
  type SameRelayPendingEnvelope,
  type SameRelayTransportEvent
} from "./same-relay.js";
import {
  betaHpkeCiphertextBytesForPlaintext,
  betaHpkeCiphertextBytesFromSealedPayload,
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
  readonly trace: readonly CarrierHoppingTraceEvent[];
  readonly relayAckCount: number;
  readonly peerReceiptCount: number;
  readonly unavailableCount: number;
  readonly pendingCount: number;
  readonly events: readonly string[];
}

export type CarrierHoppingTraceKind =
  | "discovery"
  | "attach"
  | "presence"
  | "rendezvous"
  | "federation"
  | "delivery"
  | "ack"
  | "unavailable"
  | "retry"
  | "migration"
  | "disconnect"
  | "error";

export type CarrierHoppingTraceStatus = "pending" | "ok" | "warn" | "failed";

export interface CarrierHoppingTraceEvent {
  readonly id: string;
  readonly atMs: number;
  readonly kind: CarrierHoppingTraceKind;
  readonly status: CarrierHoppingTraceStatus;
  readonly label: string;
  readonly side?: "Alice" | "Bob";
  readonly route?: string;
  readonly routeIdPreview?: string;
  readonly peerIdPreview?: string;
  readonly deliveryIdPreview?: string;
  readonly routeHintCount?: number;
  readonly pendingCount?: number;
  readonly detail?: string;
}

export interface CarrierHoppingPoCOptions {
  readonly routes: readonly VerifiedRelayRouteMaterial[];
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
const maxTraceEventCount = 96;
const defaultStepTimeoutMs = 3_000;
const defaultRelayPropagationWaitMs = 250;
const defaultStreamID = 0;
const defaultPathEpoch = 0;

export async function runCarrierHoppingPoC(options: CarrierHoppingPoCOptions): Promise<CarrierHoppingPoCReport> {
  const routes = options.routes.slice(0, maxRoutes);
  const events: string[] = [];
  const trace: CarrierHoppingTraceEvent[] = [];
  const startedAt = Date.now();
  let traceSequence = 0;
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
  const recordTrace = (event: Omit<CarrierHoppingTraceEvent, "id" | "atMs">): void => {
    trace.push({
      id: `trace-${String(++traceSequence)}`,
      atMs: Date.now() - startedAt,
      ...event
    });
    if (trace.length > maxTraceEventCount) {
      trace.shift();
    }
  };

  if (routes.length === 0) {
    return makeReport("failed", "no accepted relay route from discovery", null, null, false, trace, counters, 0, events);
  }
  const primaryRoute = routes[0];
  if (primaryRoute === undefined) {
    return makeReport("failed", "no accepted relay route from discovery", null, null, false, trace, counters, 0, events);
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
    recordTrace({
      kind: "discovery",
      status: "ok",
      label: "Primary route selected",
      route: routeLabel(primaryRoute),
      detail: `${String(routes.length)} route candidates, ${String(routeHints.length)} route hints`
    });
    activePair = await attachPair(primaryRoute, undefined, [], [], aliceIdentity, bobIdentity, bobPayloadKey, options.socketFactory, options.crypto, relayPropagationWaitMs, record, recordTrace, counters);
    record("carrier.disabled discovery snapshot retained");
    recordTrace({
      kind: "discovery",
      status: "ok",
      label: "Carrier disabled",
      route: routeLabel(primaryRoute),
      detail: "Transport continues from the retained validated route snapshot"
    });
    const carrierOffDeliveryId = await sendEncryptedEnvelope(activePair.alice, activePair.bob, bobPayloadKey, primaryRoute, "carrier disabled opaque payload", options.crypto);
    await waitForEvent(activePair.events, (event) => event.type === "peer_receipt" && event.deliveryId === carrierOffDeliveryId, timeoutMs);
    record("carrier.disabled delivery continued");
    recordTrace({
      kind: "delivery",
      status: "ok",
      label: "Carrier-off delivery completed",
      route: routeLabel(primaryRoute),
      deliveryIdPreview: shortId(carrierOffDeliveryId)
    });

    if (routes.length < 2) {
      return makeReport(
        "degraded",
        "one accepted route; carrier-off delivery works but relay migration is not available",
        routeLabel(primaryRoute),
        null,
        false,
        trace,
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
        trace,
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
      recordTrace({
        kind: "federation",
        status: "pending",
        label: "Federation bridge requested",
        route: `${routeLabel(primaryRoute)} -> ${routeLabel(secondaryRoute)}`,
        routeHintCount: federatedRouteHints.length
      });
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
        recordTrace,
        counters
      );
      const federatedDeliveryId = await sendEncryptedEnvelope(activePair.alice, activePair.bob, bobPayloadKey, primaryRoute, "route-hinted federation opaque payload", options.crypto);
      await waitForEvent(activePair.events, (event) => event.type === "peer_receipt" && event.deliveryId === federatedDeliveryId, timeoutMs);
      record("route.federation.delivery completed");
      recordTrace({
        kind: "federation",
        status: "ok",
        label: "Federated delivery completed",
        route: `${routeLabel(primaryRoute)} -> ${routeLabel(secondaryRoute)}`,
        deliveryIdPreview: shortId(federatedDeliveryId),
        routeHintCount: federatedRouteHints.length
      });
    }

    activePair.bob.disconnect();
    await settle();
    const migrationDeliveryId = await sendEncryptedEnvelope(activePair.alice, activePair.bob, bobPayloadKey, primaryRoute, "client-owned migration retry payload", options.crypto);
    await waitForEvent(activePair.events, (event) => event.type === "peer_unavailable", timeoutMs);
    pendingAfterUnavailable = activePair.alice.exportPendingEnvelopes();
    record(`route.unavailable pending=${String(pendingAfterUnavailable.length)}`);
    recordTrace({
      kind: "unavailable",
      status: "warn",
      label: "Active route unavailable",
      route: routeLabel(primaryRoute),
      deliveryIdPreview: shortId(migrationDeliveryId),
      pendingCount: pendingAfterUnavailable.length,
      detail: "Sender kept retry state locally"
    });
    activePair.unsubscribe();
    activePair.alice.disconnect();
    activePair.bob.disconnect();

    record(`route.migration.started ${routeLabel(secondaryRoute)}`);
    recordTrace({
      kind: "migration",
      status: "pending",
      label: "Migration started",
      route: routeLabel(secondaryRoute),
      pendingCount: pendingAfterUnavailable.length
    });
    activePair = await attachPair(secondaryRoute, undefined, [], pendingAfterUnavailable, aliceIdentity, bobIdentity, bobPayloadKey, options.socketFactory, options.crypto, relayPropagationWaitMs, record, recordTrace, counters);
    activePair.alice.retryPending();
    await waitForEvent(activePair.events, (event) => event.type === "peer_receipt" && event.deliveryId === migrationDeliveryId, timeoutMs);
    record("route.migration.completed");
    recordTrace({
      kind: "migration",
      status: "ok",
      label: "Migration completed",
      route: routeLabel(secondaryRoute),
      deliveryIdPreview: shortId(migrationDeliveryId),
      pendingCount: activePair.alice.pendingCount
    });

    return makeReport(
      "ok",
      "carrier disabled and client migrated pending envelope to a second validated relay route",
      routeLabel(primaryRoute),
      routeLabel(secondaryRoute),
      true,
      trace,
      counters,
      activePair.alice.pendingCount,
      events
    );
  } catch (error) {
    const secondaryRoute = routes[1];
    recordTrace({
      kind: "error",
      status: "failed",
      label: "Carrier-hop failed",
      route: routeLabel(primaryRoute),
      detail: errorMessage(error)
    });
    return makeReport(
      "failed",
      errorMessage(error),
      routeLabel(primaryRoute),
      secondaryRoute === undefined ? null : routeLabel(secondaryRoute),
      false,
      trace,
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
  aliceRoute: VerifiedRelayRouteMaterial,
  bobRoute: VerifiedRelayRouteMaterial | undefined,
  routeHints: readonly RelayRouteHint[],
  alicePending: readonly SameRelayPendingEnvelope[],
  aliceIdentity: SameRelayIdentity,
  bobIdentity: SameRelayIdentity,
  bobPayloadKey: BetaPayloadKeyPair,
  socketFactory: BrowserRelaySocketFactory | undefined,
  crypto: Crypto | undefined,
  relayPropagationWaitMs: number,
  record: (event: string) => void,
  recordTrace: (event: Omit<CarrierHoppingTraceEvent, "id" | "atMs">) => void,
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
      recordTransportEvent("Alice", event, record, recordTrace, counters);
    }),
    bob.addEventListener((event) => {
      events.push(event);
      if (event.type === "envelope_received") {
        void openBetaPayload({
          recipientPrivateKey: bobPayloadKey.privateKey,
          sealedPayload: event.ciphertext,
          aad: makeEnvelopeAAD(aliceRoute, event.originRouteId, alice.peerId, bob.peerId, event.deliveryId, betaHpkeCiphertextBytesFromSealedPayload(event.ciphertext)),
          expectedCiphertextBytes: betaHpkeCiphertextBytesFromSealedPayload(event.ciphertext)
        }).then(() => {
          alice.markPeerReceipt(event.deliveryId);
        }).catch((error: unknown) => {
          record(`Bob: payload rejected ${errorMessage(error)}`);
          recordTrace({
            kind: "error",
            status: "failed",
            label: "Bob rejected payload",
            side: "Bob",
            deliveryIdPreview: shortId(event.deliveryId),
            detail: errorMessage(error)
          });
        });
      }
      recordTransportEvent("Bob", event, record, recordTrace, counters);
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
  route: VerifiedRelayRouteMaterial,
  plaintext: string,
  crypto: Crypto | undefined
): Promise<string> {
  const deliveryId = randomToken(crypto ?? globalThis.crypto, 16);
  const originRouteId = alice.routeId;
  if (originRouteId === null) {
    throw new Error("alice relay session is not attached");
  }
  const ciphertextBytes = betaHpkeCiphertextBytesForPlaintext(plaintext);
  const sealedPayload = await sealBetaPayload({
    recipientPublicKey: bobPayloadKey.publicKey,
    plaintext,
    aad: makeEnvelopeAAD(route, originRouteId, alice.peerId, bob.peerId, deliveryId, ciphertextBytes),
    expectedCiphertextBytes: ciphertextBytes
  });
  alice.sendSealedEnvelope(sealedPayload, { deliveryId, originRouteId });
  return deliveryId;
}

function makeEnvelopeAAD(route: VerifiedRelayRouteMaterial, originRouteId: string, senderPeerId: string, recipientPeerId: string, deliveryId: string, hpkeCiphertextBytes: number): Uint8Array {
  return makeBetaPayloadAAD({
    protocol: protocolID,
    profileMultihash: route.profileMultihash,
    originRouteId,
    senderPeerKey: senderPeerId,
    recipientPeerKey: recipientPeerId,
    deliveryId,
    pathEpoch: defaultPathEpoch,
    streamId: defaultStreamID,
    frameType: "ENVELOPE",
    ackRequested: true,
    hpkeCiphertextBytes
  });
}

function recordTransportEvent(
  side: "Alice" | "Bob",
  event: SameRelayTransportEvent,
  record: (event: string) => void,
  recordTrace: (event: Omit<CarrierHoppingTraceEvent, "id" | "atMs">) => void,
  counters: CarrierHoppingCounters
): void {
  switch (event.type) {
    case "relay_ack":
      counters.relayAckCount += 1;
      record(`${side}: relay ${event.ackType} ${shortId(event.deliveryId)}`);
      recordTrace({
        kind: "ack",
        status: "ok",
        label: event.ackType,
        side,
        deliveryIdPreview: shortId(event.deliveryId)
      });
      return;
    case "peer_receipt":
      counters.peerReceiptCount += 1;
      record(`${side}: peer.received ${shortId(event.deliveryId)}`);
      recordTrace({
        kind: "delivery",
        status: "ok",
        label: "Peer receipt",
        side,
        deliveryIdPreview: shortId(event.deliveryId)
      });
      return;
    case "peer_unavailable":
      counters.unavailableCount += 1;
      record(`${side}: peer_unavailable pending=${String(event.pendingCount)}`);
      recordTrace({
        kind: "unavailable",
        status: "warn",
        label: "Peer unavailable",
        side,
        pendingCount: event.pendingCount
      });
      return;
    case "attached":
      record(`${side}: attached ${shortId(event.sessionId)}`);
      recordTrace({
        kind: "attach",
        status: "ok",
        label: `${side} attached`,
        side,
        route: event.endpointUri,
        routeIdPreview: shortId(event.routeId)
      });
      return;
    case "presence_announced":
      record(`${side}: presence ${shortId(event.peerId)}`);
      recordTrace({
        kind: "presence",
        status: "ok",
        label: `${side} presence`,
        side,
        peerIdPreview: shortId(event.peerId)
      });
      return;
    case "heartbeat_sent":
      record(`${side}: heartbeat #${String(event.sequence)}`);
      return;
    case "lookup_requested":
      record(`${side}: lookup ${shortId(event.peerId)}`);
      recordTrace({
        kind: "rendezvous",
        status: "pending",
        label: `${side} lookup`,
        side,
        peerIdPreview: shortId(event.peerId)
      });
      return;
    case "rendezvous_ready":
      record(`${side}: rendezvous ${shortId(event.routeId)}${event.routeHintCount > 0 ? ` hints=${String(event.routeHintCount)}` : ""}`);
      recordTrace({
        kind: event.routeHintCount > 0 ? "federation" : "rendezvous",
        status: "ok",
        label: event.routeHintCount > 0 ? "Rendezvous with route hints" : `${side} rendezvous`,
        side,
        routeIdPreview: shortId(event.routeId),
        peerIdPreview: shortId(event.peerId),
        routeHintCount: event.routeHintCount
      });
      return;
    case "envelope_sent":
      record(`${side}: envelope ${shortId(event.deliveryId)}`);
      recordTrace({
        kind: "delivery",
        status: "pending",
        label: `${side} envelope sent`,
        side,
        routeIdPreview: shortId(event.routeId),
        deliveryIdPreview: shortId(event.deliveryId)
      });
      return;
    case "envelope_received":
      record(`${side}: envelope received ${shortId(event.deliveryId)}`);
      recordTrace({
        kind: "delivery",
        status: "ok",
        label: `${side} envelope received`,
        side,
        routeIdPreview: shortId(event.routeId),
        ...(event.senderPeerId === null ? {} : { peerIdPreview: shortId(event.senderPeerId) }),
        deliveryIdPreview: shortId(event.deliveryId)
      });
      return;
    case "pending_retried":
      record(`${side}: retried ${String(event.count)}`);
      recordTrace({
        kind: "retry",
        status: event.count > 0 ? "ok" : "warn",
        label: `${side} retried pending`,
        side,
        pendingCount: event.count
      });
      return;
    case "disconnected":
      record(`${side}: disconnected pending=${String(event.pendingCount)}`);
      recordTrace({
        kind: "disconnect",
        status: event.pendingCount > 0 ? "warn" : "ok",
        label: `${side} disconnected`,
        side,
        pendingCount: event.pendingCount
      });
      return;
    case "error":
      record(`${side}: error ${event.message}`);
      recordTrace({
        kind: "error",
        status: "failed",
        label: `${side} transport error`,
        side,
        detail: event.message
      });
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
  trace: readonly CarrierHoppingTraceEvent[],
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
    trace,
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

function routeLabel(route: VerifiedRelayRouteMaterial): string {
  return route.endpointUri;
}

function routeHintsForRoute(hints: readonly RelayRouteHint[], route: VerifiedRelayRouteMaterial): readonly RelayRouteHint[] {
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
