import { decodeBase64URL, encodeBase64URL } from "../protocol/v0/base64url.js";
import {
  validateBranchTextBootstrapBeacon,
  type BootstrapBeaconValidationReason
} from "../protocol/v0/bootstrap-beacon.js";
import { protocolID } from "../protocol/v0/envelope.js";
import { developmentProfileMultihash } from "../protocol/v0/profile.js";
import {
  betaHpkeCiphertextBytesForPlaintext,
  betaHpkeCiphertextBytesFromSealedPayload,
  importBetaPayloadKeyPair,
  makeBetaPayloadAAD,
  openBetaPayload,
  sealBetaPayload,
  type BetaPayloadKeyPair
} from "./payload-crypto.js";
import {
  SameRelayTransportClient,
  routeMaterialFromValidatedBootstrapBeacon,
  validateRouteMaterial,
  type BrowserRelaySocketFactory,
  type RelayRouteMaterial,
  type VerifiedRelayRouteMaterial,
  type SameRelayIdentity,
  type SameRelayIdentityExport,
  type SameRelayTransportEvent
} from "./same-relay.js";

export const betaEchoContactID = "branch.echo/0.draft" as const;
export const betaEchoRequestType = "branch.echo.request/0.draft" as const;

export interface BetaEchoContact {
  readonly id: typeof betaEchoContactID;
  readonly label: string;
  readonly peerId: string;
  readonly hpkePublicKey: string;
}

export interface BetaEchoServiceKeyExport {
  readonly sameRelayPrivateJwk: JsonWebKey;
  readonly hpkePrivateKey: string;
}

export interface BetaEchoServiceKeyMaterial {
  readonly identity: SameRelayIdentity;
  readonly payloadKey: BetaPayloadKeyPair;
}

export interface EchoTestServiceOptions {
  readonly route: VerifiedRelayRouteMaterial;
  readonly keys: BetaEchoServiceKeyMaterial;
  readonly socketFactory?: BrowserRelaySocketFactory;
  readonly crypto?: Crypto;
  readonly heartbeatIntervalMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly onEvent?: (event: EchoServiceEvent) => void;
}

export interface MultiRouteEchoTestServiceOptions {
  readonly routes: readonly VerifiedRelayRouteMaterial[];
  readonly keys: BetaEchoServiceKeyMaterial;
  readonly socketFactory?: BrowserRelaySocketFactory;
  readonly crypto?: Crypto;
  readonly heartbeatIntervalMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly onEvent?: (event: MultiRouteEchoServiceEvent) => void;
}

export interface MultiRouteEchoStartReport {
  readonly startedRoutes: readonly VerifiedRelayRouteMaterial[];
  readonly failedRoutes: readonly EchoRouteFailure[];
}

export interface EchoRouteFailure {
  readonly route: VerifiedRelayRouteMaterial;
  readonly message: string;
}

export interface EchoRouteDiscoveryInput {
  readonly wrapper: string;
  readonly source?: string;
}

export interface EchoRouteDiscoveryReport {
  readonly routes: readonly VerifiedRelayRouteMaterial[];
  readonly rejected: readonly EchoRouteDiscoveryRejection[];
}

export interface EchoRouteDiscoveryRejection {
  readonly source: string;
  readonly wrapperPreview: string;
  readonly reason: BootstrapBeaconValidationReason | "missing_route" | "invalid_route" | "duplicate_route";
}

export type EchoServiceEvent =
  | { readonly type: "started"; readonly peerId: string; readonly endpointUri: string }
  | { readonly type: "stopped"; readonly peerId: string }
  | { readonly type: "request_received"; readonly senderPeerId: string; readonly deliveryId: string }
  | { readonly type: "response_sent"; readonly recipientPeerId: string; readonly deliveryId: string }
  | { readonly type: "request_rejected"; readonly reason: string; readonly senderPeerId: string | null; readonly deliveryId: string | null }
  | { readonly type: "transport_error"; readonly message: string };

