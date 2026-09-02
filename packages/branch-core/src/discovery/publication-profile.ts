export const branchBootstrapLocator = "branchbootstrapv0" as const;
export const branchProtocolSearchMarkers = ["BRANCH0", "branch/connectivity/0", "branch-bootstrap-v0"] as const;
export const branchCampaignMarker = "carry-the-ribbon" as const;
export const githubBadgeAltText = "B.R.A.N.C.H. Blue Ribbon - Carry the Ribbon" as const;
export const githubRepositoryTopics = [branchBootstrapLocator] as const;
export const githubRepositoryDescription = "B.R.A.N.C.H. bootstrap carrier branchbootstrapv0 carry-the-ribbon" as const;
export const githubPrimaryLocatorQuery = `topic:${branchBootstrapLocator}` as const;
export const githubLegacyMarkerQuery = `${branchProtocolSearchMarkers.join(" ")} in:readme` as const;
export const gitLabProjectTopics = [branchBootstrapLocator] as const;
export const gitLabProjectDescription = "B.R.A.N.C.H. bootstrap carrier branchbootstrapv0 carry-the-ribbon" as const;
export const gitLabPrimaryLocatorQuery = branchBootstrapLocator;
export const ribbonImagePublicationTitle = "Carry the Ribbon" as const;
export const ribbonImagePublicationDescription =
  "branchbootstrapv0 B.R.A.N.C.H. Blue Ribbon Autonomous Network for Carrier Hopping" as const;
export const ribbonImagePublicationSearchQuery = branchBootstrapLocator;

export function branchPublicationMarkers(): readonly string[] {
  return [branchBootstrapLocator, ...branchProtocolSearchMarkers, branchCampaignMarker];
}

export function makeRootReadmeSnippet(): string {
  return `[![${githubBadgeAltText}](.branch/ribbon.svg)](.branch/README.md)
`;
}
