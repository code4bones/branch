import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  SameRelayTransportClient,
  type RelayRouteMaterial,
  type SameRelayTransportEvent
} from "../connectivity/same-relay.js";
import {
  routesFromDiscoveryResults,
  runCarrierHoppingPoC,
  type RepositoryDiscoveryRouteResult
} from "../connectivity/carrier-hopping-poc.js";
import { useAdminStore, type ClientTransportStatePatch } from "./store.js";

export interface SameRelayTransportLab {
  readonly route: RelayRouteMaterial | null;
  readonly attachPair: () => Promise<void>;
  readonly sendOpaqueEnvelope: () => void;
  readonly disconnectBobAndSend: () => Promise<void>;
  readonly reconnectBobAndRetry: () => Promise<void>;
  readonly runCarrierHopPoC: () => Promise<void>;
  readonly reset: () => void;
}

interface MutableCurrent<T> {
  current: T;
}

export function useSameRelayTransportLab(): SameRelayTransportLab {
  const clientState = useAdminStore((state) => state.client);
  const setClientTransportState = useAdminStore((state) => state.setClientTransportState);
  const appendClientTransportEvent = useAdminStore((state) => state.appendClientTransportEvent);
  const resetClientTransport = useAdminStore((state) => state.resetClientTransport);
  const aliceRef = useRef<SameRelayTransportClient | null>(null);
  const bobRef = useRef<SameRelayTransportClient | null>(null);
  const unsubscribeRef = useRef<readonly (() => void)[]>([]);
  const latestCountsRef = useRef({
    relayAckCount: 0,
    peerReceiptCount: 0,
    unavailableCount: 0
  });
  const route = useMemo(() => routeFromDiscoveryResults(clientState.discoveryResults), [clientState.discoveryResults]);

  const reset = useCallback((): void => {
    aliceRef.current?.disconnect();
    bobRef.current?.disconnect();
    aliceRef.current = null;
    bobRef.current = null;
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
      relaySource: route.source ?? "",
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
      const alice = new SameRelayTransportClient({ route, identity: aliceIdentity });
      const bob = new SameRelayTransportClient({ route, identity: bobIdentity });
      aliceRef.current = alice;
      bobRef.current = bob;
      unsubscribeRef.current = [
        alice.addEventListener((event) => {
          handleTransportEvent("Alice", event, alice, appendClientTransportEvent, setClientTransportState, latestCountsRef);
        }),
        bob.addEventListener((event) => {
          handleTransportEvent("Bob", event, bob, appendClientTransportEvent, setClientTransportState, latestCountsRef);
          if (event.type === "envelope_received") {
            alice.markPeerReceipt(event.deliveryId);
          }
        })
      ];
      await Promise.all([alice.attach(), bob.attach()]);
      bob.announcePresence();
      bob.heartbeat();
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

  const sendOpaqueEnvelope = useCallback((): void => {
    const alice = aliceRef.current;
    if (alice === null) {
      setClientTransportState({
        transportStatus: "attach clients before sending",
        transportStatusClass: "status-bad"
      });
      return;
    }
    alice.sendEnvelope("opaque test bytes");
    setClientTransportState({ pendingCount: alice.pendingCount });
  }, [setClientTransportState]);

  const disconnectBobAndSend = useCallback(async (): Promise<void> => {
    const alice = aliceRef.current;
    const bob = bobRef.current;
    if (alice === null || bob === null) {
      setClientTransportState({
        transportStatus: "attach clients before disconnect test",
        transportStatusClass: "status-bad"
      });
      return;
    }
    bob.disconnect();
    await sleep(100);
    alice.sendEnvelope("opaque retry bytes");
    setClientTransportState({
      transportStatus: "bob disconnected; waiting for transient unavailable",
      transportStatusClass: "status-warn",
      pendingCount: alice.pendingCount
    });
  }, [setClientTransportState]);

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
    const routes = routesFromDiscoveryResults(clientState.discoveryResults);
    setClientTransportState({
      transportRunning: true,
      transportStatus: "running carrier-hop PoC",
      transportStatusClass: "status-warn",
      relayEndpointUri: routes[0]?.endpointUri ?? "",
      relaySource: routes[0]?.source ?? "",
      relayAckCount: 0,
      peerReceiptCount: 0,
      pendingCount: 0,
      unavailableCount: 0
    });
    try {
      const report = await runCarrierHoppingPoC({
        routes,
        onEvent: appendClientTransportEvent
      });
      setClientTransportState({
        transportRunning: false,
        transportStatus: report.reason,
        transportStatusClass: report.status === "ok" ? "status-good" : report.status === "degraded" ? "status-warn" : "status-bad",
        relayEndpointUri: report.migrationRoute ?? report.activeRoute ?? "",
        relaySource: report.migrationRoute ?? report.activeRoute ?? "",
        relayAckCount: report.relayAckCount,
        peerReceiptCount: report.peerReceiptCount,
        pendingCount: report.pendingCount,
        unavailableCount: report.unavailableCount
      });
    } catch (error) {
      setClientTransportState({
        transportRunning: false,
        transportStatus: errorMessage(error),
        transportStatusClass: "status-bad"
      });
    }
  }, [appendClientTransportEvent, clientState.discoveryResults, reset, setClientTransportState]);

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

export function routeFromDiscoveryResults(results: readonly RepositoryDiscoveryRouteResult[]): RelayRouteMaterial | null {
  return routesFromDiscoveryResults(results)[0] ?? null;
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
      appendClientTransportEvent(`${side}: rendezvous ${shortId(event.routeId)}`);
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "same-relay transport failed";
}