export type MultiRouteEchoServiceEvent =
  | { readonly type: "route_started"; readonly endpointUri: string; readonly peerId: string }
  | { readonly type: "route_failed"; readonly endpointUri: string; readonly message: string }
  | { readonly type: "route_event"; readonly endpointUri: string; readonly event: EchoServiceEvent };

export interface EchoRequestPayload {
  readonly type: typeof betaEchoRequestType;
  readonly replyHpkePublicKey: string;
  readonly body: string;
}

interface WireEchoRequestPayload {
  readonly type: typeof betaEchoRequestType;
  readonly reply_hpke_public_key: string;
  readonly body: string;
}

const defaultEchoHeartbeatIntervalMs = 10_000;
const defaultEchoHandshakeTimeoutMs = 10_000;
const maxEchoRouteWrappers = 64;
const maxEchoRoutes = 32;
const maxEchoBodyBytes = 3_072;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const defaultBetaEchoContact = {
  id: betaEchoContactID,
  label: "B.R.A.N.C.H. Echo",
  peerId: "UEfNJ9Ty0YZOSsIvr6zzdMrEThX7wegv2fy_epiVKYQ",
  hpkePublicKey: "Yn2kTy3rAzZGh_93cc6QR0lN1f9vEwdSkJWc_Z8OhBE"
} as const satisfies BetaEchoContact;

export async function importBetaEchoServiceKeys(
  exported: BetaEchoServiceKeyExport,
  contact: BetaEchoContact = defaultBetaEchoContact,
  crypto: Crypto = globalThis.crypto
): Promise<BetaEchoServiceKeyMaterial> {
  const identity = await SameRelayTransportClient.importIdentity({
    publicKey: contact.peerId,
    privateKeyJwk: exported.sameRelayPrivateJwk
  } satisfies SameRelayIdentityExport, crypto);
  const payloadKey = await importBetaPayloadKeyPair({
    publicKey: contact.hpkePublicKey,
    privateKey: exported.hpkePrivateKey
  });
  return { identity, payloadKey };
}

export function encodeEchoRequestPayload(payload: EchoRequestPayload): Uint8Array {
  const bodyBytes = textEncoder.encode(payload.body);
  if (bodyBytes.byteLength > maxEchoBodyBytes) {
    throw new Error("echo request body too large");
  }
  validateBase64URLKey(payload.replyHpkePublicKey, "reply HPKE public key");
  return textEncoder.encode(JSON.stringify({
    body: payload.body,
    reply_hpke_public_key: payload.replyHpkePublicKey,
    type: betaEchoRequestType
  } satisfies WireEchoRequestPayload));
}

export function decodeEchoRequestPayload(bytes: Uint8Array): EchoRequestPayload {
  let decoded: unknown;
  try {
    decoded = JSON.parse(textDecoder.decode(bytes));
  } catch {
    throw new Error("echo request rejected");
  }
  if (!isRecord(decoded) || decoded["type"] !== betaEchoRequestType || typeof decoded["reply_hpke_public_key"] !== "string" || typeof decoded["body"] !== "string") {
    throw new Error("echo request rejected");
  }
  const bodyBytes = textEncoder.encode(decoded["body"]);
  if (bodyBytes.byteLength > maxEchoBodyBytes) {
    throw new Error("echo request body too large");
  }
  validateBase64URLKey(decoded["reply_hpke_public_key"], "reply HPKE public key");
  return {
    type: betaEchoRequestType,
    replyHpkePublicKey: decoded["reply_hpke_public_key"],
    body: decoded["body"]
  };
}

export function makeEchoPayloadAAD(fields: {
  readonly route: RelayRouteMaterial;
  readonly originRouteId: string;
  readonly senderPeerId: string;
  readonly recipientPeerId: string;
  readonly deliveryId: string;
  readonly hpkeCiphertextBytes: number;
}): Uint8Array {
  return makeBetaPayloadAAD({
    protocol: protocolID,
    profileMultihash: fields.route.profileMultihash,
    originRouteId: fields.originRouteId,
    senderPeerKey: fields.senderPeerId,
    recipientPeerKey: fields.recipientPeerId,
    deliveryId: fields.deliveryId,
    pathEpoch: 0,
    streamId: 0,
    frameType: "ENVELOPE",
    ackRequested: true,
    hpkeCiphertextBytes: fields.hpkeCiphertextBytes
  });
}

