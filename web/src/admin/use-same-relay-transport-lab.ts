import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  SameRelayTransportClient,
  parseRelayEndpointDescriptor,
  validateRouteMaterial,
  type RelayRouteMaterial,
  type SameRelayTransportEvent
} from "@code4bones/branch-core/connectivity/same-relay.js";
import {
  betaHpkeCiphertextBytesForPlaintext,
  betaHpkeCiphertextBytesFromSealedPayload,
  createBetaPayloadKeyPair,
  makeBetaPayloadAAD,
  openBetaPayload,
  sealBetaPayload,
  type BetaPayloadKeyPair
} from "@code4bones/branch-core/connectivity/payload-crypto.js";
import { routeHintsFromBeaconObservations, runDiscoveredCarrierHopPoC, routesFromBeaconObservations } from "@code4bones/branch-core/discovery/carrier-hop-client.js";
import type { BeaconObservation } from "@code4bones/branch-core/discovery/client.js";
import { createGitHubSearchCarrier, gitHubReportsFromCarrierReports, mergeGitHubDiscoveryReports } from "@code4bones/branch-core/discovery/github.js";
import { encodeBase64URL } from "@code4bones/branch-core/protocol/v0/base64url.js";
import { protocolID } from "@code4bones/branch-core/protocol/v0/envelope.js";
import { useAdminStore, type ClientTransportStatePatch } from "./store.js";

export interface SameRelayTransportLab {
  readonly route: RelayRouteMaterial | null;
  readonly attachPair: () => Promise<void>;
  readonly sendOpaqueEnvelope: () => Promise<void>;
  readonly disconnectBobAndSend: () => Promise<void>;
  readonly reconnectBobAndRetry: () => Promise<void>;
  readonly runCarrierHopPoC: () => Promise<void>;
  readonly reset: () => void;
}

interface MutableCurrent<T> {
  current: T;
}

interface AdminDiscoveryRouteRecord {
  readonly validation: "accepted" | "rejected";
  readonly relayEndpoint: string | null;
  readonly senderPublicKey: string | null;
  readonly profileMultihash: string | null;
}

interface AdminDiscoveryRouteResult {
  readonly records: readonly AdminDiscoveryRouteRecord[];
}

const liveRelayPropagationWaitMs = 500;

