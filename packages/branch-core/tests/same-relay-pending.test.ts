import assert from "node:assert/strict";
import test from "node:test";

import { developmentProfileMultihash } from "../src/protocol/v0/profile.js";
import { SameRelayTransportClient, makeVersionOffer, type SameRelayPendingEnvelope } from "../src/connectivity/same-relay.js";
import { contactDiscoveryLiveExtension } from "../src/protocol/v0/relay-attachment.js";

void test("relay.forwarded releases only its live pending envelope before the ACK event", () => {
  const first = pending(1);
  const second = pending(2);
  const client = clientWithPending([first, second]);
  const events: string[] = [];
  let pendingAtForwardedAck = -1;
  client.addEventListener((event) => {
    events.push(event.type);
    if (event.type === "relay_ack" && event.ackType === "relay.forwarded") {
      pendingAtForwardedAck = client.pendingCount;
    }
  });
  const process = (client as unknown as { processReadyFrame(record: Record<string, unknown>): void }).processReadyFrame.bind(client);

  process({ type: "ACK", ack_type: "relay.accepted", delivery_id: first.deliveryId });
  assert.equal(client.pendingCount, 2);
  process({ type: "ACK", ack_type: "relay.forwarded", delivery_id: token(9) });
  assert.equal(client.pendingCount, 2);
  process({ type: "ACK", ack_type: "relay.forwarded", delivery_id: first.deliveryId });
  assert.equal(client.pendingCount, 1);
  assert.equal(pendingAtForwardedAck, 1);
  assert.deepEqual(events, ["relay_ack", "relay_ack", "relay_ack"]);

  process({ type: "ACK", ack_type: "peer.received", delivery_id: second.deliveryId });
  assert.equal(client.pendingCount, 0);
});

void test("client pending state has the explicit reference-relay live ceiling", () => {
  const maximum = Array.from({ length: 32 }, (_, index) => pending(index + 1));
  assert.equal(clientWithPending(maximum).pendingCount, 32);
  assert.throws(() => clientWithPending([...maximum, pending(33)]), /live pending envelope limit exceeded/);
  assert.throws(() => clientWithPending([], 0), /invalid live pending envelope limit/);
});

void test("local abandonment releases exactly one pending slot without sending a frame", () => {
  const first = pending(1);
  const second = pending(2);
  const client = clientWithPending([first, second]);
  const events: string[] = [];
  client.addEventListener((event) => { events.push(event.type); });

  assert.equal(client.abandonPendingEnvelope(first.deliveryId), true);
  assert.equal(client.pendingCount, 1);
  assert.deepEqual(client.exportPendingEnvelopes().map((entry) => entry.deliveryId), [second.deliveryId]);
  assert.deepEqual(events, ["pending_abandoned"]);
  assert.equal(client.abandonPendingEnvelope(first.deliveryId), false);
  assert.equal(client.abandonPendingEnvelope(token(99)), false);
  assert.equal(client.pendingCount, 1);

  const process = (client as unknown as { processReadyFrame(record: Record<string, unknown>): void }).processReadyFrame.bind(client);
  process({ type: "ACK", ack_type: "relay.forwarded", delivery_id: first.deliveryId });
  assert.equal(client.pendingCount, 1);
});

void test("local abandonment permits one replacement within the fixed 32-envelope ceiling", () => {
  const maximum = Array.from({ length: 32 }, (_, index) => pending(index + 1));
  const client = clientWithPending(maximum);
  assert.equal(client.abandonPendingEnvelope(maximum[0]?.deliveryId ?? ""), true);
  const replacement = pending(33);
  assert.equal(clientWithPending([...client.exportPendingEnvelopes(), replacement]).pendingCount, 32);
});