export async function echoRoutesFromBootstrapBeaconWrappers(
  inputs: readonly (string | EchoRouteDiscoveryInput)[]
): Promise<EchoRouteDiscoveryReport> {
  if (inputs.length > maxEchoRouteWrappers) {
    throw new Error("too many echo route wrappers");
  }
  const routes: VerifiedRelayRouteMaterial[] = [];
  const rejected: EchoRouteDiscoveryRejection[] = [];
  const seen = new Set<string>();

  for (const [index, input] of inputs.entries()) {
    const source = typeof input === "string" ? `wrapper:${String(index)}` : input.source ?? `wrapper:${String(index)}`;
    const wrapper = typeof input === "string" ? input : input.wrapper;
    const validation = await validateBranchTextBootstrapBeacon(wrapper);
    if (!validation.accepted || validation.beacon === undefined) {
      rejected.push({ source, wrapperPreview: previewWrapper(wrapper), reason: validation.reason });
      continue;
    }

    const relayPublicKey = encodeBase64URL(validation.beacon.envelope.sender.publicKey);
    const candidates = validation.beacon.payload.relayEndpoints
      .filter((endpoint) => endpoint.transport === "wss")
      .sort((left, right) => left.priority - right.priority || left.uri.localeCompare(right.uri));
    if (candidates.length === 0) {
      rejected.push({ source, wrapperPreview: previewWrapper(wrapper), reason: "missing_route" });
      continue;
    }

    for (const endpoint of candidates) {
      const route = {
        endpointUri: endpoint.uri,
        relayPublicKey,
        profileMultihash: developmentProfileMultihash
      } satisfies RelayRouteMaterial;
      const key = routeKey(route);
      if (seen.has(key)) {
        rejected.push({ source, wrapperPreview: previewWrapper(wrapper), reason: "duplicate_route" });
        continue;
      }
      try {
        routes.push(routeMaterialFromValidatedBootstrapBeacon(route));
        seen.add(key);
      } catch {
        rejected.push({ source, wrapperPreview: previewWrapper(wrapper), reason: "invalid_route" });
      }
      if (routes.length >= maxEchoRoutes) {
        return { routes, rejected };
      }
    }
  }

  return { routes, rejected };
}

export class MultiRouteEchoTestService {
  private readonly routes: readonly VerifiedRelayRouteMaterial[];
  private readonly keys: BetaEchoServiceKeyMaterial;
  private readonly socketFactory: BrowserRelaySocketFactory | undefined;
  private readonly crypto: Crypto | undefined;
  private readonly heartbeatIntervalMs: number | undefined;
  private readonly handshakeTimeoutMs: number | undefined;
  private readonly onEvent: ((event: MultiRouteEchoServiceEvent) => void) | undefined;
  private readonly services = new Map<string, EchoTestService>();

  constructor(options: MultiRouteEchoTestServiceOptions) {
    this.routes = validateRoutes(options.routes);
    this.keys = options.keys;
    this.socketFactory = options.socketFactory;
    this.crypto = options.crypto;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs;
    this.onEvent = options.onEvent;
  }

  get activeRouteCount(): number {
    return this.services.size;
  }

  async start(): Promise<MultiRouteEchoStartReport> {
    this.stop();
    const results = await Promise.all(this.routes.map((route) => this.startRoute(route)));
    const startedRoutes = results.flatMap((result) => result.started === null ? [] : [result.started]);
    const failedRoutes = results.flatMap((result) => result.failed === null ? [] : [result.failed]);
    return { startedRoutes, failedRoutes };
  }

  stop(): void {
    for (const service of this.services.values()) {
      service.stop();
    }
    this.services.clear();
  }