export function useSameRelayTransportLab(): SameRelayTransportLab {
  const clientState = useAdminStore((state) => state.client);
  const setClientTransportState = useAdminStore((state) => state.setClientTransportState);
  const setClientDiscoveryResults = useAdminStore((state) => state.setClientDiscoveryResults);
  const setClientDiscoveryStatus = useAdminStore((state) => state.setClientDiscoveryStatus);
  const appendClientTransportEvent = useAdminStore((state) => state.appendClientTransportEvent);
  const resetClientTransport = useAdminStore((state) => state.resetClientTransport);
  const aliceRef = useRef<SameRelayTransportClient | null>(null);
  const bobRef = useRef<SameRelayTransportClient | null>(null);
  const bobPayloadKeyRef = useRef<BetaPayloadKeyPair | null>(null);
  const unsubscribeRef = useRef<readonly (() => void)[]>([]);
  const latestCountsRef = useRef({
    relayAckCount: 0,
    peerReceiptCount: 0,
    unavailableCount: 0
  });
  const route = useMemo(
    () => selectedClientRoute(clientState),
    [clientState.discoveryResults, clientState.manualProfileMultihash, clientState.manualRelayEndpointUri, clientState.manualRelayPublicKey, clientState.routeMode]
  );

  const reset = useCallback((): void => {
    aliceRef.current?.disconnect();
    bobRef.current?.disconnect();
    aliceRef.current = null;
    bobRef.current = null;
    bobPayloadKeyRef.current = null;
    for (const unsubscribe of unsubscribeRef.current) {
      unsubscribe();
    }
    unsubscribeRef.current = [];
    latestCountsRef.current = {
      relayAckCount: 0,
      peerReceiptCount: 0,
      unavailableCount: 0
    };
    resetClientTransport();
  }, [resetClientTransport]);

  useEffect(() => reset, [reset]);

  const attachPair = useCallback(async (): Promise<void> => {
    if (route === null) {
      setClientTransportState({
        transportStatus: "no accepted relay route from discovery",
        transportStatusClass: "status-bad"
      });
      return;
    }
    reset();
    setClientTransportState({
      transportRunning: true,
      transportStatus: "attaching two local clients",
      transportStatusClass: "status-warn",
      relayEndpointUri: route.endpointUri,
      relaySource: route.endpointUri,
      relayAckCount: 0,
      peerReceiptCount: 0,
      pendingCount: 0,
      unavailableCount: 0
    });
    try {
      const [aliceIdentity, bobIdentity] = await Promise.all([
        SameRelayTransportClient.createIdentity(),
        SameRelayTransportClient.createIdentity()
      ]);
      const bobPayloadKey = await createBetaPayloadKeyPair();
      const alice = new SameRelayTransportClient({ route, identity: aliceIdentity });
      const bob = new SameRelayTransportClient({ route, identity: bobIdentity });
      aliceRef.current = alice;
      bobRef.current = bob;
      bobPayloadKeyRef.current = bobPayloadKey;
      unsubscribeRef.current = [
        alice.addEventListener((event) => {
          handleTransportEvent("Alice", event, alice, appendClientTransportEvent, setClientTransportState, latestCountsRef);
        }),
        bob.addEventListener((event) => {
          handleTransportEvent("Bob", event, bob, appendClientTransportEvent, setClientTransportState, latestCountsRef);
          if (event.type === "envelope_received") {
            void openBetaPayload({
              recipientPrivateKey: bobPayloadKey.privateKey,
              sealedPayload: event.ciphertext,
              aad: makeEnvelopeAAD(route, event.originRouteId, alice.peerId, bob.peerId, event.deliveryId, betaHpkeCiphertextBytesFromSealedPayload(event.ciphertext)),
              expectedCiphertextBytes: betaHpkeCiphertextBytesFromSealedPayload(event.ciphertext)
            }).then(() => {
              alice.markPeerReceipt(event.deliveryId);
            }).catch((error: unknown) => {
              appendClientTransportEvent(`Bob: payload rejected ${errorMessage(error)}`);
            });
          }
        })
      ];
      await Promise.all([alice.attach(), bob.attach()]);
      alice.announcePresence();
      bob.announcePresence();
      alice.heartbeat();
      bob.heartbeat();
      await sleep(liveRelayPropagationWaitMs);
      alice.lookup(bob.peerId);
      alice.rendezvous(bob.peerId);
      setClientTransportState({
        transportRunning: false,
        transportStatus: "same-relay route ready",
        transportStatusClass: "status-good",
        alicePeerId: alice.peerId,
        bobPeerId: bob.peerId,
        pendingCount: alice.pendingCount
      });
    } catch (error) {
      setClientTransportState({
        transportRunning: false,
        transportStatus: errorMessage(error),
        transportStatusClass: "status-bad"
      });
    }
  }, [appendClientTransportEvent, reset, route, setClientTransportState]);

  const sendOpaqueEnvelope = useCallback(async (): Promise<void> => {
    const alice = aliceRef.current;
    const bob = bobRef.current;
    const bobPayloadKey = bobPayloadKeyRef.current;
    if (alice === null || bob === null || route === null || bobPayloadKey === null) {
      setClientTransportState({
        transportStatus: "attach clients before sending",
        transportStatusClass: "status-bad"
      });
      return;
    }
    await sendEncryptedEnvelope(alice, bob, bobPayloadKey, route, "opaque test bytes");
    setClientTransportState({ pendingCount: alice.pendingCount });
  }, [route, setClientTransportState]);

  const disconnectBobAndSend = useCallback(async (): Promise<void> => {
    const alice = aliceRef.current;
    const bob = bobRef.current;
    const bobPayloadKey = bobPayloadKeyRef.current;
    if (alice === null || bob === null || route === null || bobPayloadKey === null) {
      setClientTransportState({
        transportStatus: "attach clients before disconnect test",
        transportStatusClass: "status-bad"
      });
      return;
    }
    bob.disconnect();
    await sleep(100);
    await sendEncryptedEnvelope(alice, bob, bobPayloadKey, route, "opaque retry bytes");
    setClientTransportState({
      transportStatus: "bob disconnected; waiting for transient unavailable",
      transportStatusClass: "status-warn",
      pendingCount: alice.pendingCount
    });
  }, [route, setClientTransportState]);

  const reconnectBobAndRetry = useCallback(async (): Promise<void> => {
    const alice = aliceRef.current;
    const bob = bobRef.current;
    if (alice === null || bob === null) {
      setClientTransportState({
        transportStatus: "attach clients before retry",
        transportStatusClass: "status-bad"
      });
      return;
    }
    setClientTransportState({
      transportRunning: true,
      transportStatus: "reconnecting bob from client-owned retry state",
      transportStatusClass: "status-warn"
    });
    try {
      await bob.reconnect();
      bob.announcePresence();
      bob.heartbeat();
      await sleep(liveRelayPropagationWaitMs);
      alice.rendezvous(bob.peerId);
      alice.retryPending();
      setClientTransportState({
        transportRunning: false,
        transportStatus: "pending envelopes retried",
        transportStatusClass: "status-good",
        pendingCount: alice.pendingCount
      });
    } catch (error) {
      setClientTransportState({
        transportRunning: false,
        transportStatus: errorMessage(error),
        transportStatusClass: "status-bad"
      });
    }
  }, [setClientTransportState]);

  const runCarrierHopPoC = useCallback(async (): Promise<void> => {
    reset();
    setClientTransportState({
      transportRunning: true,
      transportStatus: "discovering GitHub route snapshot",
      transportStatusClass: "status-warn",
      relayEndpointUri: "",
      relaySource: "",
      relayAckCount: 0,
      peerReceiptCount: 0,
      pendingCount: 0,
      unavailableCount: 0
    });
    try {
      const report = await runDiscoveredCarrierHopPoC({
        carrier: createGitHubSearchCarrier(),
        primaryQuery: clientState.discoveryQuery,
        fallbackQuery: null,
        includeFallback: false,
        includeForks: false,
        perPage: 5,
        page: 1,
        onDiscoveryReport: (discovery) => {
          const gitHubReport = mergeGitHubDiscoveryReports(gitHubReportsFromCarrierReports(discovery.carrierReports));
          setClientDiscoveryResults(gitHubReport.results, gitHubReport.rateLimitRemaining, gitHubReport.incompleteResults);
          setClientDiscoveryStatus(
            `${discovery.message}; route snapshot ${String(routesFromBeaconObservations(discovery.observations).length)}; route hints ${String(routeHintsFromBeaconObservations(discovery.observations).length)}`,
            discovery.status === "ok" || discovery.status === "partial" ? "status-good" : "status-warn"
          );
        },
        onTransportEvent: appendClientTransportEvent
      });
      const firstRoute = report.routeSnapshot[0] ?? null;
      setClientTransportState({
        transportRunning: false,
        transportStatus: report.transport.reason,
        transportStatusClass: report.transport.status === "ok" ? "status-good" : report.transport.status === "degraded" ? "status-warn" : "status-bad",
        relayEndpointUri: report.transport.migrationRoute ?? report.transport.activeRoute ?? firstRoute?.endpointUri ?? "",
        relaySource: firstRoute?.endpointUri ?? "",
        relayAckCount: report.transport.relayAckCount,
        peerReceiptCount: report.transport.peerReceiptCount,
        pendingCount: report.transport.pendingCount,
        unavailableCount: report.transport.unavailableCount,
        federationTrace: {
          events: report.transport.trace,
          routeSnapshot: report.routeSnapshot.map((routeSnapshot) => routeSnapshot.endpointUri),
          routeHints: report.routeHintsSnapshot.map((routeHint) => routeHint.uri),
          activeRoute: report.transport.activeRoute,
          migrationRoute: report.transport.migrationRoute,
          migrated: report.transport.migrated
        }
      });
    } catch (error) {
      setClientTransportState({
        transportRunning: false,
        transportStatus: errorMessage(error),
        transportStatusClass: "status-bad"
      });
    }
  }, [appendClientTransportEvent, clientState.discoveryQuery, reset, setClientDiscoveryResults, setClientDiscoveryStatus, setClientTransportState]);

  return {
    route,
    attachPair,
    sendOpaqueEnvelope,
    disconnectBobAndSend,
    reconnectBobAndRetry,
    runCarrierHopPoC,
    reset
  };
}

