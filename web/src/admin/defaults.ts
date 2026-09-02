export const defaultBranchWrapper =
  "BRANCH0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export const ribbonPngFilename = "branch-ribbon-block.png";
export const githubBundleFilename = "branch-github-dropin.zip";
export const gitLabBundleFilename = "branch-gitlab-dropin.zip";

export const ribbonProfileLabel = "ribbon-block/0.draft";

export function githubBundleFilenameForRelay(relayId: string): string {
  const safeRelayId = relayId.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `branch-${safeRelayId || "relay"}-github-dropin.zip`;
}