  private emit(event: MultiRouteEchoServiceEvent): void {
    this.onEvent?.(event);
  }

  private async startRoute(route: VerifiedRelayRouteMaterial): Promise<{
    readonly started: VerifiedRelayRouteMaterial | null;
    readonly failed: EchoRouteFailure | null;
  }> {
    const service = new EchoTestService({
      route,
      keys: this.keys,
      ...(this.socketFactory === undefined ? {} : { socketFactory: this.socketFactory }),
      ...(this.crypto === undefined ? {} : { crypto: this.crypto }),
      ...(this.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: this.heartbeatIntervalMs }),
      ...(this.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: this.handshakeTimeoutMs }),
      onEvent: (event) => {
        this.emit({ type: "route_event", endpointUri: route.endpointUri, event });
      }
    });
    try {
      await service.start();
      this.services.set(routeKey(route), service);
      this.emit({ type: "route_started", endpointUri: route.endpointUri, peerId: this.keys.identity.peerId });
      return { started: route, failed: null };
    } catch (error) {
      service.stop();
      const message = errorMessage(error);
      const failed = { route, message } satisfies EchoRouteFailure;
      this.emit({ type: "route_failed", endpointUri: route.endpointUri, message });
      return { started: null, failed };
    }
  }
}

export class EchoTestService {
  private readonly route: VerifiedRelayRouteMaterial;
  private readonly keys: BetaEchoServiceKeyMaterial;
  private readonly socketFactory: BrowserRelaySocketFactory | undefined;
  private readonly crypto: Crypto | undefined;
  private readonly heartbeatIntervalMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly onEvent: ((event: EchoServiceEvent) => void) | undefined;
  private client: SameRelayTransportClient | null = null;
  private unsubscribe: (() => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: EchoTestServiceOptions) {
    this.route = options.route;
    this.keys = options.keys;
    this.socketFactory = options.socketFactory;
    this.crypto = options.crypto;
    this.heartbeatIntervalMs = boundedHeartbeatInterval(options.heartbeatIntervalMs ?? defaultEchoHeartbeatIntervalMs);
    this.handshakeTimeoutMs = boundedHandshakeTimeout(options.handshakeTimeoutMs ?? defaultEchoHandshakeTimeoutMs);
    this.onEvent = options.onEvent;
  }

  async start(): Promise<void> {
    this.stop();
    const client = new SameRelayTransportClient({
      route: this.route,
      identity: this.keys.identity,
      ...(this.socketFactory === undefined ? {} : { socketFactory: this.socketFactory }),
      ...(this.crypto === undefined ? {} : { crypto: this.crypto }),
      handshakeTimeoutMs: this.handshakeTimeoutMs
    });
    this.client = client;
    this.unsubscribe = client.addEventListener((event) => {
      this.handleTransportEvent(event);
    });
    await client.attach();
    client.announcePresence();
    client.heartbeat();
    this.heartbeatTimer = setInterval(() => {
      try {
        client.heartbeat();
      } catch (error) {
        this.emit({ type: "transport_error", message: errorMessage(error) });
      }
    }, this.heartbeatIntervalMs);
    this.emit({ type: "started", peerId: this.keys.identity.peerId, endpointUri: this.route.endpointUri });
  }

  stop(): void {
    const wasRunning = this.client !== null || this.heartbeatTimer !== null || this.unsubscribe !== null;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    const client = this.client;
    this.client = null;
    client?.disconnect();
    if (wasRunning) {
      this.emit({ type: "stopped", peerId: this.keys.identity.peerId });
    }
  }

  private handleTransportEvent(event: SameRelayTransportEvent): void {
    if (event.type === "envelope_received") {
      void this.replyTo(event).catch((error: unknown) => {
        this.emit({
          type: "request_rejected",
          reason: errorMessage(error),
          senderPeerId: event.senderPeerId,
          deliveryId: event.deliveryId
        });
      });
      return;
    }
    if (event.type === "error") {
      this.emit({ type: "transport_error", message: event.message });
    }
  }

