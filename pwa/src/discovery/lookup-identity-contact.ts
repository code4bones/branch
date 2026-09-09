import {
  createGitHubIdentityContactSearchCarrier,
  discoverClientIdentityContacts,
  githubDiscoveryDefaultQuery,
  type IdentityContactObservation
} from "@code4bones/branch-core";

export interface IdentityContactLookupResult {
  readonly accepted: IdentityContactObservation | null;
  readonly message: string;
}

// Direct-carrier-only BranchID lookup. The Admin Client tab tries a
// relay-assisted /node-admin/identity/lookup first (operator beta
// acceleration, needs an admin token); the PWA has no such token, so it goes
// straight to the same GitHub SearchCarrier path relay discovery already
// uses (see coordination note I-BRANCH-202) — same locator, different record
// type (identity.announce, not bootstrap.beacon).
export async function lookupIdentityContactViaGitHub(branchID: string, signal?: AbortSignal): Promise<IdentityContactLookupResult> {
  const discovery = await discoverClientIdentityContacts({
    carrier: createGitHubIdentityContactSearchCarrier(),
    branchID,
    primaryQuery: githubDiscoveryDefaultQuery,
    fallbackQuery: null,
    includeFallback: false,
    includeForks: false,
    perPage: 5,
    page: 1,
    ...(signal === undefined ? {} : { signal })
  });
  const accepted = discovery.observations.find((observation) => observation.validation === "accepted") ?? null;
  return { accepted, message: discovery.message };
}
