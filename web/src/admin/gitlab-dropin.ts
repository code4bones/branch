import { defaultBranchWrapper } from "./defaults.js";
import {
  branchBootstrapLocator,
  branchPublicationMarkers,
  gitLabProjectDescription,
  gitLabProjectTopics,
  makeRootReadmeSnippet
} from "./publication-profile.js";
import { makeStoredZipArchive } from "./zip-archive.js";
import { assertValidBranchTextBootstrapBeacon } from "../protocol/v0/bootstrap-beacon.js";
import { branchTextWrapperPrefix, isBranchTextWrapper } from "../protocol/v0/text-carrier.js";

const encoder = new TextEncoder();

export type GitLabDropInMode = "demo" | "live";

export interface GitLabDropInFile {
  readonly path: string;
  readonly type: string;
  readonly content: string;
}

export interface ParseGitLabRecordsOptions {
  readonly mode?: GitLabDropInMode;
}

export async function parseGitLabRecords(source: string, options: ParseGitLabRecordsOptions = {}): Promise<readonly string[]> {
  const mode = options.mode ?? "demo";
  const records = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (records.length === 0) {
    throw new Error("at least one BRANCH0. record is required");
  }
  for (const record of records) {
    if (!record.startsWith(branchTextWrapperPrefix)) {
      throw new Error("records.br0 accepts exact BRANCH0. wrappers only");
    }
    if (!isBranchTextWrapper(record)) {
      throw new Error("records.br0 accepts bounded unpadded base64url BRANCH0. wrappers only");
    }
    if (mode === "live") {
      await validateLiveBranchRecord(record);
    }
  }
  return records;
}

export async function makeGitLabFiles(
  records: readonly string[],
  sourceCommit: string,
  generatedAt: number,
  mode: GitLabDropInMode = "demo"
): Promise<readonly GitLabDropInFile[]> {
  const recordsContent = `${records.join("\n")}\n`;
  const manifest = {
    schema: "branch.repository-dropin/0",
    carrier: "gitlab",
    mode,
    locator: branchBootstrapLocator,
    markers: branchPublicationMarkers(),
    records_path: ".branch/records.br0",
    badge_path: ".branch/ribbon.svg",
    root_readme_snippet: makeRootReadmeSnippet().trimEnd(),
    gitlab_project_description: gitLabProjectDescription,
    gitlab_project_topics: gitLabProjectTopics,
    generated_at: generatedAt,
    source_commit: sourceCommit || undefined,
    record_count: records.length,
    records_sha256: await sha256Hex(recordsContent),
    diagnostics: {
      authority: "unsigned GitLab metadata only; signed BootstrapBeacon bytes remain authoritative",
      validation: mode === "demo" ? "fixture records are not live beacons" : "live records validated before archive generation"
    },
    tool: "branch-admin-front/0"
  };

  return [
    {
      path: ".branch/records.br0",
      type: "text/plain",
      content: recordsContent
    },
    {
      path: ".branch/manifest.json",
      type: "application/json",
      content: `${JSON.stringify(dropUndefined(manifest), null, 2)}\n`
    },
    {
      path: ".branch/README.md",
      type: "text/markdown",
      content: makeDropInReadme(mode)
    },
    {
      path: ".branch/ribbon.svg",
      type: "image/svg+xml",
      content: makeRibbonSvg()
    }
  ];
}

export function makeGitLabArchive(files: readonly GitLabDropInFile[]): Uint8Array<ArrayBuffer> {
  assertDropInArchivePaths(files);
  return makeStoredZipArchive(files);
}

export function makeGitLabBundle(files: readonly GitLabDropInFile[]): string {
  return files.map((file) => `===== ${file.path} =====\n${file.content}`).join("\n\n");
}

async function validateLiveBranchRecord(record: string): Promise<void> {
  if (record === defaultBranchWrapper) {
    throw new Error("live GitLab drop-in refuses the demo BRANCH0 fixture");
  }
  await assertValidBranchTextBootstrapBeacon(record);
}

function makeDropInReadme(mode: GitLabDropInMode): string {
  const modeNote = mode === "demo"
    ? "This generated bundle is a demo fixture. Replace records.br0 with current signed bootstrap.beacon wrappers before treating it as live discovery material."
    : "This bundle was generated from live signed bootstrap.beacon wrappers accepted by the local tool.";

  return `# Carry the Ribbon

B.R.A.N.C.H. — Blue Ribbon Autonomous Network for Carrier Hopping

Independent technical tribute to the Blue Ribbon Online Free Speech Campaign.
This repository does not imply affiliation with or endorsement by the Electronic
Frontier Foundation.

The Blue Ribbon is alive again.
From symbol to protocol.
The ribbon no longer merely hangs on the Web. It becomes a route through it.

Search locator: ${branchBootstrapLocator}
Search markers: ${branchPublicationMarkers().join(" ")}

${modeNote}

Optional root README badge snippet. Insert it manually into an existing
repository README only if you want the badge visible there. This bundle does not
create or replace a root README.md file.

\`\`\`md
${makeRootReadmeSnippet().trimEnd()}
\`\`\`

Suggested GitLab project description:

\`\`\`text
${gitLabProjectDescription}
\`\`\`

Suggested GitLab project topics:

\`\`\`text
${gitLabProjectTopics.join(", ")}
\`\`\`

The signed records are stored in \`.branch/records.br0\`. Project ownership,
badges, topics, branch names, Pages, and CI status are publication evidence
only. The decoded B.R.A.N.C.H. signed event envelope remains the authority.
`;
}

function assertDropInArchivePaths(files: readonly GitLabDropInFile[]): void {
  for (const file of files) {
    if (file.path === "README.md" || file.path === "/README.md" || file.path === ".gitlab-ci.yml") {
      throw new Error("GitLab drop-in archive must not contain root README.md or .gitlab-ci.yml");
    }
    if (!file.path.startsWith(".branch/")) {
      throw new Error("GitLab drop-in archive files must stay under .branch/");
    }
  }
}

function makeRibbonSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="196" height="20" viewBox="0 0 196 20" role="img" aria-labelledby="title desc">
  <title id="title">B.R.A.N.C.H. - Carry the Ribbon</title>
  <desc id="desc">Compact B.R.A.N.C.H. Blue Ribbon repository carrier badge</desc>
  <clipPath id="r"><rect width="196" height="20" rx="3"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="82" height="20" fill="#24292f"/>
    <rect x="82" width="114" height="20" fill="#0969da"/>
    <path d="M91 4c3.9 0 6.9 2.8 7.7 6.6l-3.5 1.4c-.2-2.5-1.9-4.5-4.2-4.5-2.5 0-4.4 2.2-4.4 4.8 0 2 1.1 3.7 2.8 4.4l-2.4 2.4c-2.4-1.3-4-3.9-4-6.9C83 7.8 86.6 4 91 4Z" fill="#f6f8fa"/>
    <path d="M98.6 10.6c1.8.9 2.9 2.8 2.9 4.9 0 .2 0 .3-.1.5h-3.8c.1-.2.1-.4.1-.6 0-1-.6-1.9-1.5-2.3l2.4-2.5Z" fill="#f6f8fa"/>
  </g>
  <text x="8" y="14" fill="#f6f8fa" font-family="Inter,Arial,sans-serif" font-size="11" font-weight="600">B.R.A.N.C.H.</text>
  <text x="108" y="14" fill="#f6f8fa" font-family="Inter,Arial,sans-serif" font-size="11" font-weight="600">carry ribbon</text>
</svg>
`;
}

function dropUndefined(source: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter((entry) => entry[1] !== undefined));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
