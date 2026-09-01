import { defaultBranchWrapper } from "./defaults.js";

const branchPrefix = "BRANCH0.";
const maxRecordBytes = 64 * 1024;
const encoder = new TextEncoder();

export interface GitHubDropInFile {
  readonly path: string;
  readonly type: string;
  readonly content: string;
}

export function parseBranchRecords(source: string): readonly string[] {
  const records = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (records.length === 0) {
    throw new Error("at least one BRANCH0. record is required");
  }
  for (const record of records) {
    if (!record.startsWith(branchPrefix)) {
      throw new Error("records.br0 accepts exact BRANCH0. wrappers only");
    }
    if (encoder.encode(record).byteLength > maxRecordBytes) {
      throw new Error("record too large");
    }
  }
  return records;
}

export function makeGitHubFiles(records: readonly string[], sourceCommit: string, generatedAt: number): readonly GitHubDropInFile[] {
  const manifest = {
    schema: "branch.repository-dropin/0",
    markers: ["BRANCH0", "branch/connectivity/0", "branch-bootstrap-v0", "carry-the-ribbon"],
    records_path: ".branch/records.br0",
    badge_path: ".branch/ribbon.svg",
    generated_at: generatedAt,
    source_commit: sourceCommit || undefined,
    tool: "branch-admin-front/0"
  };

  return [
    {
      path: ".branch/records.br0",
      type: "text/plain",
      content: `${records.join("\n")}\n`
    },
    {
      path: ".branch/manifest.json",
      type: "application/json",
      content: `${JSON.stringify(dropUndefined(manifest), null, 2)}\n`
    },
    {
      path: ".branch/README.md",
      type: "text/markdown",
      content: makeDropInReadme()
    },
    {
      path: ".branch/ribbon.svg",
      type: "image/svg+xml",
      content: makeRibbonSvg()
    },
    {
      path: ".github/workflows/branch-carry-ribbon.yml",
      type: "text/yaml",
      content: makeWorkflow()
    }
  ];
}

export function makeBundle(files: readonly GitHubDropInFile[]): string {
  return files.map((file) => `===== ${file.path} =====\n${file.content}`).join("\n\n");
}

function makeDropInReadme(): string {
  return `# Carry the Ribbon

B.R.A.N.C.H. — Blue Ribbon Autonomous Network for Carrier Hopping

Independent technical tribute to the Blue Ribbon Online Free Speech Campaign.
This repository does not imply affiliation with or endorsement by the Electronic
Frontier Foundation.

The Blue Ribbon is alive again.
From symbol to protocol.
The ribbon no longer merely hangs on the Web. It becomes a route through it.

Search markers: BRANCH0 branch/connectivity/0 branch-bootstrap-v0 carry-the-ribbon

The signed records are stored in \`.branch/records.br0\`. Repository ownership,
badges, topics, branch names, and CI status are publication evidence only. The
decoded B.R.A.N.C.H. signed event envelope remains the authority.
`;
}

function makeRibbonSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="96" viewBox="0 0 360 96" role="img" aria-labelledby="title desc">
  <title id="title">Blue Ribbon - Carry the Ribbon</title>
  <desc id="desc">B.R.A.N.C.H. repository carrier badge</desc>
  <rect width="360" height="96" rx="8" fill="#07111d"/>
  <path d="M54 17c15 0 28 11 32 26l-16 8c-1-10-8-18-16-18-9 0-16 8-16 18 0 8 5 15 12 17l-12 12c-11-6-18-17-18-30 0-18 15-33 34-33Z" fill="#64a8ff"/>
  <path d="M83 43c6 3 10 10 10 18 0 13-11 24-24 24H48l16-16h5c5 0 9-4 9-9 0-4-2-7-5-8l10-9Z" fill="#57d2c6"/>
  <text x="112" y="38" fill="#f4f7fb" font-family="Inter,Arial,sans-serif" font-size="22" font-weight="700">Carry the Ribbon</text>
  <text x="112" y="64" fill="#9eaaba" font-family="Inter,Arial,sans-serif" font-size="14">BRANCH0 branch/connectivity/0</text>
</svg>
`;
}

function makeWorkflow(): string {
  return `name: Carry the Ribbon

on:
  push:
    paths:
      - ".branch/**"
      - "README.md"
  workflow_dispatch:
  schedule:
    - cron: "17 4 * * 1"

permissions:
  contents: read

jobs:
  verify-dropin:
    runs-on: ubuntu-latest
    steps:
      - name: Prepare repository workspace
        shell: bash
        run: |
          git init .
          git remote add origin "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"
          git fetch --depth=1 origin "$GITHUB_SHA"
          git checkout --detach FETCH_HEAD
      - name: Verify local B.R.A.N.C.H. carrier files
        shell: bash
        run: |
          test -f .branch/records.br0
          test -f .branch/manifest.json
          grep -Eq '^BRANCH0\\.' .branch/records.br0
          grep -q 'branch.repository-dropin/0' .branch/manifest.json
`;
}

function dropUndefined(source: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter((entry) => entry[1] !== undefined));
}

export function defaultGitHubRecords(): string {
  return defaultBranchWrapper;
}
