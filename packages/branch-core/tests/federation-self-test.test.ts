import assert from "node:assert/strict";
import test from "node:test";

import { runFederationSelfTest } from "../src/connectivity/federation-self-test.js";
import { developmentProfileMultihash } from "../src/protocol/v0/profile.js";
import {
  createTrustedRelayRouteFixture,
  type BrowserRelaySocket,
  type RelaySocketEvent,
  type RelaySocketEventType
} from "../src/connectivity/same-relay.js";

const relayKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

test("federation self-test rejects one route before opening a socket", async () => {
  const report = await runFederationSelfTest({
    routes: [fixture({
      endpointUri: "wss://relay01.example.test/relay/v0",
      relayPublicKey: relayKey,
      profileMultihash: developmentProfileMultihash
    })]
  });

  assert.deepEqual(report, {
    status: "failed",
    reason: "insufficient_distinct_routes",
    attempts: [],
    totalPairCount: 0,
    attemptLimitReached: false
  });
});

test("federation self-test does not treat duplicate endpoints as distinct relays", async () => {
  const route = fixture({
    endpointUri: "wss://relay01.example.test/relay/v0",
    relayPublicKey: relayKey,
    profileMultihash: developmentProfileMultihash
  });
  const report = await runFederationSelfTest({ routes: [route, { ...route }] });

  assert.equal(report.status, "failed");
  assert.equal(report.reason, "insufficient_distinct_routes");
  assert.deepEqual(report.attempts, []);
  assert.equal(report.totalPairCount, 0);
  assert.equal(report.attemptLimitReached, false);
});

test("federation self-test schedules bounded pairs across every available relay", async () => {
  const report = await runFederationSelfTest({
    routes: ["01", "02", "04", "05"].map((suffix) => fixture({
      endpointUri: `wss://relay${suffix}.example.test/relay/v0`,
      relayPublicKey: relayKey,
      profileMultihash: developmentProfileMultihash
    })),
    socketFactory: rejectedSocket
  });

  assert.equal(report.status, "failed");
  assert.equal(report.reason, "scheduled_pairs_failed");
  assert.equal(report.totalPairCount, 12);
  assert.equal(report.attemptLimitReached, true);
  assert.equal(report.attempts.length, 6);
  assert.deepEqual(
    new Set(report.attempts.map((attempt) => attempt.sourceEndpoint)),
    new Set(["wss://relay01.example.test/relay/v0", "wss://relay02.example.test/relay/v0", "wss://relay04.example.test/relay/v0", "wss://relay05.example.test/relay/v0"])
  );
});

function fixture(route: { readonly endpointUri: string; readonly relayPublicKey: string; readonly profileMultihash: string }) {
  return createTrustedRelayRouteFixture(route);
}

function rejectedSocket(): BrowserRelaySocket {
  const listeners = new Map<RelaySocketEventType, Set<(event: RelaySocketEvent) => void>>();
  return {
    readyState: 0,
    send() {},
    close() {},
    addEventListener(type, listener) {
      const typeListeners = listeners.get(type) ?? new Set<(event: RelaySocketEvent) => void>();
      typeListeners.add(listener);
      listeners.set(type, typeListeners);
      if (type === "error") {
        queueMicrotask(() => { listener(new Event("error")); });
      }
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    }
  };
}