void test("contact discovery remains an explicit negotiated live extension", () => {
  assert.deepEqual(makeVersionOffer().extensions, [contactDiscoveryLiveExtension]);
  const client = clientWithPending([]);
  const events: string[] = [];
  client.addEventListener((event) => { events.push(event.type); });
  const internals = client as unknown as {
    ready: { sessionId: string; routeId: string; presenceTtlSeconds: number; heartbeatIntervalSeconds: number };
    contactDiscoveryEnabled: boolean;
    processReadyFrame(record: Record<string, unknown>): void;
  };
  internals.ready = { sessionId: token(12), routeId: Buffer.alloc(16, 13).toString("base64url"), presenceTtlSeconds: 30, heartbeatIntervalSeconds: 10 };
  internals.contactDiscoveryEnabled = true;
  const expiresAt = Date.now() + 60_000;
  internals.processReadyFrame({
    type: "CONTACT_PROBE",
    session_id: token(12),
    request_id: Buffer.alloc(16, 14).toString("base64url"),
    branch_id: token(15),
    requester_peer_id: token(16),
    requester_hpke_public_key: token(17),
    issued_at: Date.now(),
    expires_at: expiresAt
  });
  assert.deepEqual(events, ["contact_probe"]);
});

void test("contact lookup accepts the canonical br1 multihash BranchID", () => {
  const client = clientWithPending([]);
  const sent: string[] = [];
  const internals = client as unknown as {
    ready: { sessionId: string; routeId: string; presenceTtlSeconds: number; heartbeatIntervalSeconds: number };
    contactDiscoveryEnabled: boolean;
    socket: { readonly readyState: number; send(frame: string): void };
  };
  internals.ready = { sessionId: token(12), routeId: Buffer.alloc(16, 13).toString("base64url"), presenceTtlSeconds: 30, heartbeatIntervalSeconds: 10 };
  internals.contactDiscoveryEnabled = true;
  internals.socket = { readyState: 1, send: (frame) => { sent.push(frame); } };
  const branchID = `br1.${Buffer.concat([Buffer.from([0x12, 0x20]), Buffer.alloc(32, 15)]).toString("base64url")}`;

  assert.doesNotThrow(() => client.lookupContact(branchID, token(17)));
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0] ?? "{}").branch_id, branchID);
});

void test("distinct peers use distinct live lookup routes while retaining the READY origin nonce", () => {
  const client = clientWithPending([]);
  const sent: string[] = [];
  const internals = client as unknown as {
    ready: { sessionId: string; routeId: string; presenceTtlSeconds: number; heartbeatIntervalSeconds: number };
    socket: { readonly readyState: number; send(frame: string): void };
  };
  const originRouteId = routeToken(21);
  internals.ready = { sessionId: token(20), routeId: originRouteId, presenceTtlSeconds: 30, heartbeatIntervalSeconds: 10 };
  internals.socket = { readyState: 1, send: (frame) => { sent.push(frame); } };
  const firstRouteId = routeToken(22);
  const secondRouteId = routeToken(23);

  client.rendezvous(token(24), { routeId: firstRouteId });
  client.sendSealedEnvelope("AA", { deliveryId: routeToken(25), routeId: firstRouteId, originRouteId });
  client.rendezvous(token(26), { routeId: secondRouteId });
  client.sendSealedEnvelope("AA", { deliveryId: routeToken(27), routeId: secondRouteId, originRouteId });

  const frames = sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  assert.deepEqual(frames.map((frame) => frame.route_id), [firstRouteId, firstRouteId, secondRouteId, secondRouteId]);
  assert.deepEqual(
    frames.filter((frame) => frame.type === "ENVELOPE").map((frame) => frame.origin_route_id),
    [originRouteId, originRouteId]
  );
});

