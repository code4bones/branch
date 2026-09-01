import {
  runCarrierHoppingPoC,
  type CarrierHoppingPoCReport
} from "../connectivity/carrier-hopping-poc.js";
import {
  parseRelayEndpointDescriptor,
  type BrowserRelaySocketFactory,
  type RelayRouteMaterial
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
  readonly routeSnapshot: readonly RelayRouteMaterial[];
  readonly transport: CarrierHoppingPoCReport;
}

const maxRouteSnapshot = 4;

export async function runDiscoveredCarrierHopPoC(options: DiscoveredCarrierHopOptions): Promise<DiscoveredCarrierHopReport> {
  const discovery = await discoverClientBootstrapBeacons(discoveryRequest(options));
  const routeSnapshot = routesFromBeaconObservations(discovery.observations);
  options.onDiscoveryReport?.(discovery);
  const transport = await runCarrierHoppingPoC({
    routes: routeSnapshot,
    ...(options.socketFactory === undefined ? {} : { socketFactory: options.socketFactory }),
    ...(options.crypto === undefined ? {} : { crypto: options.crypto }),
    ...(options.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: options.stepTimeoutMs }),
    ...(options.onTransportEvent === undefined ? {} : { onEvent: options.onTransportEvent })
  });
  return {
    discovery,
    routeSnapshot,
    transport
  };
}

export function routesFromBeaconObservations(observations: readonly BeaconObservation[]): readonly RelayRouteMaterial[] {
  const routes: RelayRouteMaterial[] = [];
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
    const dedupeKey = `${endpoint.uri}\n${observation.senderPublicKey}\n${observation.profileMultihash}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    routes.push({
      endpointUri: endpoint.uri,
      relayPublicKey: observation.senderPublicKey,
      profileMultihash: observation.profileMultihash
    });
    if (routes.length >= maxRouteSnapshot) {
      break;
    }
  }
  return routes;
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
