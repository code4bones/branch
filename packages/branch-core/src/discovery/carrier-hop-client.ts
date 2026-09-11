import {
  runCarrierHoppingPoC,
  type CarrierHoppingPoCReport
} from "../connectivity/carrier-hopping-poc.js";
import {
  parseRelayEndpointDescriptor,
  routeMaterialFromValidatedBootstrapBeacon,
  type BrowserRelaySocketFactory,
  type RelayRouteHint,
  type RelayRouteMaterial,
  type VerifiedRelayRouteMaterial
} from "../connectivity/same-relay.js";
import {
  discoverClientBootstrapBeacons,
  type BeaconObservation,
  type ClientDiscoveryReport,
  type ClientDiscoveryRequest,
  type SearchCarrier
} from "./client.js";

export interface DiscoveredCarrierHopOptions {
  readonly carrier: SearchCarrier;
  readonly primaryQuery: string;
  readonly fallbackQuery?: string | null;
  readonly includeFallback?: boolean;
  readonly includeForks?: boolean;
  readonly includeRouteHints?: boolean;
  readonly page?: number;
  readonly perPage?: number;
  readonly signal?: AbortSignal;
  readonly socketFactory?: BrowserRelaySocketFactory;
  readonly crypto?: Crypto;
  readonly stepTimeoutMs?: number;
  readonly onDiscoveryReport?: (report: ClientDiscoveryReport) => void;
  readonly onTransportEvent?: (event: string) => void;
}

export interface DiscoveredCarrierHopReport {
  readonly discovery: ClientDiscoveryReport;
  readonly routeSnapshot: readonly VerifiedRelayRouteMaterial[];
  readonly routeHintsSnapshot: readonly RelayRouteHint[];
  readonly transport: CarrierHoppingPoCReport;
}

const maxRouteSnapshot = 4;

/**
 * Public bootstrap material that has already passed the signed-beacon
 * validator.  This is deliberately not a relay assertion: consumers still
 * have to perform the ordinary attachment challenge before using a route.
 */
export interface VerifiedRelayRouteSnapshot extends VerifiedRelayRouteMaterial {
  readonly expiresAt: number;
}

export async function runDiscoveredCarrierHopPoC(options: DiscoveredCarrierHopOptions): Promise<DiscoveredCarrierHopReport> {
  const discovery = await discoverClientBootstrapBeacons(discoveryRequest(options));
  const routeSnapshot = routesFromBeaconObservations(discovery.observations);
  const routeHintsSnapshot = routeHintsFromBeaconObservations(discovery.observations);
  options.onDiscoveryReport?.(discovery);
  const transport = await runCarrierHoppingPoC({
    routes: routeSnapshot,
    ...(options.includeRouteHints === false ? {} : { routeHints: routeHintsSnapshot }),
    ...(options.socketFactory === undefined ? {} : { socketFactory: options.socketFactory }),
    ...(options.crypto === undefined ? {} : { crypto: options.crypto }),
    ...(options.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: options.stepTimeoutMs }),
    ...(options.onTransportEvent === undefined ? {} : { onEvent: options.onTransportEvent })
  });
  return {
    discovery,
    routeSnapshot,
    routeHintsSnapshot,
    transport
  };
}

export function routesFromBeaconObservations(observations: readonly BeaconObservation[]): readonly VerifiedRelayRouteMaterial[] {
  return verifiedRoutesFromBeaconObservations(observations).map(({ expiresAt: ignored, ...route }) => {
    void ignored;
    return route;
  });
}

/**
 * Preserve the signed beacon expiry for bounded local bootstrap views.  The
 * route-only helper above remains for live transport callers, which must not
 * confuse cached discovery material with an attachment or presence claim.
 */
export function verifiedRoutesFromBeaconObservations(observations: readonly BeaconObservation[]): readonly VerifiedRelayRouteSnapshot[] {
  const routes: VerifiedRelayRouteSnapshot[] = [];
  const seen = new Set<string>();
  for (const observation of observations) {
    if (
      observation.validation !== "accepted" ||
      observation.relayEndpoint === null ||
      observation.senderPublicKey === null ||
      observation.profileMultihash === null ||
      observation.expiresAt === null
    ) {
      continue;
    }
    const endpoint = parseRelayEndpointDescriptor(observation.relayEndpoint);
    if (endpoint === null) {
      continue;
    }
    const dedupeKey = `${endpoint.uri}\n${observation.senderPublicKey}\n${observation.profileMultihash}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    // The observation was produced only after the signed beacon validator
    // accepted the wrapper. Preserve that provenance as the transport route.
    routes.push({
      ...routeMaterialFromValidatedBootstrapBeacon({
      endpointUri: endpoint.uri,
      relayPublicKey: observation.senderPublicKey,
      profileMultihash: observation.profileMultihash
      }),
      expiresAt: observation.expiresAt
    });
    if (routes.length >= maxRouteSnapshot) {
      break;
    }
  }
  return routes;
}

export function routeHintsFromBeaconObservations(observations: readonly BeaconObservation[]): readonly RelayRouteHint[] {
  const routeHints: RelayRouteHint[] = [];
  const seen = new Set<string>();
  for (const observation of observations) {
    if (
      observation.validation !== "accepted" ||
      observation.relayEndpoint === null ||
      observation.senderPublicKey === null ||
      observation.profileMultihash === null
    ) {
      continue;
    }
    const endpoint = parseRelayEndpointDescriptor(observation.relayEndpoint);
    if (endpoint === null) {
      continue;
    }
    const dedupeKey = `${endpoint.transport}\n${endpoint.uri}\n${observation.senderPublicKey}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    routeHints.push({
      transport: endpoint.transport,
      uri: endpoint.uri,
      relayPublicKey: observation.senderPublicKey,
      priority: routeHints.length
    });
    if (routeHints.length >= maxRouteSnapshot) {
      break;
    }
  }
  return routeHints;
}

function discoveryRequest(options: DiscoveredCarrierHopOptions): ClientDiscoveryRequest {
  return {
    carrier: options.carrier,
    primaryQuery: options.primaryQuery,
    ...(options.fallbackQuery === undefined ? {} : { fallbackQuery: options.fallbackQuery }),
    ...(options.includeFallback === undefined ? {} : { includeFallback: options.includeFallback }),
    ...(options.includeForks === undefined ? {} : { includeForks: options.includeForks }),
    ...(options.page === undefined ? {} : { page: options.page }),
    ...(options.perPage === undefined ? {} : { perPage: options.perPage }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  };
}
