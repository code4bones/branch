import { encodeBase64URL } from "../protocol/v0/base64url.js";
import {
  SameRelayTransportClient,
  validateRouteMaterial,
  type BrowserRelaySocketFactory,
  type RelayRouteMaterial
} from "./same-relay.js";
import {
  betaEchoRequestType,
  decodeEchoRequestPayload,
  defaultBetaEchoContact,
  encodeEchoRequestPayload,
  makeEchoPayloadAAD,
  type BetaEchoContact
} from "./echo-service.js";
import {
  createBetaPayloadKeyPair,
  openBetaPayload,
  sealBetaPayload
} from "./payload-crypto.js";

export interface EchoRoundTripOptions {
  readonly routes: readonly RelayRouteMaterial[];
  readonly body: string;
  readonly contact?: BetaEchoContact;
  readonly socketFactory?: BrowserRelaySocketFactory;
  readonly crypto?: Crypto;
  readonly perRouteTimeoutMs?: number;
}

export type EchoRoundTripReport =
  | {
    readonly status: "ok";
    readonly body: string;
    readonly route: RelayRouteMaterial;
    readonly latencyMs: number;
    readonly attempts: readonly EchoRouteAttempt[];
  }
  | {
    readonly status: "failed";
    readonly reason: "no_routes" | "all_routes_failed";
    readonly attempts: readonly EchoRouteAttempt[];
  };

export interface EchoRouteAttempt {
  readonly endpointUri: string;
  readonly status: "pending" | "ok" | "failed";
  readonly latencyMs: number | null;
  readonly reason: string | null;
}

const defaultEchoRoundTripTimeoutMs = 8_000;
const maxEchoRoundTripRoutes = 8;

export async function runEchoRoundTrip(options: EchoRoundTripOptions): Promise<EchoRoundTripReport> {
  const routes = validateEchoRoundTripRoutes(options.routes);
  if (routes.length === 0) {
    return { status: "failed", reason: "no_routes", attempts: [] };
  }
  const contact = options.contact ?? defaultBetaEchoContact;
  const attempts = new Map<string, MutableEchoRouteAttempt>();
  const controllers: EchoAttemptController[] = [];

  const attemptPromises = routes.map((route) => {
    const attempt = {
      endpointUri: route.endpointUri,
      status: "pending",
      latencyMs: null,
      reason: null
    } satisfies MutableEchoRouteAttempt;
    attempts.set(route.endpointUri, attempt);
    const controller = new EchoAttemptController(route);
    controllers.push(controller);
    return controller.run({
      body: options.body,
      contact,
      timeoutMs: boundedTimeout(options.perRouteTimeoutMs ?? defaultEchoRoundTripTimeoutMs),
      attempt,
      ...(options.socketFactory === undefined ? {} : { socketFactory: options.socketFactory }),
      ...(options.crypto === undefined ? {} : { crypto: options.crypto })
    });
  });

  try {
    const result = await firstResolved(attemptPromises);
    for (const controller of controllers) {
      if (controller.route.endpointUri !== result.route.endpointUri) {
        controller.stop();
      }
    }
    return {
      status: "ok",
      body: result.body,
      route: result.route,
      latencyMs: result.latencyMs,
      attempts: snapshotAttempts(attempts)
    };
  } catch {
    for (const controller of controllers) {
      controller.stop();
    }
    return {
      status: "failed",
      reason: "all_routes_failed",
      attempts: snapshotAttempts(attempts)
    };
  }
}

interface EchoAttemptSuccess {
  readonly route: RelayRouteMaterial;
  readonly body: string;
  readonly latencyMs: number;
}

interface MutableEchoRouteAttempt {
  readonly endpointUri: string;
  status: "pending" | "ok" | "failed";
  latencyMs: number | null;
  reason: string | null;
}

class EchoAttemptController {
  private client: SameRelayTransportClient | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(readonly route: RelayRouteMaterial) {}

