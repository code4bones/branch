import { test } from "node:test";
import assert from "node:assert/strict";

import { encodeBase64URL, decodeBase64URL } from "../src/protocol/v0/base64url.js";
import { developmentProfileMultihash } from "../src/protocol/v0/profile.js";
import { relayProofDomain } from "../src/protocol/v0/relay-attachment.js";
import {
  SameRelayTransportClient,
  type BrowserRelaySocket,
  type RelaySocketEvent,
  type RelaySocketEventType,
  type SameRelayTransportEvent
} from "../src/connectivity/same-relay.js";
import { routeFromDiscoveryResults } from "../src/admin/use-same-relay-transport-lab.js";
import type { GitHubDiscoveryResult } from "../src/discovery/github.js";

void test("same-relay browser transport handles live forwarding, unavailable, and client retry", async () => {
  const relay = await FakeRelay.create();
  const route = {
    endpointUri: "wss://relay.test:443/relay/v0",
    relayPublicKey: relay.publicKey,
    profileMultihash: developmentProfileMultihash
  };
  const [aliceIdentity, bobIdentity] = await Promise.all([
    SameRelayTransportClient.createIdentity(),
    SameRelayTransportClient.createIdentity()
  ]);
  const alice = new SameRelayTransportClient({ route, identity: aliceIdentity, socketFactory: relay.socketFactory });
  const bob = new SameRelayTransportClient({ route, identity: bobIdentity, socketFactory: relay.socketFactory });
  const aliceEvents: SameRelayTransportEvent[] = [];
  const bobEvents: SameRelayTransportEvent[] = [];
  alice.addEventListener((event) => {
    aliceEvents.push(event);
  });
  bob.addEventListener((event) => {
    bobEvents.push(event);
    if (event.type === "envelope_received") {
      alice.markPeerReceipt(event.deliveryId);
    }
  });

  await Promise.all([alice.attach(), bob.attach()]);
  bob.announcePresence();
  bob.heartbeat();
  alice.lookup(bob.peerId);
  alice.rendezvous(bob.peerId);
  const deliveredID = alice.sendEnvelope("first opaque payload");
  await settle();

  assert(aliceEvents.some((event) => event.type === "attached"));
  assert(bobEvents.some((event) => event.type === "presence_announced"));
  assert(aliceEvents.some((event) => event.type === "relay_ack" && event.ackType === "relay.forwarded"));
  assert(aliceEvents.some((event) => event.type === "peer_receipt" && event.deliveryId === deliveredID));
  assert(bobEvents.some((event) => event.type === "envelope_received" && event.deliveryId === deliveredID));
  assert.equal(alice.pendingCount, 0);

  bob.disconnect();
  await settle();
  const retryID = alice.sendEnvelope("retry-owned payload");
  await settle();

  assert(aliceEvents.some((event) => event.type === "peer_unavailable"));
  assert.equal(alice.pendingCount, 1);

  await bob.reconnect();
  bob.announcePresence();
  bob.heartbeat();
  alice.rendezvous(bob.peerId);
  alice.retryPending();
  await settle();

  assert(bobEvents.some((event) => event.type === "envelope_received" && event.deliveryId === retryID));
  assert(aliceEvents.some((event) => event.type === "pending_retried" && event.count === 1));
  assert(aliceEvents.some((event) => event.type === "peer_receipt" && event.deliveryId === retryID));
  assert.equal(alice.pendingCount, 0);
});

void test("client transport route uses validated bootstrap observations only", () => {
  const acceptedRecord = {
    wrapperPreview: "BRANCH0.abc",
    validation: "accepted",
    reason: "accepted",
    expiresAt: 1_789_000_000,
    relayEndpoint: "wss wss://branch.undoo.ru:443/relay/v0",
    profileMultihash: developmentProfileMultihash,
    senderPublicKey: fixedToken(32, 7),
    beaconId: fixedToken(32, 8),
    sequence: 1
  } satisfies GitHubDiscoveryResult["records"][number];
  const result = {
    repository: "code4bones/br_test01",
    defaultBranch: "main",
    fork: false,
    htmlUrl: "https://github.com/code4bones/br_test01",
    recordsUrl: "https://api.github.com/repos/code4bones/br_test01/contents/.branch/records.br0?ref=main",
    wrapperCount: 1,
    acceptedCount: 1,
    rejectedCount: 0,
    firstWrapperPreview: "BRANCH0.abc",
    status: "candidate",
    reason: null,
    records: [acceptedRecord]
  } satisfies GitHubDiscoveryResult;

  assert.deepEqual(routeFromDiscoveryResults([result]), {
    endpointUri: "wss://branch.undoo.ru:443/relay/v0",
    relayPublicKey: fixedToken(32, 7),
    profileMultihash: developmentProfileMultihash,
    source: "code4bones/br_test01"
  });
  assert.equal(routeFromDiscoveryResults([{ ...result, records: [{ ...acceptedRecord, validation: "rejected" }] }]), null);
});

