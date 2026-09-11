import { encodeBase64URL } from "../protocol/v0/base64url.js";
import {
  SameRelayTransportClient,
  validateRouteMaterial,
  type BrowserRelaySocketFactory,
  type VerifiedRelayRouteMaterial
} from "./same-relay.js";
import {
  betaEchoRequestType,
  decodeEchoRequestPayload,
  encodeEchoRequestPayload,
  makeEchoPayloadAAD,
  type BetaEchoContact
} from "./echo-service.js";
import {
  betaHpkeCiphertextBytesForPlaintext,
  betaHpkeCiphertextBytesFromSealedPayload,
  createBetaPayloadKeyPair,
  openBetaPayload,
  sealBetaPayload
} from "./payload-crypto.js";

export interface EchoRoundTripOptions {
  readonly routes: readonly VerifiedRelayRouteMaterial[];
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
    readonly route: VerifiedRelayRouteMaterial;
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
      contact: options.contact ?? null,
      timeoutMs: boundedTimeout(options.perRouteTimeoutMs ?? defaultEchoRoundTripTimeoutMs),
      attempt,
      ...(options.socketFactory === undefined ? {} : { socketFactory: options.socketFactory }),
      ...(options.crypto === undefined ? {} : { crypto: options.crypto })
    });
  });

  try {
    const result = await firstResolved(attemptPromises);
    for (const controller of controllers) {
      controller.stop();
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
  readonly route: VerifiedRelayRouteMaterial;
  readonly body: string;
  readonly latencyMs: number;
}

interface EchoResponseWaiter {
  readonly promise: Promise<string>;
  cancel(): void;
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
  private responseWaiter: EchoResponseWaiter | null = null;

  constructor(readonly route: VerifiedRelayRouteMaterial) {}

  async run(options: {
    readonly body: string;
    readonly contact: BetaEchoContact | null;
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
      const recipientPeerId = options.contact?.peerId ?? identity.peerId;
      const recipientHpkePublicKey = options.contact?.hpkePublicKey ?? payloadKey.publicKey;
      // RENDEZVOUS performs the required local lookup and only then asks
      // federation for a live peer on a miss. A separate LOOKUP duplicates
      // the bounded carrier pass without creating a route.
      client.rendezvous(recipientPeerId);

      const deliveryId = randomToken(16);
      const originRouteId = client.routeId;
      if (originRouteId === null) {
        throw new Error("relay session is not attached");
      }
      const plaintext = encodeEchoRequestPayload({
        type: betaEchoRequestType,
        replyHpkePublicKey: payloadKey.publicKey,
        body: options.body
      });
      const ciphertextBytes = betaHpkeCiphertextBytesForPlaintext(plaintext);
      const sealed = await sealBetaPayload({
        recipientPublicKey: recipientHpkePublicKey,
        plaintext,
        aad: makeEchoPayloadAAD({
          route: this.route,
          originRouteId,
          senderPeerId: identity.peerId,
          recipientPeerId,
          deliveryId,
          hpkeCiphertextBytes: ciphertextBytes
        }),
        expectedCiphertextBytes: ciphertextBytes
      });
      const response = this.waitForEchoResponse({
        client,
        expectedSenderPeerId: recipientPeerId,
        recipientPrivateKey: payloadKey.privateKey,
        localPeerId: identity.peerId,
        timeoutMs: options.timeoutMs
      });
      try {
        client.sendSealedEnvelope(sealed, { deliveryId, originRouteId });
        const echoed = await response.promise;
        if (echoed !== options.body) {
          throw new Error("echo body mismatch");
        }
      } catch (error) {
        response.cancel();
        throw error;
      }
      const latencyMs = Date.now() - startedAt;
      options.attempt.status = "ok";
      options.attempt.latencyMs = latencyMs;
      return { route: this.route, body: options.body, latencyMs };
    } catch (error) {
      options.attempt.status = "failed";
      options.attempt.latencyMs = Date.now() - startedAt;
      options.attempt.reason = errorMessage(error);
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.responseWaiter?.cancel();
    this.responseWaiter = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.client?.disconnect();
    this.client = null;
  }

  private waitForEchoResponse(options: {
    readonly client: SameRelayTransportClient;
    readonly expectedSenderPeerId: string;
    readonly recipientPrivateKey: CryptoKey;
    readonly localPeerId: string;
    readonly timeoutMs: number;
  }): EchoResponseWaiter {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const promise = new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("echo response timeout"));
      }, options.timeoutMs);
      const cleanup = (): void => {
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.responseWaiter === waiter) {
          this.responseWaiter = null;
        }
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
        if (event.senderPeerId !== options.expectedSenderPeerId) {
          cleanup();
          reject(new Error("unexpected echo sender peer id"));
          return;
        }
        void openBetaPayload({
          recipientPrivateKey: options.recipientPrivateKey,
          sealedPayload: event.ciphertext,
          aad: makeEchoPayloadAAD({
            route: this.route,
            originRouteId: event.originRouteId,
            senderPeerId: options.expectedSenderPeerId,
            recipientPeerId: options.localPeerId,
            deliveryId: event.deliveryId,
            hpkeCiphertextBytes: betaHpkeCiphertextBytesFromSealedPayload(event.ciphertext)
          }),
          expectedCiphertextBytes: betaHpkeCiphertextBytesFromSealedPayload(event.ciphertext)
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
    const waiter = {
      promise,
      cancel: (): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.responseWaiter === waiter) {
          this.responseWaiter = null;
        }
      }
    };
    this.responseWaiter = waiter;
    return waiter;
  }
}

async function firstResolved(promises: readonly Promise<EchoAttemptSuccess>[]): Promise<EchoAttemptSuccess> {
  return Promise.any(promises);
}

function validateEchoRoundTripRoutes(routes: readonly VerifiedRelayRouteMaterial[]): readonly VerifiedRelayRouteMaterial[] {
  if (routes.length > maxEchoRoundTripRoutes) {
    throw new Error("too many echo routes");
  }
  const seen = new Set<string>();
  const validated: VerifiedRelayRouteMaterial[] = [];
  for (const route of routes) {
    validateRouteMaterial(route);
    const key = `${route.endpointUri}\0${route.relayPublicKey}\0${route.profileMultihash}`;
    if (!seen.has(key)) {
      seen.add(key);
      validated.push(route);
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