  async run(options: {
    readonly body: string;
    readonly contact: BetaEchoContact;
    readonly socketFactory?: BrowserRelaySocketFactory;
    readonly crypto?: Crypto;
    readonly timeoutMs: number;
    readonly attempt: MutableEchoRouteAttempt;
  }): Promise<EchoAttemptSuccess> {
    const startedAt = Date.now();
    try {
      const identity = await SameRelayTransportClient.createIdentity(options.crypto);
      const payloadKey = await createBetaPayloadKeyPair();
      const client = new SameRelayTransportClient({
        route: this.route,
        identity,
        ...(options.socketFactory === undefined ? {} : { socketFactory: options.socketFactory }),
        ...(options.crypto === undefined ? {} : { crypto: options.crypto }),
        handshakeTimeoutMs: options.timeoutMs
      });
      this.client = client;

      await client.attach();
      client.announcePresence();
      client.heartbeat();
      client.lookup(options.contact.peerId);
      client.rendezvous(options.contact.peerId);

      const deliveryId = randomToken(16);
      const plaintext = encodeEchoRequestPayload({
        type: betaEchoRequestType,
        replyHpkePublicKey: payloadKey.publicKey,
        body: options.body
      });
      const sealed = await sealBetaPayload({
        recipientPublicKey: options.contact.hpkePublicKey,
        plaintext,
        aad: makeEchoPayloadAAD({
          route: this.route,
          senderPeerId: identity.peerId,
          recipientPeerId: options.contact.peerId,
          deliveryId
        })
      });
      const response = this.waitForEchoResponse({
        client,
        contact: options.contact,
        recipientPrivateKey: payloadKey.privateKey,
        recipientPeerId: identity.peerId,
        timeoutMs: options.timeoutMs
      });
      client.sendSealedEnvelope(sealed, { deliveryId });
      const echoed = await response;
      if (echoed !== options.body) {
        throw new Error("echo body mismatch");
      }
      const latencyMs = Date.now() - startedAt;
      options.attempt.status = "ok";
      options.attempt.latencyMs = latencyMs;
      return { route: this.route, body: echoed, latencyMs };
    } catch (error) {
      options.attempt.status = "failed";
      options.attempt.latencyMs = Date.now() - startedAt;
      options.attempt.reason = errorMessage(error);
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.client?.disconnect();
    this.client = null;
  }

  private waitForEchoResponse(options: {
    readonly client: SameRelayTransportClient;
    readonly contact: BetaEchoContact;
    readonly recipientPrivateKey: CryptoKey;
    readonly recipientPeerId: string;
    readonly timeoutMs: number;
  }): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("echo response timeout"));
      }, options.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.unsubscribe?.();
        this.unsubscribe = null;
      };
      this.unsubscribe = options.client.addEventListener((event) => {
        if (event.type === "error") {
          cleanup();
          reject(new Error(event.message));
          return;
        }
        if (event.type === "peer_unavailable") {
          cleanup();
          reject(new Error("echo peer unavailable"));
          return;
        }
        if (event.type !== "envelope_received") {
          return;
        }
        if (event.senderPeerId !== options.contact.peerId) {
          cleanup();
          reject(new Error("unexpected echo sender peer id"));
          return;
        }
        void openBetaPayload({
          recipientPrivateKey: options.recipientPrivateKey,
          sealedPayload: event.ciphertext,
          aad: makeEchoPayloadAAD({
            route: this.route,
            senderPeerId: options.contact.peerId,
            recipientPeerId: options.recipientPeerId,
            deliveryId: event.deliveryId
          })
        }).then((plaintext) => {
          cleanup();
          resolve(decodeEchoRequestPayload(plaintext).body);
          options.client.markPeerReceipt(event.deliveryId);
        }).catch((error: unknown) => {
          cleanup();
          reject(error);
        });
      });
    });
  }
}

async function firstResolved(promises: readonly Promise<EchoAttemptSuccess>[]): Promise<EchoAttemptSuccess> {
  return Promise.any(promises);
}

function validateEchoRoundTripRoutes(routes: readonly RelayRouteMaterial[]): readonly RelayRouteMaterial[] {
  if (routes.length > maxEchoRoundTripRoutes) {
    throw new Error("too many echo routes");
  }
  const seen = new Set<string>();
  const validated: RelayRouteMaterial[] = [];
  for (const route of routes) {
    const normalized = validateRouteMaterial(route);
    const key = `${normalized.endpointUri}\0${normalized.relayPublicKey}\0${normalized.profileMultihash}`;
    if (!seen.has(key)) {
      seen.add(key);
      validated.push(normalized);
    }
  }
  return validated;
}

function snapshotAttempts(attempts: Map<string, MutableEchoRouteAttempt>): readonly EchoRouteAttempt[] {
  return Array.from(attempts.values(), (attempt) => ({ ...attempt }));
}

function boundedTimeout(value: number): number {
  if (!Number.isFinite(value)) {
    return defaultEchoRoundTripTimeoutMs;
  }
  return Math.max(1_000, Math.min(30_000, Math.trunc(value)));
}

function randomToken(size: number): string {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return encodeBase64URL(bytes);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "echo round trip failed";
}