class FakeRelay {
  readonly socketFactory = (url: string): BrowserRelaySocket => {
    const socket = new FakeRelaySocket(url, this);
    this.states.set(socket, {});
    queueMicrotask(() => {
      socket.open();
    });
    return socket;
  };

  private readonly states = new Map<FakeRelaySocket, FakeRelayState>();
  private readonly presence = new Map<string, FakeRelaySocket>();
  private readonly routes = new Map<string, { readonly left: FakeRelaySocket; readonly right: FakeRelaySocket }>();
  private sequence = 0;

  private constructor(
    readonly publicKey: string,
    private readonly privateKey: CryptoKey
  ) {}

  static async create(): Promise<FakeRelay> {
    const generated = await globalThis.crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const keyPair = asCryptoKeyPair(generated);
    const publicKey = encodeBase64URL(new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", keyPair.publicKey)));
    return new FakeRelay(publicKey, keyPair.privateKey);
  }

  async receive(socket: FakeRelaySocket, data: string): Promise<void> {
    const state = this.states.get(socket);
    if (state === undefined) {
      return;
    }
    const frame = parseRecord(data);
    switch (readString(frame, "type")) {
      case "HELLO":
        await this.challenge(socket, state, data, frame);
        return;
      case "AUTH":
        this.ready(socket, state, frame);
        return;
      case "PRESENCE":
        state.peerId = readString(frame, "peer_id");
        this.presence.set(state.peerId, socket);
        return;
      case "HEARTBEAT":
      case "LOOKUP":
        return;
      case "RENDEZVOUS":
        this.rendezvous(socket, frame);
        return;
      case "ENVELOPE":
        this.forwardEnvelope(socket, data, frame);
        return;
      default:
        return;
    }
  }

  detach(socket: FakeRelaySocket): void {
    const state = this.states.get(socket);
    if (state?.peerId !== undefined) {
      this.presence.delete(state.peerId);
    }
    for (const [routeId, route] of this.routes.entries()) {
      if (route.left === socket || route.right === socket) {
        this.routes.delete(routeId);
      }
    }
    this.states.delete(socket);
  }

  private async challenge(socket: FakeRelaySocket, state: FakeRelayState, helloRaw: string, frame: Record<string, unknown>): Promise<void> {
    const offers = frame.offers;
    if (!Array.isArray(offers) || !isRecord(offers[0])) {
      throw new Error("missing offer");
    }
    const selected = sortRecord(offers[0]);
    const clientNonce = readString(frame, "client_nonce");
    const relayNonce = fixedToken(32, this.nextSequence());
    const transcriptHash = await computeTranscriptHash(helloRaw, selected, clientNonce, relayNonce, this.publicKey);
    const relayProof = new Uint8Array(await globalThis.crypto.subtle.sign("Ed25519", this.privateKey, exactArrayBuffer(proofInput(transcriptHash))));
    state.expected = {
      clientNonce,
      relayNonce,
      transcriptHash: encodeBase64URL(transcriptHash)
    };
    socket.deliver(JSON.stringify({
      type: "CHALLENGE",
      client_nonce: clientNonce,
      relay_nonce: relayNonce,
      relay_public_key: this.publicKey,
      selected,
      transcript_hash: state.expected.transcriptHash,
      relay_proof: encodeBase64URL(relayProof)
    }));
  }

  private ready(socket: FakeRelaySocket, state: FakeRelayState, frame: Record<string, unknown>): void {
    if (
      state.expected === undefined ||
      readString(frame, "client_nonce") !== state.expected.clientNonce ||
      readString(frame, "relay_nonce") !== state.expected.relayNonce ||
      readString(frame, "transcript_hash") !== state.expected.transcriptHash
    ) {
      throw new Error("invalid auth");
    }
    state.sessionId = fixedToken(32, this.nextSequence());
    state.routeId = fixedToken(16, this.nextSequence());
    socket.deliver(JSON.stringify({
      type: "READY",
      session_id: state.sessionId,
      route_id: state.routeId,
      presence_ttl_seconds: 30,
      heartbeat_interval_seconds: 10,
      accepted_limits: {
        max_frame_bytes: 49_152,
        max_queue_depth: 32,
        max_frames_per_session: 1_048_576,
        max_bytes_per_session: 1_073_741_824
      }
    }));
  }

  private rendezvous(socket: FakeRelaySocket, frame: Record<string, unknown>): void {
    const target = this.presence.get(readString(frame, "peer_id"));
    if (target === undefined || !target.isOpen()) {
      this.error(socket, "peer_unavailable");
      return;
    }
    this.routes.set(readString(frame, "route_id"), { left: socket, right: target });
  }

  private forwardEnvelope(socket: FakeRelaySocket, data: string, frame: Record<string, unknown>): void {
    const route = this.routes.get(readString(frame, "route_id"));
    if (route === undefined) {
      this.error(socket, "peer_unavailable");
      return;
    }
    const target = route.left === socket ? route.right : route.left;
    if (!target.isOpen()) {
      this.error(socket, "peer_unavailable");
      return;
    }
    target.deliver(data);
    socket.deliver(JSON.stringify({
      type: "ACK",
      session_id: readString(frame, "session_id"),
      delivery_id: readString(frame, "delivery_id"),
      ack_type: "relay.forwarded",
      durable: false
    }));
  }

  private error(socket: FakeRelaySocket, code: string): void {
    socket.deliver(JSON.stringify({
      type: "ERROR",
      code,
      retryable: true,
      detail: "transient relay failure"
    }));
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }
}

interface FakeRelayState {
  peerId?: string;
  sessionId?: string;
  routeId?: string;
  expected?: {
    readonly clientNonce: string;
    readonly relayNonce: string;
    readonly transcriptHash: string;
  };
}

class FakeRelaySocket implements BrowserRelaySocket {
  readyState = 0;
  private readonly listeners = new Map<RelaySocketEventType, Set<(event: RelaySocketEvent) => void>>();

