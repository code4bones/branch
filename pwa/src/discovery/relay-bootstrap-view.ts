import {
  routeMaterialFromTrustedLocalBootstrapView,
  validateRouteMaterial,
  type RelayRouteMaterial,
  type VerifiedRelayRouteMaterial
} from "@code4bones/branch-core";

export const maxStoredRelayBootstrapRoutes = 4;
export const relayBootstrapRefreshIntervalMs = 60 * 60 * 1_000;
export const relayBootstrapRefreshJitterMs = 5 * 60 * 1_000;

export interface VerifiedRelayBootstrapRoute extends VerifiedRelayRouteMaterial {
  readonly expiresAt: number;
}

interface StoredVerifiedRelayBootstrapRoute extends RelayRouteMaterial {
  readonly expiresAt: number;
}

export interface StoredRelayBootstrapView {
  readonly schemaVersion: 1;
  readonly refreshedAt: number;
  readonly refreshAfter: number;
  readonly routes: readonly StoredVerifiedRelayBootstrapRoute[];
}

export interface LoadedRelayBootstrapView {
  readonly routes: readonly VerifiedRelayBootstrapRoute[];
  readonly stale: boolean;
}

/**
 * Validate the browser's local copy as if it came from hostile storage.  The
 * actual signed beacon was validated before it entered this view; this check
 * prevents an IndexedDB corruption from becoming route material.
 */
export function decodeStoredRelayBootstrapView(value: unknown, now: number): LoadedRelayBootstrapView | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isTimestamp(value.refreshedAt) || !isTimestamp(value.refreshAfter) || value.refreshAfter < value.refreshedAt || !Array.isArray(value.routes) || value.routes.length < 1 || value.routes.length > maxStoredRelayBootstrapRoutes) {
    return null;
  }
  const routes: VerifiedRelayBootstrapRoute[] = [];
  const seen = new Set<string>();
  for (const candidate of value.routes) {
    if (!isRecord(candidate) || typeof candidate.endpointUri !== "string" || typeof candidate.relayPublicKey !== "string" || typeof candidate.profileMultihash !== "string" || !isTimestamp(candidate.expiresAt) || candidate.expiresAt <= now) {
      return null;
    }
    try {
      const route = routeMaterialFromTrustedLocalBootstrapView({
        endpointUri: candidate.endpointUri,
        relayPublicKey: candidate.relayPublicKey,
        profileMultihash: candidate.profileMultihash
      });
      const key = `${route.endpointUri}\n${route.relayPublicKey}\n${route.profileMultihash}`;
      if (seen.has(key)) return null;
      seen.add(key);
      routes.push({ ...route, expiresAt: candidate.expiresAt });
    } catch {
      return null;
    }
  }
  return { routes, stale: now >= value.refreshAfter };
}

export function makeStoredRelayBootstrapView(routes: readonly VerifiedRelayBootstrapRoute[], now: number, random: () => number = Math.random): StoredRelayBootstrapView {
  if (!isTimestamp(now) || routes.length < 1 || routes.length > maxStoredRelayBootstrapRoutes) {
    throw new Error("invalid verified relay bootstrap view");
  }
  const normalized = routes.map((route): StoredVerifiedRelayBootstrapRoute => {
    validateRouteMaterial(route);
    return {
      endpointUri: route.endpointUri,
      relayPublicKey: route.relayPublicKey,
      profileMultihash: route.profileMultihash,
      expiresAt: route.expiresAt
    };
  });
  const decoded = decodeStoredRelayBootstrapView({
    schemaVersion: 1,
    refreshedAt: now,
    refreshAfter: now + relayBootstrapRefreshIntervalMs,
    routes: normalized
  }, now);
  if (decoded === null) throw new Error("invalid verified relay bootstrap routes");
  // A small local jitter spreads foreground refreshes without creating a
  // background scheduler or a shared timing signal.
  const jitter = Math.floor(Math.max(0, Math.min(0.999_999, random())) * relayBootstrapRefreshJitterMs);
  return { schemaVersion: 1, refreshedAt: now, refreshAfter: now + relayBootstrapRefreshIntervalMs + jitter, routes: normalized };
}

export function relayRoutesFromBootstrapView(view: LoadedRelayBootstrapView): readonly VerifiedRelayRouteMaterial[] {
  return view.routes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
