import type { RelayRouteMaterial } from "@code4bones/branch-core";

// Carrier ordering is untrusted presentation data, not a routing policy. Two
// clients that observed the same valid beacon set must try the same bounded
// relay order so their ordinary two-party chat does not unnecessarily depend
// on a federation bridge.
export function orderedAttachmentRoutes(routes: readonly RelayRouteMaterial[]): readonly RelayRouteMaterial[] {
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
