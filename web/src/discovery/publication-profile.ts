export const branchBootstrapLocator = "branchbootstrapv0" as const;
export const branchProtocolSearchMarkers = ["BRANCH0", "branch/connectivity/0", "branch-bootstrap-v0"] as const;
export const branchCampaignMarker = "carry-the-ribbon" as const;
export const githubBadgeAltText = "B.R.A.N.C.H. branchbootstrapv0 Blue Ribbon - Carry the Ribbon" as const;
export const githubRepositoryTopics = ["branchbootstrapv0", "carry-the-ribbon", "branch-protocol"] as const;
export const githubRepositoryDescription = "B.R.A.N.C.H. bootstrap carrier branchbootstrapv0 carry-the-ribbon" as const;
export const githubPrimaryLocatorQuery = `${branchBootstrapLocator} in:readme` as const;
export const githubLegacyMarkerQuery = `${branchProtocolSearchMarkers.join(" ")} in:readme` as const;

export function branchPublicationMarkers(): readonly string[] {
  return [branchBootstrapLocator, ...branchProtocolSearchMarkers, branchCampaignMarker];
}

export function makeRootReadmeSnippet(): string {
  return `[![${githubBadgeAltText}](.branch/ribbon.svg)](.branch/README.md)

B.R.A.N.C.H. bootstrap carrier: ${branchBootstrapLocator}
`;
}
