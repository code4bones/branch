import { decodeBase64URL, encodeBase64URL } from "../protocol/v0/base64url.js";
import { protocolID } from "../protocol/v0/envelope.js";
import { developmentProfileMultihash } from "../protocol/v0/profile.js";
import {
  decodeDraftRelayAttachmentFrameText,
  maxDraftRelayAttachmentFrameBytes,
  relayProofDomain,
  type RelayFrameType
} from "../protocol/v0/relay-attachment.js";

export const relayForwardLiveCapability = "relay.forward.live/0" as const;

export interface RelayRouteMaterial {
  readonly endpointUri: string;
  readonly relayPublicKey: string;
  readonly profileMultihash: string;
}

export interface RelayRouteHint {
  readonly transport: "wss" | "ws";
  readonly uri: string;
  readonly relayPublicKey: string;
  readonly priority: number;
}

export interface SameRelayIdentity {
  readonly peerId: string;
  readonly publicKey: string;
  readonly privateKey: CryptoKey;
}

export interface SameRelayIdentityExport {
  readonly publicKey: string;
  readonly privateKeyJwk: JsonWebKey;
}

export type RelaySocketEventType = "open" | "message" | "error" | "close";
export interface RelaySocketCloseEvent extends Event {
  readonly code?: number;
}

export type RelaySocketEvent = Event | MessageEvent<unknown> | RelaySocketCloseEvent;

export interface BrowserRelaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: RelaySocketEventType, listener: (event: RelaySocketEvent) => void): void;
  removeEventListener(type: RelaySocketEventType, listener: (event: RelaySocketEvent) => void): void;
}

export type BrowserRelaySocketFactory = (url: string) => BrowserRelaySocket;

export interface SameRelayTransportOptions {
  readonly route: RelayRouteMaterial;
  readonly identity: SameRelayIdentity;
  readonly pendingEnvelopes?: readonly SameRelayPendingEnvelope[];
  readonly socketFactory?: BrowserRelaySocketFactory;
  readonly crypto?: Crypto;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly maxFrameBytes?: number;
  /** Local volatile client ceiling; this is never relay storage. */
  readonly maxPendingEnvelopes?: number;
  readonly handshakeTimeoutMs?: number;
}

export type SameRelayTransportEvent =
  | { readonly type: "attached"; readonly sessionId: string; readonly routeId: string; readonly endpointUri: string }
  // A bounded protocol label only: no raw frame, route, session, delivery ID,
  // ciphertext, or peer material crosses into diagnostics.
  | { readonly type: "frame_sent"; readonly frameType: RelayFrameType }
  | { readonly type: "presence_announced"; readonly peerId: string; readonly sequence: number }
  | { readonly type: "heartbeat_sent"; readonly sequence: number }
  | { readonly type: "lookup_requested"; readonly peerId: string; readonly sequence: number }
  | { readonly type: "rendezvous_ready"; readonly peerId: string; readonly routeId: string; readonly sequence: number; readonly routeHintCount: number }
  | { readonly type: "envelope_sent"; readonly deliveryId: string; readonly routeId: string; readonly originRouteId: string }
  | { readonly type: "relay_ack"; readonly deliveryId: string; readonly ackType: "relay.accepted" | "relay.forwarded"; readonly durable: false }
  | { readonly type: "peer_receipt"; readonly deliveryId: string; readonly durable: false }
  | { readonly type: "peer_unavailable"; readonly retryable: boolean; readonly pendingCount: number }
  | { readonly type: "envelope_received"; readonly deliveryId: string; readonly ciphertext: string; readonly routeId: string; readonly originRouteId: string; readonly senderPeerId: string | null }
  | { readonly type: "pending_retried"; readonly count: number }
  | {
    readonly type: "disconnected";
    readonly pendingCount: number;
    readonly source: "local" | "remote";
    readonly closeCode?: number;
  }
  | { readonly type: "error"; readonly message: string };

type SameRelayEventListener = (event: SameRelayTransportEvent) => void;

