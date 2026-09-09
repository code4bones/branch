import { createBetaPayloadKeyPair } from "./payload-crypto.js";
import { EchoTestService, type BetaEchoContact } from "./echo-service.js";
import { runEchoRoundTrip } from "./echo-client.js";
import {
  SameRelayTransportClient,
  validateRouteMaterial,
  type BrowserRelaySocketFactory,
  type RelayRouteMaterial
} from "./same-relay.js";

export interface FederationSelfTestOptions {
  /** Already validated routes. Carrier discovery deliberately stays with the caller. */
  readonly routes: readonly RelayRouteMaterial[];
  readonly socketFactory?: BrowserRelaySocketFactory;
  readonly crypto?: Crypto;
  readonly perAttemptTimeoutMs?: number;
  readonly onProgress?: (attempt: FederationSelfTestProgress) => void;
}

export interface FederationSelfTestProgress {
  readonly sourceEndpoint: string;
  readonly targetEndpoint: string;
  readonly attempt: number;
  readonly phase: "starting" | "failed";
  readonly reason?: string;
}

export type FederationSelfTestReport =
  | {
    readonly status: "ok";
    readonly sourceRoute: RelayRouteMaterial;
    readonly targetRoute: RelayRouteMaterial;
    readonly latencyMs: number;
    readonly attempts: readonly FederationSelfTestAttempt[];
    readonly totalPairCount: number;
    readonly attemptLimitReached: boolean;
  }
  | {
    readonly status: "failed";
    readonly reason: "insufficient_distinct_routes" | "scheduled_pairs_failed";
    readonly attempts: readonly FederationSelfTestAttempt[];
    readonly totalPairCount: number;
    readonly attemptLimitReached: boolean;
  };

export interface FederationSelfTestAttempt {
  readonly sourceEndpoint: string;
  readonly targetEndpoint: string;
  readonly status: "ok" | "failed";
  readonly latencyMs: number | null;
  readonly reason: string | null;
}

const maxRoutes = 4;
const maxPairs = 6;
const defaultTimeoutMs = 8_000;
const propagationWaitMs = 300;

/**
 * Explicitly proves relay federation by placing an ephemeral Echo peer on one
 * route and addressing it through another. No route or identity outlives this call.
 */
export async function runFederationSelfTest(options: FederationSelfTestOptions): Promise<FederationSelfTestReport> {
  const routes = distinctRoutes(options.routes);
  if (routes.length < 2) {
    return {
      status: "failed",
      reason: "insufficient_distinct_routes",
      attempts: [],
      totalPairCount: 0,
      attemptLimitReached: false
    };
  }
  const attempts: FederationSelfTestAttempt[] = [];
  const timeoutMs = boundedTimeout(options.perAttemptTimeoutMs ?? defaultTimeoutMs);
  const totalPairCount = routes.length * (routes.length - 1);
  const pairs = plannedPairs(routes);

  for (const [index, pair] of pairs.entries()) {
    const sourceRoute = pair.sourceRoute;
    const targetRoute = pair.targetRoute;
    const attempt = index + 1;
    options.onProgress?.({ sourceEndpoint: sourceRoute.endpointUri, targetEndpoint: targetRoute.endpointUri, attempt, phase: "starting" });
    const startedAt = Date.now();
    let service: EchoTestService | null = null;
    try {
      const [identity, payloadKey] = await Promise.all([
        SameRelayTransportClient.createIdentity(options.crypto),
        createBetaPayloadKeyPair()
      ]);
      const contact: BetaEchoContact = {
        id: "branch.echo/0.draft",
        label: "B.R.A.N.C.H. federation self-test",
        peerId: identity.peerId,
        hpkePublicKey: payloadKey.publicKey
      };
      service = new EchoTestService({
        route: targetRoute,
        keys: { identity, payloadKey },
        handshakeTimeoutMs: timeoutMs,
        ...(options.socketFactory === undefined ? {} : { socketFactory: options.socketFactory }),
        ...(options.crypto === undefined ? {} : { crypto: options.crypto })
      });
      await service.start();
      await sleep(propagationWaitMs);
      const result = await runEchoRoundTrip({
        routes: [sourceRoute],
        body: "branch federation self-test",
        contact,
        perRouteTimeoutMs: timeoutMs,
        ...(options.socketFactory === undefined ? {} : { socketFactory: options.socketFactory }),
        ...(options.crypto === undefined ? {} : { crypto: options.crypto })
      });
      if (result.status !== "ok") {
        throw new Error(result.attempts[0]?.reason ?? result.reason);
      }
      const latencyMs = Date.now() - startedAt;
      attempts.push({ sourceEndpoint: sourceRoute.endpointUri, targetEndpoint: targetRoute.endpointUri, status: "ok", latencyMs, reason: null });
      return {
        status: "ok",
        sourceRoute,
        targetRoute,
        latencyMs,
        attempts,
        totalPairCount,
        attemptLimitReached: pairs.length < totalPairCount
      };
    } catch (error) {
      const reason = errorMessage(error);
      attempts.push({
        sourceEndpoint: sourceRoute.endpointUri,
        targetEndpoint: targetRoute.endpointUri,
        status: "failed",
        latencyMs: Date.now() - startedAt,
        reason
      });
      options.onProgress?.({ sourceEndpoint: sourceRoute.endpointUri, targetEndpoint: targetRoute.endpointUri, attempt, phase: "failed", reason });
    } finally {
      service?.stop();
    }
  }
  return {
    status: "failed",
    reason: "scheduled_pairs_failed",
    attempts,
    totalPairCount,
    attemptLimitReached: pairs.length < totalPairCount
  };
}

function plannedPairs(routes: readonly RelayRouteMaterial[]): readonly {
  readonly sourceRoute: RelayRouteMaterial;
  readonly targetRoute: RelayRouteMaterial;
}[] {
  const pairs: { sourceRoute: RelayRouteMaterial; targetRoute: RelayRouteMaterial }[] = [];
  for (let offset = 1; offset < routes.length && pairs.length < maxPairs; offset += 1) {
    for (let sourceIndex = 0; sourceIndex < routes.length && pairs.length < maxPairs; sourceIndex += 1) {
      const sourceRoute = routes[sourceIndex];
      const targetRoute = routes[(sourceIndex + offset) % routes.length];
      if (sourceRoute !== undefined && targetRoute !== undefined) {
        pairs.push({ sourceRoute, targetRoute });
      }
    }
  }
  return pairs;
}

function distinctRoutes(input: readonly RelayRouteMaterial[]): readonly RelayRouteMaterial[] {
  const routes: RelayRouteMaterial[] = [];
  const seen = new Set<string>();
  for (const route of input) {
    if (routes.length === maxRoutes) {
      break;
    }
    try {
      const validated = validateRouteMaterial(route);
      if (!seen.has(validated.endpointUri)) {
        seen.add(validated.endpointUri);
        routes.push(validated);
      }
    } catch {
      // The caller's discovery result can contain malformed candidates.
    }
  }
  return routes;
}

function boundedTimeout(value: number): number {
  if (!Number.isFinite(value)) {
    return defaultTimeoutMs;
  }
  return Math.max(1_000, Math.min(30_000, Math.trunc(value)));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "federation self-test failed";
}
