import type { RelayRouteMaterial } from "@code4bones/branch-core";

// This is a local, non-secret comparison key for routes that discovery has
// already validated. It is never sent to a relay or stored as identity state.
export function relayRouteKey(route: RelayRouteMaterial): string {
  return `${route.endpointUri}\n${route.relayPublicKey}\n${route.profileMultihash}`;
}

// Carrier ordering is untrusted presentation data, not a routing policy. Two
// clients that observed the same valid beacon set must try the same bounded
// relay order so their ordinary two-party chat does not unnecessarily depend
// on a federation bridge.
export function orderedAttachmentRoutes<Route extends RelayRouteMaterial>(routes: readonly Route[]): readonly Route[] {
  return [...routes].sort((left, right) => {
    const endpoint = left.endpointUri.localeCompare(right.endpointUri);
    if (endpoint !== 0) {
      return endpoint;
    }
    const relayKey = left.relayPublicKey.localeCompare(right.relayPublicKey);
    if (relayKey !== 0) {
      return relayKey;
    }
    return left.profileMultihash.localeCompare(right.profileMultihash);
  });
}

/**
 * A relay pin is a tab-local test/operator preference. A missing pin target
 * deliberately produces no candidate: silently falling back would make a
 * federated or direct-path acceptance test claim the wrong relay placement.
 */
export function attachmentRoutesForSelection<Route extends RelayRouteMaterial>(routes: readonly Route[], pinnedRelayKey: string | null): readonly Route[] {
  const ordered = orderedAttachmentRoutes(routes);
  if (pinnedRelayKey === null) return ordered;
  const pinned = ordered.find((route) => relayRouteKey(route) === pinnedRelayKey);
  return pinned === undefined ? [] : [pinned];
}