void test("core allocates target lookup routes without reusing the READY AAD nonce", () => {
  const client = clientWithPending([]);
  const sent: string[] = [];
  const internals = client as unknown as {
    ready: { sessionId: string; routeId: string; presenceTtlSeconds: number; heartbeatIntervalSeconds: number };
    socket: { readonly readyState: number; send(frame: string): void };
  };
  const originRouteId = routeToken(30);
  internals.ready = { sessionId: token(31), routeId: originRouteId, presenceTtlSeconds: 30, heartbeatIntervalSeconds: 10 };
  internals.socket = { readyState: 1, send: (frame) => { sent.push(frame); } };
  const firstPeer = token(32);
  const secondPeer = token(33);

  const firstRouteId = client.rendezvous(firstPeer);
  const secondRouteId = client.rendezvous(secondPeer);

  assert.notEqual(firstRouteId, originRouteId);
  assert.notEqual(secondRouteId, originRouteId);
  assert.notEqual(firstRouteId, secondRouteId);
  assert.throws(() => client.rendezvous(secondPeer, { routeId: firstRouteId }), /peer already has a different relay lookup route/);
  assert.throws(() => client.rendezvous(token(36), { routeId: firstRouteId }), /already bound to another peer/);
  assert.throws(() => client.sendSealedEnvelope("AA", { deliveryId: routeToken(34) }), /explicit relay lookup route is required for multiple peers/);

  client.sendSealedEnvelope("AA", { deliveryId: routeToken(35), routeId: secondRouteId });
  const envelope = JSON.parse(sent.at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(envelope.type, "ENVELOPE");
  assert.equal(envelope.route_id, secondRouteId);
  assert.equal(envelope.origin_route_id, originRouteId);
});

void test("single-peer compatibility selects the sole live lookup route, never READY", () => {
  const client = clientWithPending([]);
  const sent: string[] = [];
  const internals = client as unknown as {
    ready: { sessionId: string; routeId: string; presenceTtlSeconds: number; heartbeatIntervalSeconds: number };
    socket: { readonly readyState: number; send(frame: string): void };
  };
  const originRouteId = routeToken(40);
  internals.ready = { sessionId: token(41), routeId: originRouteId, presenceTtlSeconds: 30, heartbeatIntervalSeconds: 10 };
  internals.socket = { readyState: 1, send: (frame) => { sent.push(frame); } };

  const lookupRouteId = client.rendezvous(token(42));
  client.sendSealedEnvelope("AA", { deliveryId: routeToken(43) });

  const envelope = JSON.parse(sent.at(-1) ?? "{}") as Record<string, unknown>;
  assert.notEqual(lookupRouteId, originRouteId);
  assert.equal(envelope.route_id, lookupRouteId);
  assert.equal(envelope.origin_route_id, originRouteId);
  assert.throws(() => client.rendezvous(token(44), { routeId: originRouteId }), /READY route id cannot be used/);
  assert.throws(() => client.sendSealedEnvelope("AA", { deliveryId: routeToken(45), routeId: originRouteId }), /READY route id cannot be used/);
});

void test("a relay close forgets target lookup bindings before a fresh attachment", () => {
  const client = clientWithPending([]);
  const internals = client as unknown as {
    ready: { sessionId: string; routeId: string; presenceTtlSeconds: number; heartbeatIntervalSeconds: number };
    socket: { readonly readyState: number; send(frame: string): void };
    handleSocketClose(event: Event): void;
  };
  const firstOriginRouteId = routeToken(50);
  const lookupRouteId = routeToken(51);
  internals.ready = { sessionId: token(52), routeId: firstOriginRouteId, presenceTtlSeconds: 30, heartbeatIntervalSeconds: 10 };
  internals.socket = { readyState: 1, send: () => undefined };
  client.rendezvous(token(53), { routeId: lookupRouteId });

  internals.handleSocketClose(new Event("close"));
  internals.ready = { sessionId: token(54), routeId: routeToken(55), presenceTtlSeconds: 30, heartbeatIntervalSeconds: 10 };
  internals.socket = { readyState: 1, send: () => undefined };

  assert.doesNotThrow(() => client.rendezvous(token(56), { routeId: lookupRouteId }));
});

function clientWithPending(pendingEnvelopes: readonly SameRelayPendingEnvelope[], maxPendingEnvelopes?: number): SameRelayTransportClient {
  return new SameRelayTransportClient({
    route: {
      endpointUri: "wss://relay.example/relay/v0",
      relayPublicKey: token(41),
      profileMultihash: developmentProfileMultihash
    },
    identity: { peerId: token(42), publicKey: token(42), privateKey: {} as CryptoKey },
    pendingEnvelopes,
    ...(maxPendingEnvelopes === undefined ? {} : { maxPendingEnvelopes })
  });
}

function pending(value: number): SameRelayPendingEnvelope {
  return {
    deliveryId: token(value),
    ciphertext: "AA",
    originRouteId: Buffer.alloc(16, value).toString("base64url"),
    streamId: 0,
    ackRequested: true
  };
}

function token(value: number): string {
  return Buffer.alloc(32, value).toString("base64url");
}

function routeToken(value: number): string {
  return Buffer.alloc(16, value).toString("base64url");
}
