import {
  createGitHubSearchCarrier,
  discoverClientBootstrapBeacons,
  githubDiscoveryDefaultQuery,
  verifiedRoutesFromBeaconObservations,
  type RelayRouteMaterial,
  type VerifiedRelayRouteMaterial
} from "@code4bones/branch-core";

import {
  makeStoredRelayBootstrapView,
  relayRoutesFromBootstrapView,
  type VerifiedRelayBootstrapRoute
} from "./relay-bootstrap-view.js";
import { loadStoredRelayBootstrapView, saveStoredRelayBootstrapView } from "../storage/relay-bootstrap-view-store.js";

export interface FindRelayRouteResult {
  readonly routes: readonly RelayRouteMaterial[];
  readonly source: string;
  readonly message: string;
}

export interface RelayBootstrapResolution extends FindRelayRouteResult {
  /** A stale view remains signed and usable, but permits one foreground refresh. */
  readonly stale: boolean;
  readonly cacheUsed: boolean;
}

// Searches GitHub for signed relay bootstrap beacons and returns every
// accepted route (bounded by routesFromBeaconObservations), not just the
// first. The primary chat session makes independent live transport attempts.
export async function findRelayRouteViaGitHub(signal?: AbortSignal): Promise<FindRelayRouteResult> {
  const discovery = await discoverClientBootstrapBeacons({
    carrier: createGitHubSearchCarrier(),
    primaryQuery: githubDiscoveryDefaultQuery,
    fallbackQuery: null,
    includeFallback: false,
    includeForks: false,
    perPage: 5,
    page: 1,
    ...(signal === undefined ? {} : { signal })
  });
  // The protocol beacon uses Unix seconds; browser lifecycle/storage clocks
  // use Date.now() milliseconds. Convert precisely at this adapter boundary
  // so a valid signed expiry never becomes an immediate local cache miss.
  const verifiedRoutes = browserVerifiedRoutes(verifiedRoutesFromBeaconObservations(discovery.observations));
  if (verifiedRoutes.length > 0) {
    await saveStoredRelayBootstrapView(makeStoredRelayBootstrapView(verifiedRoutes, Date.now()));
  }
  return {
    routes: routeMaterial(verifiedRoutes),
    source: "github",
    message: discovery.message
  };
}

/**
 * Resolve a route for a visible PWA lifecycle action.  A still-valid local
 * verified view is always returned before its carrier is consulted.  There is
 * deliberately no timer or service-worker caller for this function.
 */
export async function resolveRelayRouteForForeground(signal?: AbortSignal): Promise<RelayBootstrapResolution> {
  const cached = await loadStoredRelayBootstrapView(Date.now());
  if (cached !== null) {
    return {
      routes: relayRoutesFromBootstrapView(cached),
      source: "local verified relay view",
      message: cached.stale ? "Using stale verified relay view; refreshing in foreground" : "Using verified relay view",
      stale: cached.stale,
      cacheUsed: true
    };
  }
  const discovered = await findRelayRouteViaGitHub(signal);
  return { ...discovered, stale: false, cacheUsed: false };
}

export function browserVerifiedRoutes(routes: readonly VerifiedRelayRouteMaterial[]): readonly VerifiedRelayBootstrapRoute[] {
  return routes.map((route) => ({ ...route, expiresAt: unixSecondsToMilliseconds(route.expiresAt) }));
}

function routeMaterial(routes: readonly VerifiedRelayBootstrapRoute[]): readonly RelayRouteMaterial[] {
  return routes.map((route): RelayRouteMaterial => {
    const { expiresAt: ignored, ...material } = route;
    void ignored;
    return material;
  });
}

function unixSecondsToMilliseconds(value: number): number {
  const milliseconds = value * 1_000;
  if (!Number.isSafeInteger(milliseconds)) throw new Error("invalid relay beacon expiry");
  return milliseconds;
}