interface VersionOffer {
  readonly wire_version: 0;
  readonly protocol: typeof protocolID;
  readonly profile_multihash: typeof developmentProfileMultihash;
  readonly capabilities: readonly [typeof relayForwardLiveCapability];
  readonly required_capabilities: readonly [];
  readonly extensions: readonly [];
  readonly required_extensions: readonly [];
}

interface ReadyState {
  readonly sessionId: string;
  readonly routeId: string;
  readonly presenceTtlSeconds: number;
  readonly heartbeatIntervalSeconds: number;
}

interface PendingEnvelope {
  readonly deliveryId: string;
  readonly ciphertext: string;
  readonly originRouteId: string;
  readonly streamId: number;
  readonly ackRequested: boolean;
}

export interface SameRelayPendingEnvelope {
  readonly deliveryId: string;
  readonly ciphertext: string;
  readonly originRouteId: string;
  readonly streamId: number;
  readonly ackRequested: boolean;
}

interface DeferredFrame {
  resolve(record: Record<string, unknown>): void;
  reject(error: Error): void;
}

const socketOpenState = 1;
const defaultMaxFrameBytes = 49_152;
const defaultMaxPendingEnvelopes = 32;
const defaultHandshakeTimeoutMs = 10_000;
const defaultPresenceTTLSeconds = 30;
const maxChallengeClockSkewSeconds = 30;
const defaultStreamID = 0;
const defaultPathEpoch = 0;

export class SameRelayTransportClient {
  private readonly route: RelayRouteMaterial;
  private readonly identity: SameRelayIdentity;
  private readonly socketFactory: BrowserRelaySocketFactory;
  private readonly cryptoProvider: Crypto;
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly maxFrameBytes: number;
  private readonly maxPendingEnvelopes: number;
  private readonly handshakeTimeoutMs: number;
  private readonly listeners = new Set<SameRelayEventListener>();
  private readonly pending = new Map<string, PendingEnvelope>();
  private readonly deferred: DeferredFrame[] = [];
  private socket: BrowserRelaySocket | null = null;
  private ready: ReadyState | null = null;
  private sequence = 0;

  constructor(options: SameRelayTransportOptions) {
    this.route = validateRouteMaterial(options.route);
    this.identity = options.identity;
    this.cryptoProvider = options.crypto ?? globalThis.crypto;
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.randomBytes = options.randomBytes ?? ((size) => {
      const bytes = new Uint8Array(size);
      this.cryptoProvider.getRandomValues(bytes);
      return bytes;
    });
    this.maxFrameBytes = Math.min(options.maxFrameBytes ?? defaultMaxFrameBytes, defaultMaxFrameBytes);
    this.maxPendingEnvelopes = boundedPendingEnvelopeLimit(options.maxPendingEnvelopes ?? defaultMaxPendingEnvelopes);
    this.handshakeTimeoutMs = Math.min(Math.max(options.handshakeTimeoutMs ?? defaultHandshakeTimeoutMs, 1), 30_000);
    for (const pending of options.pendingEnvelopes ?? []) {
      if (!this.pending.has(pending.deliveryId) && this.pending.size >= this.maxPendingEnvelopes) {
        throw new Error("live pending envelope limit exceeded");
      }
      this.pending.set(pending.deliveryId, { ...pending });
    }
  }

  static async createIdentity(cryptoProvider: Crypto = globalThis.crypto): Promise<SameRelayIdentity> {
    const generated = await cryptoProvider.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const keyPair = asCryptoKeyPair(generated);
    const publicKeyBytes = new Uint8Array(await cryptoProvider.subtle.exportKey("raw", keyPair.publicKey));
    return {
      peerId: encodeBase64URL(publicKeyBytes),
      publicKey: encodeBase64URL(publicKeyBytes),
      privateKey: keyPair.privateKey
    };
  }

