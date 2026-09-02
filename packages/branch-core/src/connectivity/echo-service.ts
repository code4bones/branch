import { decodeBase64URL, encodeBase64URL } from "../protocol/v0/base64url.js";
import { protocolID } from "../protocol/v0/envelope.js";
import {
  importBetaPayloadKeyPair,
  makeBetaPayloadAAD,
  openBetaPayload,
  sealBetaPayload,
  type BetaPayloadKeyPair
} from "./payload-crypto.js";
import {
  SameRelayTransportClient,
  type BrowserRelaySocketFactory,
  type RelayRouteMaterial,
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
  readonly route: RelayRouteMaterial;
  readonly keys: BetaEchoServiceKeyMaterial;
  readonly socketFactory?: BrowserRelaySocketFactory;
  readonly crypto?: Crypto;
  readonly heartbeatIntervalMs?: number;
  readonly onEvent?: (event: EchoServiceEvent) => void;
}

export type EchoServiceEvent =
  | { readonly type: "started"; readonly peerId: string; readonly endpointUri: string }
  | { readonly type: "stopped"; readonly peerId: string }
  | { readonly type: "request_received"; readonly senderPeerId: string; readonly deliveryId: string }
  | { readonly type: "response_sent"; readonly recipientPeerId: string; readonly deliveryId: string }
  | { readonly type: "request_rejected"; readonly reason: string; readonly senderPeerId: string | null; readonly deliveryId: string | null }
  | { readonly type: "transport_error"; readonly message: string };

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
  readonly senderPeerId: string;
  readonly recipientPeerId: string;
  readonly deliveryId: string;
}): Uint8Array {
  return makeBetaPayloadAAD({
    protocol: protocolID,
    profileMultihash: fields.route.profileMultihash,
    senderPeerId: fields.senderPeerId,
    recipientPeerId: fields.recipientPeerId,
    deliveryId: fields.deliveryId,
    pathEpoch: 0,
    streamId: 0,
    frameType: "ENVELOPE",
    ackRequested: true
  });
}

export class EchoTestService {
  private readonly route: RelayRouteMaterial;
  private readonly keys: BetaEchoServiceKeyMaterial;
  private readonly socketFactory: BrowserRelaySocketFactory | undefined;
  private readonly crypto: Crypto | undefined;
  private readonly heartbeatIntervalMs: number;
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
    this.onEvent = options.onEvent;
  }

  async start(): Promise<void> {
    this.stop();
    const client = new SameRelayTransportClient({
      route: this.route,
      identity: this.keys.identity,
      ...(this.socketFactory === undefined ? {} : { socketFactory: this.socketFactory }),
      ...(this.crypto === undefined ? {} : { crypto: this.crypto })
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
        senderPeerId: event.senderPeerId,
        recipientPeerId: this.keys.identity.peerId,
        deliveryId: event.deliveryId
      })
    });
    const request = decodeEchoRequestPayload(plaintext);
    const responseDeliveryId = randomToken(16);
    const sealed = await sealBetaPayload({
      recipientPublicKey: request.replyHpkePublicKey,
      plaintext,
      aad: makeEchoPayloadAAD({
        route: this.route,
        senderPeerId: this.keys.identity.peerId,
        recipientPeerId: event.senderPeerId,
        deliveryId: responseDeliveryId
      })
    });
    client.lookup(event.senderPeerId);
    client.rendezvous(event.senderPeerId);
    client.sendSealedEnvelope(sealed, { deliveryId: responseDeliveryId });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "echo service failed";
}
