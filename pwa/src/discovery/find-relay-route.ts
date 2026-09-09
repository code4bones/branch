import {
  createGitHubSearchCarrier,
  discoverClientBootstrapBeacons,
  githubDiscoveryDefaultQuery,
  routesFromBeaconObservations,
  type RelayRouteMaterial
} from "@code4bones/branch-core";

export interface FindRelayRouteResult {
  readonly routes: readonly RelayRouteMaterial[];
  readonly source: string;
  readonly message: string;
}

// Searches GitHub for signed relay bootstrap beacons and returns every
// accepted route (bounded by routesFromBeaconObservations), not just the
// first. The primary chat session and Echo each use these candidates with
// independent live transport attempts.
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
  const routes = routesFromBeaconObservations(discovery.observations);
  return {
    routes,
    source: "github",
    message: discovery.message
  };
}
