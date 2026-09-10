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