  static async importIdentity(exported: SameRelayIdentityExport, cryptoProvider: Crypto = globalThis.crypto): Promise<SameRelayIdentity> {
    const publicKeyBytes = decodeBase64URL(exported.publicKey);
    if (publicKeyBytes.byteLength !== 32) {
      throw new Error("invalid same-relay identity public key");
    }
    const privateKeyJwk = { ...exported.privateKeyJwk };
    if (privateKeyJwk.kty !== "OKP" || privateKeyJwk.crv !== "Ed25519" || privateKeyJwk.x !== exported.publicKey) {
      throw new Error("invalid same-relay identity private key");
    }
    const privateKey = await cryptoProvider.subtle.importKey(
      "jwk",
      privateKeyJwk,
      "Ed25519",
      false,
      ["sign"]
    );
    return {
      peerId: exported.publicKey,
      publicKey: exported.publicKey,
      privateKey
    };
  }

  get peerId(): string {
    return this.identity.peerId;
  }

  get sessionId(): string | null {
    return this.ready?.sessionId ?? null;
  }

  get routeId(): string | null {
    return this.ready?.routeId ?? null;
  }

  // Relay-negotiated cadence, exposed so adapters do not guess a heartbeat
  // interval that could outlive the presence TTL selected by this relay.
  get heartbeatIntervalSeconds(): number | null {
    return this.ready?.heartbeatIntervalSeconds ?? null;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  exportPendingEnvelopes(): readonly SameRelayPendingEnvelope[] {
    return Array.from(this.pending.values(), (pending) => ({ ...pending }));
  }

  addEventListener(listener: SameRelayEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async attach(): Promise<void> {
    this.disconnect();
    const socket = this.socketFactory(this.route.endpointUri);
    this.socket = socket;
    socket.addEventListener("message", this.handleSocketMessage);
    socket.addEventListener("close", this.handleSocketClose);
    socket.addEventListener("error", this.handleSocketError);
    await this.waitForOpen(socket);

    const clientNonce = this.randomToken(32);
    const offer = makeVersionOffer();
    const hello = {
      type: "HELLO",
      client_nonce: clientNonce,
      client_time: this.now(),
      requested_role: relayForwardLiveCapability,
      max_frame_bytes: this.maxFrameBytes,
      offers: [offer]
    };
    const helloRaw = encodeFrame(hello);
    this.sendRaw(helloRaw);

    const challenge = await this.readNextFrame();
    assertFrameType(challenge, "CHALLENGE");
    const issuedAt = readNumber(challenge, "issued_at");
    const expiresAt = readNumber(challenge, "expires_at");
    const currentTime = this.now();
    if (expiresAt <= currentTime) {
      throw new Error("relay challenge expired");
    }
    if (issuedAt > currentTime + maxChallengeClockSkewSeconds) {
      throw new Error("relay challenge issued in the future");
    }
    const selected = readObject(challenge, "selected");
    const transcriptHash = await this.computeTranscriptHash(
      helloRaw,
      selected,
      clientNonce,
      readString(challenge, "relay_nonce"),
      this.route.relayPublicKey
    );
    if (readString(challenge, "client_nonce") !== clientNonce) {
      throw new Error("relay challenge nonce mismatch");
    }
    if (readString(challenge, "relay_public_key") !== this.route.relayPublicKey) {
      throw new Error("relay identity mismatch");
    }
    if (readString(challenge, "transcript_hash") !== encodeBase64URL(transcriptHash)) {
      throw new Error("relay transcript hash mismatch");
    }
    if (!await this.verifyRelayProof(readString(challenge, "relay_proof"), transcriptHash)) {
      throw new Error("relay proof invalid");
    }

    const proof = await this.signProof(transcriptHash);
    this.sendRaw(encodeFrame({
      type: "AUTH",
      client_public_key: this.identity.publicKey,
      client_nonce: clientNonce,
      relay_nonce: readString(challenge, "relay_nonce"),
      transcript_hash: encodeBase64URL(transcriptHash),
      client_proof: encodeBase64URL(proof)
    }));

    const ready = await this.readNextFrame();
    assertFrameType(ready, "READY");
    this.ready = {
      sessionId: readString(ready, "session_id"),
      routeId: readString(ready, "route_id"),
      presenceTtlSeconds: readNumber(ready, "presence_ttl_seconds"),
      heartbeatIntervalSeconds: readNumber(ready, "heartbeat_interval_seconds")
    };
    this.emit({
      type: "attached",
      sessionId: this.ready.sessionId,
      routeId: this.ready.routeId,
      endpointUri: this.route.endpointUri
    });
  }

  announcePresence(ttlSeconds = defaultPresenceTTLSeconds): void {
    const sequence = this.nextSequence();
    this.sendReadyFrame({
      type: "PRESENCE",
      session_id: this.requireReady().sessionId,
      route_id: this.requireReady().routeId,
      peer_id: this.identity.peerId,
      sequence,
      ttl_seconds: ttlSeconds,
      sent_at: this.now()
    });
    this.emit({ type: "presence_announced", peerId: this.identity.peerId, sequence });
  }

  heartbeat(): void {
    const sequence = this.nextSequence();
    this.sendReadyFrame({
      type: "HEARTBEAT",
      session_id: this.requireReady().sessionId,
      sequence,
      sent_at: this.now()
    });
    this.emit({ type: "heartbeat_sent", sequence });
  }

  lookup(peerId: string): void {
    const sequence = this.nextSequence();
    this.sendReadyFrame({
      type: "LOOKUP",
      session_id: this.requireReady().sessionId,
      peer_id: peerId,
      sequence
    });
    this.emit({ type: "lookup_requested", peerId, sequence });
  }

  // A same-route/same-peer repeat is intentionally idempotent at the relay.
  // Adapters call this immediately before a live ENVELOPE so a peer that
  // refreshed its WebSocket can be rebound without retaining any route state.
  rendezvous(peerId: string, options: { readonly routeHints?: readonly RelayRouteHint[] } = {}): void {
    const ready = this.requireReady();
    const sequence = this.nextSequence();
    const routeHints = validateRouteHints(options.routeHints ?? []);
    this.sendReadyFrame({
      type: "RENDEZVOUS",
      session_id: ready.sessionId,
      route_id: ready.routeId,
      peer_id: peerId,
      sequence,
      ...(routeHints.length > 0 ? { route_hints: routeHints.map(toWireRouteHint) } : {})
    });
    this.emit({ type: "rendezvous_ready", peerId, routeId: ready.routeId, sequence, routeHintCount: routeHints.length });
  }

  sendEnvelope(ciphertext: string, options: { readonly deliveryId?: string; readonly originRouteId?: string; readonly ackRequested?: boolean } = {}): string {
    return this.sendSealedEnvelope(encodeBase64URL(new TextEncoder().encode(ciphertext)), options);
  }

  sendSealedEnvelope(sealedPayload: string, options: { readonly deliveryId?: string; readonly originRouteId?: string; readonly ackRequested?: boolean } = {}): string {
    decodeBase64URL(sealedPayload);
    const originRouteId = options.originRouteId ?? this.requireReady().routeId;
    if (decodeBase64URL(originRouteId).byteLength !== 16) {
      throw new Error("invalid origin route id");
    }
    const deliveryId = options.deliveryId ?? this.randomToken(16);
    const pending = {
      deliveryId,
      ciphertext: sealedPayload,
      originRouteId,
      streamId: defaultStreamID,
      ackRequested: options.ackRequested ?? true
    } satisfies PendingEnvelope;
    if (!this.pending.has(deliveryId) && this.pending.size >= this.maxPendingEnvelopes) {
      throw new Error("live pending envelope limit exceeded");
    }
    this.pending.set(deliveryId, pending);
    this.sendPendingEnvelope(pending);
    return deliveryId;
  }

  markPeerReceipt(deliveryId: string): void {
    if (this.pending.delete(deliveryId)) {
      this.emit({ type: "peer_receipt", deliveryId, durable: false });
    }
  }

  retryPending(): void {
    for (const pending of this.pending.values()) {
      this.sendPendingEnvelope(pending);
    }
    this.emit({ type: "pending_retried", count: this.pending.size });
  }

  async reconnect(): Promise<void> {
    await this.attach();
    this.retryPending();
  }

  disconnect(): void {
    const socket = this.socket;
    this.ready = null;
    this.socket = null;
    this.rejectDeferredFrames(new Error("relay socket closed"));
    if (socket !== null) {
      socket.removeEventListener("message", this.handleSocketMessage);
      socket.removeEventListener("close", this.handleSocketClose);
      socket.removeEventListener("error", this.handleSocketError);
      socket.close(1000, "client disconnect");
      this.emit({ type: "disconnected", pendingCount: this.pending.size, source: "local" });
    }
  }

  private sendPendingEnvelope(pending: PendingEnvelope): void {
    const ready = this.requireReady();
    this.sendReadyFrame({
      type: "ENVELOPE",
      session_id: ready.sessionId,
      route_id: ready.routeId,
      origin_route_id: pending.originRouteId,
      path_epoch: defaultPathEpoch,
      stream_id: pending.streamId,
      delivery_id: pending.deliveryId,
      ciphertext: pending.ciphertext,
      ack_requested: pending.ackRequested
    });
    this.emit({ type: "envelope_sent", deliveryId: pending.deliveryId, routeId: ready.routeId, originRouteId: pending.originRouteId });
  }

  private readonly handleSocketMessage = (event: RelaySocketEvent): void => {
    const data = readSocketMessageData(event);
    if (data === null) {
      this.emit({ type: "error", message: "relay sent non-text frame" });
      return;
    }
    const byteLength = new TextEncoder().encode(data).byteLength;
    if (byteLength > maxDraftRelayAttachmentFrameBytes) {
      this.emit({ type: "error", message: "relay frame too large" });
      return;
    }
    let record: Record<string, unknown>;
    try {
      record = decodeRelayRecord(data);
    } catch (error) {
      this.emit({ type: "error", message: errorMessage(error) });
      return;
    }
    const deferred = this.deferred.shift();
    if (deferred !== undefined) {
      deferred.resolve(record);
      return;
    }
    this.processReadyFrame(record);
  };

  private readonly handleSocketClose = (event: RelaySocketEvent): void => {
    this.ready = null;
    this.socket = null;
    this.rejectDeferredFrames(new Error("relay socket closed"));
    const details = closeDetails(event);
    this.emit({ type: "disconnected", pendingCount: this.pending.size, source: "remote", ...details });
  };

  private readonly handleSocketError = (): void => {
    this.emit({ type: "error", message: "relay socket error" });
  };

  private processReadyFrame(record: Record<string, unknown>): void {
    const type = readString(record, "type");
    switch (type) {
      case "ACK": {
        const ackType = readString(record, "ack_type");
        const deliveryId = readString(record, "delivery_id");
        if (ackType === "peer.received") {
          this.pending.delete(deliveryId);
          this.emit({ type: "peer_receipt", deliveryId, durable: false });
          return;
        }
        if (ackType === "relay.forwarded") {
          // Forwarded completes the relay's only live opaque-transit duty. It
          // is not a peer receipt, integrity result, or durable promise.
          this.pending.delete(deliveryId);
          this.emit({ type: "relay_ack", deliveryId, ackType, durable: false });
          return;
        }
        if (ackType === "relay.accepted") {
          this.emit({ type: "relay_ack", deliveryId, ackType, durable: false });
        }
        return;
      }
      case "ENVELOPE": {
        const deliveryId = readString(record, "delivery_id");
        this.emit({
          type: "envelope_received",
          deliveryId,
          ciphertext: readString(record, "ciphertext"),
          routeId: readString(record, "route_id"),
          originRouteId: readString(record, "origin_route_id"),
          senderPeerId: readOptionalString(record, "sender_peer_id")
        });
        return;
      }
      case "ERROR": {
        const code = readString(record, "code");
        if (code === "peer_unavailable" || code === "route_unavailable") {
          this.emit({ type: "peer_unavailable", retryable: readBoolean(record, "retryable"), pendingCount: this.pending.size });
          return;
        }
        this.emit({ type: "error", message: code });
        return;
      }
      default:
        return;
    }
  }

  private async readNextFrame(): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.deferred.indexOf(waiter);
        if (index >= 0) {
          this.deferred.splice(index, 1);
        }
        reject(new Error("relay handshake timeout"));
      }, this.handshakeTimeoutMs);
      const waiter = {
        resolve: (record: Record<string, unknown>): void => {
          clearTimeout(timer);
          resolve(record);
        },
        reject: (error: Error): void => {
          clearTimeout(timer);
          reject(error);
        }
      } satisfies DeferredFrame;
      this.deferred.push(waiter);
    });
  }

  private async waitForOpen(socket: BrowserRelaySocket): Promise<void> {
    if (socket.readyState === socketOpenState) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("relay open timeout"));
      }, this.handshakeTimeoutMs);
      const open = (): void => {
        cleanup();
        resolve();
      };
      const fail = (): void => {
        cleanup();
        reject(new Error("relay socket failed before open"));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeEventListener("open", open);
        socket.removeEventListener("error", fail);
        socket.removeEventListener("close", fail);
      };
      socket.addEventListener("open", open);
      socket.addEventListener("error", fail);
      socket.addEventListener("close", fail);
    });
  }

  private rejectDeferredFrames(error: Error): void {
    for (const waiter of this.deferred.splice(0)) {
      waiter.reject(error);
    }
  }

  private sendReadyFrame(frame: Record<string, unknown>): void {
    this.requireReady();
    this.sendRaw(encodeFrame(frame));
  }

  private sendRaw(frame: string): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== socketOpenState) {
      throw new Error("relay socket is not open");
    }
    // Validate outbound frames with the normative decoder before writing them
    // to a relay, so adapter regressions fail locally and deterministically.
    const decoded = decodeDraftRelayAttachmentFrameText(frame);
    socket.send(frame);
    this.emit({ type: "frame_sent", frameType: decoded.type });
  }

  private requireReady(): ReadyState {
    if (this.ready === null) {
      throw new Error("relay session is not ready");
    }
    return this.ready;
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private randomToken(size: number): string {
    return encodeBase64URL(this.randomBytes(size));
  }

  private async computeTranscriptHash(
    helloRaw: string,
    selected: Record<string, unknown>,
    clientNonce: string,
    relayNonce: string,
    relayPublicKey: string
  ): Promise<Uint8Array> {
    const selectedRaw = JSON.stringify(selected);
    const chunks = [
      new TextEncoder().encode(helloRaw),
      new TextEncoder().encode(selectedRaw),
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
    return new Uint8Array(await this.cryptoProvider.subtle.digest("SHA-256", input));
  }

  private async verifyRelayProof(proof: string, transcriptHash: Uint8Array): Promise<boolean> {
    const publicKey = await this.cryptoProvider.subtle.importKey(
      "raw",
      exactArrayBuffer(decodeBase64URL(this.route.relayPublicKey)),
      "Ed25519",
      false,
      ["verify"]
    );
    return this.cryptoProvider.subtle.verify("Ed25519", publicKey, exactArrayBuffer(decodeBase64URL(proof)), exactArrayBuffer(proofInput(transcriptHash)));
  }

  private async signProof(transcriptHash: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await this.cryptoProvider.subtle.sign("Ed25519", this.identity.privateKey, exactArrayBuffer(proofInput(transcriptHash))));
  }

  private emit(event: SameRelayTransportEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function closeDetails(event: RelaySocketEvent): { readonly closeCode?: number } {
  if (!("code" in event) || typeof event.code !== "number") {
    return {};
  }
  return { closeCode: event.code };
}

export function makeVersionOffer(): VersionOffer {
  return {
    wire_version: 0,
    protocol: protocolID,
    profile_multihash: developmentProfileMultihash,
    capabilities: [relayForwardLiveCapability],
    required_capabilities: [],
    extensions: [],
    required_extensions: []
  };
}

export function parseRelayEndpointDescriptor(value: string | null): { readonly transport: "wss"; readonly uri: string } | null {
  if (value === null) {
    return null;
  }
  const [transport, uri] = value.split(" ");
  if (transport !== "wss" || uri === undefined || uri.trim() === "") {
    return null;
  }
  return { transport, uri };
}

function boundedPendingEnvelopeLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > defaultMaxPendingEnvelopes) {
    throw new Error("invalid live pending envelope limit");
  }
  return value;
}