  private async replyTo(event: Extract<SameRelayTransportEvent, { readonly type: "envelope_received" }>): Promise<void> {
    const client = this.client;
    if (client === null) {
      throw new Error("echo service is not running");
    }
    if (event.senderPeerId === null) {
      throw new Error("echo request missing sender attribution");
    }
    this.emit({ type: "request_received", senderPeerId: event.senderPeerId, deliveryId: event.deliveryId });
    const plaintext = await openBetaPayload({
      recipientPrivateKey: this.keys.payloadKey.privateKey,
      sealedPayload: event.ciphertext,
      aad: makeEchoPayloadAAD({
        route: this.route,
        originRouteId: event.originRouteId,
        senderPeerId: event.senderPeerId,
        recipientPeerId: this.keys.identity.peerId,
        deliveryId: event.deliveryId,
        hpkeCiphertextBytes: betaHpkeCiphertextBytesFromSealedPayload(event.ciphertext)
      }),
      expectedCiphertextBytes: betaHpkeCiphertextBytesFromSealedPayload(event.ciphertext)
    });
    const request = decodeEchoRequestPayload(plaintext);
    const responseDeliveryId = randomToken(16);
    const responseOriginRouteId = client.routeId;
    if (responseOriginRouteId === null) {
      throw new Error("echo relay session is not attached");
    }
    const responseCiphertextBytes = betaHpkeCiphertextBytesForPlaintext(plaintext);
    const sealed = await sealBetaPayload({
      recipientPublicKey: request.replyHpkePublicKey,
      plaintext,
      aad: makeEchoPayloadAAD({
        route: this.route,
        originRouteId: responseOriginRouteId,
        senderPeerId: this.keys.identity.peerId,
        recipientPeerId: event.senderPeerId,
        deliveryId: responseDeliveryId,
        hpkeCiphertextBytes: responseCiphertextBytes
      }),
      expectedCiphertextBytes: responseCiphertextBytes
    });
    // RENDEZVOUS includes the local liveness lookup. Do not repeat the
    // carrier pass for the transient reply route.
    client.rendezvous(event.senderPeerId);
    client.sendSealedEnvelope(sealed, { deliveryId: responseDeliveryId, originRouteId: responseOriginRouteId });
    this.emit({ type: "response_sent", recipientPeerId: event.senderPeerId, deliveryId: responseDeliveryId });
  }

  private emit(event: EchoServiceEvent): void {
    this.onEvent?.(event);
  }
}

function boundedHeartbeatInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return defaultEchoHeartbeatIntervalMs;
  }
  return Math.max(1_000, Math.min(60_000, Math.trunc(value)));
}

function boundedHandshakeTimeout(value: number): number {
  if (!Number.isFinite(value)) {
    return defaultEchoHandshakeTimeoutMs;
  }
  return Math.max(1_000, Math.min(30_000, Math.trunc(value)));
}

function validateBase64URLKey(value: string, name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`invalid ${name}`);
  }
  if (decodeBase64URL(value).byteLength !== 32) {
    throw new Error(`invalid ${name}`);
  }
}

function randomToken(size: number): string {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return encodeBase64URL(bytes);
}

function validateRoutes(routes: readonly VerifiedRelayRouteMaterial[]): readonly VerifiedRelayRouteMaterial[] {
  if (routes.length === 0) {
    throw new Error("at least one echo route is required");
  }
  if (routes.length > maxEchoRoutes) {
    throw new Error("too many echo routes");
  }
  const seen = new Set<string>();
  const validated: VerifiedRelayRouteMaterial[] = [];
  for (const route of routes) {
    validateRouteMaterial(route);
    const key = routeKey(route);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    validated.push(route);
  }
  return validated;
}

function routeKey(route: RelayRouteMaterial): string {
  return `${route.endpointUri}\0${route.relayPublicKey}\0${route.profileMultihash}`;
}

function previewWrapper(wrapper: string): string {
  return wrapper.length <= 28 ? wrapper : `${wrapper.slice(0, 22)}...${wrapper.slice(-6)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "echo service failed";
}