export function routeFromDiscoveryResults(results: readonly AdminDiscoveryRouteResult[]): RelayRouteMaterial | null {
  return routesFromDiscoveryResults(results)[0] ?? null;
}

export function routesFromDiscoveryResults(results: readonly AdminDiscoveryRouteResult[]): readonly RelayRouteMaterial[] {
  const observations: BeaconObservation[] = [];
  results.forEach((result, resultIndex) => {
    result.records.forEach((record, recordIndex) => {
      observations.push({
        observationId: `admin:${String(resultIndex)}:${String(recordIndex)}`,
        validation: record.validation,
        reason: "",
        wrapperPreview: "",
        evidence: {
          carrier: "admin",
          query: "",
          source: "",
          sourceUrl: "",
          recordUrl: ""
        },
        expiresAt: null,
        relayEndpoint: record.relayEndpoint,
        profileMultihash: record.profileMultihash,
        senderPublicKey: record.senderPublicKey,
        beaconId: null,
        sequence: null
      });
    });
  });
  return routesFromBeaconObservations(observations);
}

export function routeFromManualFields(
  endpointValue: string,
  relayPublicKey: string,
  profileMultihash: string
): RelayRouteMaterial | null {
  const endpoint = parseManualEndpoint(endpointValue);
  if (endpoint === null || relayPublicKey.trim() === "" || profileMultihash.trim() === "") {
    return null;
  }
  try {
    return validateRouteMaterial({
      endpointUri: endpoint,
      relayPublicKey: relayPublicKey.trim(),
      profileMultihash: profileMultihash.trim()
    });
  } catch {
    return null;
  }
}