  constructor(
    readonly url: string,
    private readonly relay: FakeRelay
  ) {}

  send(data: string): void {
    void this.relay.receive(this, data);
  }

  close(): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.relay.detach(this);
    this.emit("close", new Event("close"));
  }

  addEventListener(type: RelaySocketEventType, listener: (event: RelaySocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: RelaySocketEvent) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: RelaySocketEventType, listener: (event: RelaySocketEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }

  isOpen(): boolean {
    return this.readyState === 1;
  }

  deliver(data: string): void {
    queueMicrotask(() => {
      if (this.readyState === 1) {
        this.emit("message", { data } as MessageEvent<string>);
      }
    });
  }

  private emit(type: RelaySocketEventType, event: RelaySocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

async function computeTranscriptHash(
  helloRaw: string,
  selected: Record<string, unknown>,
  clientNonce: string,
  relayNonce: string,
  relayPublicKey: string
): Promise<Uint8Array> {
  const chunks = [
    new TextEncoder().encode(helloRaw),
    new TextEncoder().encode(JSON.stringify(selected)),
    decodeBase64URL(clientNonce),
    decodeBase64URL(relayNonce),
    decodeBase64URL(relayPublicKey)
  ];
  const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
  const input = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input));
}

function proofInput(transcriptHash: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(relayProofDomain);
  const input = new Uint8Array(prefix.byteLength + transcriptHash.byteLength);
  input.set(prefix, 0);
  input.set(transcriptHash, prefix.byteLength);
  return input;
}

function sortRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function parseRecord(data: string): Record<string, unknown> {
  const parsed = JSON.parse(data) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("invalid fake relay frame");
  }
  return parsed;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`invalid ${key}`);
  }
  return value;
}

function fixedToken(size: number, seed: number): string {
  const bytes = new Uint8Array(size);
  bytes.fill(seed);
  return encodeBase64URL(bytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asCryptoKeyPair(value: CryptoKeyPair | CryptoKey): CryptoKeyPair {
  if ("publicKey" in value && "privateKey" in value) {
    return value;
  }
  throw new Error("ed25519 key pair generation failed");
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