export function validateRouteMaterial(route: RelayRouteMaterial): RelayRouteMaterial {
  if (route.profileMultihash !== developmentProfileMultihash) {
    throw new Error("unsupported relay profile");
  }
  if (decodeBase64URL(route.relayPublicKey).byteLength !== 32) {
    throw new Error("invalid relay public key");
  }
  const endpoint = new URL(route.endpointUri);
  if (endpoint.protocol !== "wss:" || endpoint.username !== "" || endpoint.password !== "" || endpoint.hash !== "") {
    throw new Error("invalid relay endpoint");
  }
  return route;
}

function validateRouteHints(hints: readonly RelayRouteHint[]): readonly RelayRouteHint[] {
  if (hints.length > 8) {
    throw new Error("too many route hints");
  }
  const seen = new Set<string>();
  return hints.map((hint) => {
    if (hint.transport !== "wss" && hint.transport !== "ws") {
      throw new Error("invalid route hint transport");
    }
    const relayPublicKey = decodeBase64URL(hint.relayPublicKey);
    if (relayPublicKey.byteLength !== 32) {
      throw new Error("invalid route hint relay key");
    }
    if (!Number.isSafeInteger(hint.priority) || hint.priority < 0) {
      throw new Error("invalid route hint priority");
    }
    const endpoint = new URL(hint.uri);
    if (
      endpoint.protocol !== `${hint.transport}:` ||
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      endpoint.hash !== "" ||
      endpoint.pathname !== "/relay/v0"
    ) {
      throw new Error("invalid route hint endpoint");
    }
    const key = `${hint.transport}\0${hint.uri}`;
    if (seen.has(key)) {
      throw new Error("duplicate route hint");
    }
    seen.add(key);
    return hint;
  }).sort((left, right) => left.priority - right.priority || left.uri.localeCompare(right.uri));
}