function selectedClientRoute(clientState: {
  readonly routeMode: "discovery" | "manual";
  readonly discoveryResults: readonly AdminDiscoveryRouteResult[];
  readonly manualRelayEndpointUri: string;
  readonly manualRelayPublicKey: string;
  readonly manualProfileMultihash: string;
}): RelayRouteMaterial | null {
  if (clientState.routeMode === "manual") {
    return routeFromManualFields(
      clientState.manualRelayEndpointUri,
      clientState.manualRelayPublicKey,
      clientState.manualProfileMultihash
    );
  }
  return routeFromDiscoveryResults(clientState.discoveryResults);
}

function parseManualEndpoint(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.startsWith("wss://")) {
    return trimmed;
  }
  return parseRelayEndpointDescriptor(trimmed)?.uri ?? null;
}

async function sendEncryptedEnvelope(
  alice: SameRelayTransportClient,
  bob: SameRelayTransportClient,
  bobPayloadKey: BetaPayloadKeyPair,
  route: RelayRouteMaterial,
  plaintext: string
): Promise<string> {
  const deliveryId = randomToken(16);
  const originRouteId = alice.routeId;
  if (originRouteId === null) {
    throw new Error("relay session is not attached");
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

function makeEnvelopeAAD(route: RelayRouteMaterial, originRouteId: string, senderPeerId: string, recipientPeerId: string, deliveryId: string, hpkeCiphertextBytes: number): Uint8Array {
  return makeBetaPayloadAAD({
    protocol: protocolID,
    profileMultihash: route.profileMultihash,
    originRouteId,
    senderPeerKey: senderPeerId,
    recipientPeerKey: recipientPeerId,
    deliveryId,
    pathEpoch: 0,
    streamId: 0,
    frameType: "ENVELOPE",
    ackRequested: true,
    hpkeCiphertextBytes
  });
}

function handleTransportEvent(
  side: "Alice" | "Bob",
  event: SameRelayTransportEvent,
  alice: SameRelayTransportClient,
  appendClientTransportEvent: (event: string) => void,
  setClientTransportState: (patch: ClientTransportStatePatch) => void,
  latestCountsRef: MutableCurrent<{
    relayAckCount: number;
    peerReceiptCount: number;
    unavailableCount: number;
  }>
): void {
  const counts = latestCountsRef.current;
  switch (event.type) {
    case "relay_ack":
      counts.relayAckCount += 1;
      setClientTransportState({ relayAckCount: counts.relayAckCount, pendingCount: alice.pendingCount });
      appendClientTransportEvent(`${side}: relay ${event.ackType} ${shortId(event.deliveryId)}`);
      return;
    case "peer_receipt":
      counts.peerReceiptCount += 1;
      setClientTransportState({ peerReceiptCount: counts.peerReceiptCount, pendingCount: alice.pendingCount });
      appendClientTransportEvent(`${side}: peer.received ${shortId(event.deliveryId)}`);
      return;
    case "peer_unavailable":
      counts.unavailableCount += 1;
      setClientTransportState({
        unavailableCount: counts.unavailableCount,
        pendingCount: alice.pendingCount,
        transportStatus: "peer unavailable; relay kept no mailbox",
        transportStatusClass: "status-warn"
      });
      appendClientTransportEvent(`${side}: peer_unavailable pending=${String(event.pendingCount)}`);
      return;
    case "attached":
      appendClientTransportEvent(`${side}: attached ${shortId(event.sessionId)}`);
      return;
    case "presence_announced":
      appendClientTransportEvent(`${side}: presence ${shortId(event.peerId)}`);
      return;
    case "heartbeat_sent":
      appendClientTransportEvent(`${side}: heartbeat #${String(event.sequence)}`);
      return;
    case "lookup_requested":
      appendClientTransportEvent(`${side}: lookup ${shortId(event.peerId)}`);
      return;
    case "rendezvous_ready":
      appendClientTransportEvent(`${side}: rendezvous ${shortId(event.routeId)}${event.routeHintCount > 0 ? ` hints=${String(event.routeHintCount)}` : ""}`);
      return;
    case "envelope_sent":
      setClientTransportState({ pendingCount: alice.pendingCount });
      appendClientTransportEvent(`${side}: envelope ${shortId(event.deliveryId)}`);
      return;
    case "envelope_received":
      appendClientTransportEvent(`${side}: envelope received ${shortId(event.deliveryId)}`);
      return;
    case "pending_retried":
      setClientTransportState({ pendingCount: alice.pendingCount });
      appendClientTransportEvent(`${side}: retried ${String(event.count)}`);
      return;
    case "disconnected":
      setClientTransportState({ pendingCount: alice.pendingCount });
      appendClientTransportEvent(`${side}: disconnected`);
      return;
    case "error":
      setClientTransportState({ transportStatus: event.message, transportStatusClass: "status-bad" });
      appendClientTransportEvent(`${side}: error ${event.message}`);
      return;
  }
}

function shortId(value: string): string {
  return value.length <= 10 ? value : `${value.slice(0, 10)}...`;
}

function randomToken(size: number): string {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return encodeBase64URL(bytes);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "same-relay transport failed";
}