function toWireRouteHint(hint: RelayRouteHint): Record<string, unknown> {
  return {
    transport: hint.transport,
    uri: hint.uri,
    relay_public_key: hint.relayPublicKey,
    priority: hint.priority
  };
}

function encodeFrame(frame: Record<string, unknown>): string {
  return JSON.stringify(frame);
}

function decodeRelayRecord(text: string): Record<string, unknown> {
  decodeDraftRelayAttachmentFrameText(text);
  const decoded = JSON.parse(text) as unknown;
  if (!isRecord(decoded)) {
    throw new Error("invalid relay frame");
  }
  return decoded;
}

function proofInput(transcriptHash: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(relayProofDomain);
  const input = new Uint8Array(prefix.byteLength + transcriptHash.byteLength);
  input.set(prefix, 0);
  input.set(transcriptHash, prefix.byteLength);
  return input;
}

function readSocketMessageData(event: RelaySocketEvent): string | null {
  if (!("data" in event)) {
    return null;
  }
  const data = event.data;
  return typeof data === "string" ? data : null;
}

function assertFrameType(record: Record<string, unknown>, expected: string): void {
  if (readString(record, "type") !== expected) {
    throw new Error(`expected ${expected}`);
  }
}

function readObject(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`invalid ${key}`);
  }
  return value;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`invalid ${key}`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`invalid ${key}`);
  }
  return value;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`invalid ${key}`);
  }
  return value;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`invalid ${key}`);
  }
  return value;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "relay frame failed";
}
