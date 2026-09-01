import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultBranchWrapper } from "../src/admin/defaults.js";
import {
  discoverGitHubDropIns,
  githubDiscoveryConstraints,
  githubDiscoveryDefaultQuery,
  makeGitHubRepositorySearchUrl
} from "../src/admin/github-discovery.js";
import { makeBadgeSnippet, makeBundle, makeGitHubArchive, makeGitHubFiles, parseBranchRecords } from "../src/admin/github-dropin.js";
import {
  branchBootstrapLocator,
  githubRepositoryDescription,
  githubRepositoryTopics,
  makeRootReadmeSnippet
} from "../src/admin/publication-profile.js";
import { makeAutoDecodeBaseOptions, makeAutoDecodeCandidates, maxAutoDecodeCandidates } from "../src/admin/ribbon-auto-decode.js";
import { handleWorkerMessage } from "../src/admin/ribbon-decode-worker.js";
import {
  classifyTransformLabResult,
  makeFailedTransformLabResult,
  makeTransformLabJson,
  maxTransformLabMatrixPresets,
  selectTransformLabPresets,
  transformLabPresets,
  type TransformImageSummary,
  type TransformLabPreset
} from "../src/admin/transform-lab.js";
import { runTransformLab } from "../src/admin/transform-lab-runner.js";
import { createBootstrapBeaconWrapper } from "../src/protocol/v0/bootstrap-beacon.js";
import { extractBranchTextWrappers, isBranchTextWrapper } from "../src/protocol/v0/text-carrier.js";
import { resizeNearest } from "../src/visual/corpus.js";
import { embedBlockPayload, extractBlockPayload, ribbonBlockProfile } from "../src/visual/ribbon-block.js";
import { decodeRibbonImage } from "../src/visual/ribbon-decode.js";
import { branchWrapperBytes, type RibbonImageData } from "../src/visual/ribbon-image.js";
import { generateRibbonSymbol } from "../src/visual/ribbon-render.js";

void test("github drop-in module validates exact BRANCH0 records and emits local files", async () => {
  const records = await parseBranchRecords(`# comment\n${defaultBranchWrapper}\n`);
  const files = await makeGitHubFiles(records, "abc123", 1_789_000_000);
  const bundle = makeBundle(files);

  assert.deepEqual(records, [defaultBranchWrapper]);
  assert.equal(files[0]?.path, ".branch/records.br0");
  assert(!files.some((file) => file.path === "README.md" || file.path === "/README.md"));
  assert(files.every((file) => file.path.startsWith(".branch/") || file.path.startsWith(".github/workflows/")));
  assert.match(bundle, /Blue Ribbon Autonomous Network for Carrier Hopping/);
  assert.match(bundle, /branch.repository-dropin\/0/);
  assert.match(bundle, /branchbootstrapv0/);
  assert.match(bundle, /"locator": "branchbootstrapv0"/);
  assert.match(bundle, /"root_readme_snippet": "\[!\[B\.R\.A\.N\.C\.H\. Blue Ribbon/);
  assert.match(bundle, /"github_repository_description": "B\.R\.A\.N\.C\.H\. bootstrap carrier branchbootstrapv0 carry-the-ribbon"/);
  assert.match(bundle, /"mode": "demo"/);
  assert.match(bundle, /"record_count": 1/);
  assert.match(bundle, /"records_sha256": "[a-f0-9]{64}"/);
  assert.match(bundle, /fixture records are not live beacons/);
  assert.doesNotMatch(bundle, /GITHUB_TOKEN|contents: write/);
});

void test("github drop-in archive contains repository paths", async () => {
  const records = await parseBranchRecords(defaultBranchWrapper);
  const files = await makeGitHubFiles(records, "", 1_789_000_000);
  const archive = makeGitHubArchive(files);

  assert.deepEqual(readZipEntryPaths(archive), [
    ".branch/records.br0",
    ".branch/manifest.json",
    ".branch/README.md",
    ".branch/ribbon.svg",
    ".github/workflows/branch-carry-ribbon.yml"
  ]);
  assert(!readZipEntryPaths(archive).some((path) => path === "README.md" || path === "/README.md"));
  assert(readZipEntryPaths(archive).every((path) => path.startsWith(".branch/") || path.startsWith(".github/workflows/")));
  assert.equal(readZipFileText(archive, ".branch/records.br0"), `${defaultBranchWrapper}\n`);
  assert.match(readZipFileText(archive, ".branch/manifest.json"), /branch\.repository-dropin\/0/);
  assert.match(readZipFileText(archive, ".branch/manifest.json"), /branchbootstrapv0/);
  assert.match(readZipFileText(archive, ".branch/README.md"), /demo fixture/);
  assert.match(readZipFileText(archive, ".branch/README.md"), /does not create or replace a root README\.md file/);
  assert.match(readZipFileText(archive, ".branch/README.md"), /Search locator: branchbootstrapv0/);
  assert.match(readZipFileText(archive, ".branch/README.md"), /\[!\[B\.R\.A\.N\.C\.H\. Blue Ribbon/);
  assert.match(readZipFileText(archive, ".github/workflows/branch-carry-ribbon.yml"), /drop-in lint/);
  assert.match(readZipFileText(archive, ".github/workflows/branch-carry-ribbon.yml"), /branchbootstrapv0/);
  assert.doesNotMatch(readZipFileText(archive, ".github/workflows/branch-carry-ribbon.yml"), /schedule|verify-dropin|contents: write/);
});

void test("github drop-in module rejects non-BRANCH0 records", async () => {
  await assert.rejects(parseBranchRecords("not-a-wrapper"), /records\.br0 accepts exact BRANCH0/);
  await assert.rejects(parseBranchRecords("BRANCH0.abc=", { mode: "demo" }), /bounded unpadded base64url/);
  await assert.rejects(parseBranchRecords(defaultBranchWrapper, { mode: "live" }), /refuses the demo BRANCH0 fixture/);
  assert.doesNotMatch(makeBadgeSnippet(), /branchbootstrapv0/);
  assert.match(makeBadgeSnippet(), /^\[!\[B\.R\.A\.N\.C\.H\. Blue Ribbon/);
  assert.match(makeBadgeSnippet(), /\.branch\/ribbon\.svg/);
  assert.throws(() => {
    makeGitHubArchive([{
      path: "README.md",
      type: "text/markdown",
      content: "# original overwrite\n"
    }]);
  }, /must not contain root README\.md/);
});

void test("github publication profile exposes canonical locator metadata", () => {
  const rootSnippet = makeRootReadmeSnippet();

  assert.equal(branchBootstrapLocator, "branchbootstrapv0");
  assert.match(githubDiscoveryDefaultQuery, /^branchbootstrapv0 in:readme$/);
  assert.doesNotMatch(makeBadgeSnippet(), /branchbootstrapv0/);
  assert.match(rootSnippet, /\[!\[B\.R\.A\.N\.C\.H\. Blue Ribbon/);
  assert.match(rootSnippet, /\n\n<!-- B\.R\.A\.N\.C\.H\. bootstrap carrier: branchbootstrapv0 -->\n$/);
  assert.doesNotMatch(rootSnippet, /\n\nB\.R\.A\.N\.C\.H\. bootstrap carrier: branchbootstrapv0\n$/);
  assert.doesNotMatch(rootSnippet, /BRANCH0 branch\/connectivity\/0 branch-bootstrap-v0 carry-the-ribbon/);
  assert.equal(githubRepositoryDescription, "B.R.A.N.C.H. bootstrap carrier branchbootstrapv0 carry-the-ribbon");
  assert.deepEqual(githubRepositoryTopics, ["branchbootstrapv0", "carry-the-ribbon", "branch-protocol"]);
});

void test("github drop-in live mode accepts signed bootstrap.beacon wrappers", async () => {
  const now = Math.floor(Date.now() / 1000);
  const wrapper = await createBootstrapBeaconWrapper({ now, expiresAt: now + 3600 });
  const records = await parseBranchRecords(wrapper, { mode: "live" });
  const files = await makeGitHubFiles(records, "relay-source", now, "live");

  assert.deepEqual(records, [wrapper]);
  assert.match(files.find((file) => file.path === ".branch/manifest.json")?.content ?? "", /"mode": "live"/);
  assert.match(files.find((file) => file.path === ".branch/README.md")?.content ?? "", /live signed bootstrap\.beacon/);
});

void test("text carrier extracts bounded BRANCH0 wrappers without normalization", () => {
  const source = `noise ${defaultBranchWrapper}\n${defaultBranchWrapper}\nBRANCH0.invalid=`;
  const wrappers = extractBranchTextWrappers(source);

  assert.equal(isBranchTextWrapper(defaultBranchWrapper), true);
  assert.equal(isBranchTextWrapper("BRANCH0.invalid="), false);
  assert.deepEqual(wrappers, [{ wrapper: defaultBranchWrapper, offset: 6 }]);
});

void test("github discovery searches repositories and reads default-branch drop-in records", async () => {
  const fetched: string[] = [];
  const now = Math.floor(Date.now() / 1000);
  const wrapper = await createBootstrapBeaconWrapper({ now, expiresAt: now + 3600 });
  const fetcher = (input: string): Promise<Response> => {
    fetched.push(input);
    if (input.startsWith("https://api.github.com/search/repositories")) {
      return Promise.resolve(jsonResponse({
        total_count: 1,
        incomplete_results: false,
        items: [{
          full_name: "alice/carrier",
          fork: false,
          html_url: "https://github.com/alice/carrier",
          default_branch: "main",
          owner: { login: "alice" },
          name: "carrier"
        }]
      }, { "x-ratelimit-remaining": "9", "x-ratelimit-reset": "1780000000" }));
    }
    return Promise.resolve(jsonResponse({
      type: "file",
      encoding: "base64",
      content: base64Text(`${wrapper}\n`)
    }));
  };
  const report = await discoverGitHubDropIns({
    query: githubDiscoveryDefaultQuery,
    includeForks: false,
    perPage: 5,
    page: 1
  }, fetcher);
  const firstResult = report.results[0] ?? failGitHubDiscoveryResult();

  assert.equal(report.status, "ok");
  assert.equal(report.rateLimitRemaining, "9");
  assert.equal(firstResult.repository, "alice/carrier");
  assert.equal(firstResult.wrapperCount, 1);
  assert.equal(firstResult.acceptedCount, 1);
  assert.equal(firstResult.rejectedCount, 0);
  assert.equal(firstResult.records[0]?.validation, "accepted");
  assert.equal(firstResult.records[0].relayEndpoint, "wss wss://branch.undoo.ru:443/relay/v0");
  assert.equal(firstResult.records[0].expiresAt, now + 3600);
  assert.match(fetched[0] ?? "", /search\/repositories/);
  assert.match(fetched[1] ?? "", /repos\/alice\/carrier\/contents\/.branch\/records.br0\?ref=main/);
  assert(githubDiscoveryConstraints.some((constraint) => constraint.includes("403/429")));
});

void test("github discovery surfaces API rate limits and bounded query construction", async () => {
  const url = makeGitHubRepositorySearchUrl({
    query: githubDiscoveryDefaultQuery,
    includeForks: true,
    perPage: 99,
    page: 99
  });
  const fetcher = (): Promise<Response> =>
    Promise.resolve(jsonResponse({ message: "rate limited" }, { "x-ratelimit-remaining": "0" }, 403));
  const report = await discoverGitHubDropIns({
    query: "BRANCH0",
    includeForks: false,
    perPage: 5,
    page: 1
  }, fetcher);

  assert.match(url, /branchbootstrapv0/);
  assert.match(url, /fork%3Atrue/);
  assert.match(url, /per_page=10/);
  assert.match(url, /page=10/);
  assert.equal(report.status, "rate_limited");
  assert.equal(report.rateLimitRemaining, "0");
});

void test("github discovery keeps rejected bootstrap records visible", async () => {
  const stale = await createBootstrapBeaconWrapper({ now: 1_700_000_000, expiresAt: 1_700_000_001 });
  const fetcher = (input: string): Promise<Response> => {
    if (input.startsWith("https://api.github.com/search/repositories")) {
      return Promise.resolve(jsonResponse({
        total_count: 1,
        incomplete_results: false,
        items: [{
          full_name: "alice/stale-carrier",
          fork: false,
          html_url: "https://github.com/alice/stale-carrier",
          default_branch: "main",
          owner: { login: "alice" },
          name: "stale-carrier"
        }]
      }));
    }
    return Promise.resolve(jsonResponse({
      type: "file",
      encoding: "base64",
      content: base64Text(`${stale}\n`)
    }));
  };
  const report = await discoverGitHubDropIns({
    query: githubDiscoveryDefaultQuery,
    includeForks: false,
    perPage: 5,
    page: 1
  }, fetcher);
  const firstResult = report.results[0] ?? failGitHubDiscoveryResult();

  assert.equal(report.status, "empty");
  assert.equal(firstResult.status, "candidate");
  assert.equal(firstResult.wrapperCount, 1);
  assert.equal(firstResult.acceptedCount, 0);
  assert.equal(firstResult.rejectedCount, 1);
  assert.equal(firstResult.reason, "records.br0 has no accepted bootstrap.beacon records");
  assert.equal(firstResult.records[0]?.validation, "rejected");
  assert.equal(firstResult.records[0].reason, "expired");
});

void test("ribbon symbol generator emits block-profile visual frames", () => {
  const symbol = generateRibbonSymbol(defaultBranchWrapper);
  const decoded = decodeRibbonImage(embedBlockPayload(makeNoCarrierImage(1000, 1500), symbol.frame, fullRegion(1000, 1500)));

  assert.equal(symbol.diagnostics.profile, ribbonBlockProfile);
  assert.equal(symbol.diagnostics.payloadLength, branchWrapperBytes(defaultBranchWrapper).byteLength);
  assert.equal(decoded.status, "block decoded");
  assert.equal(decoded.wrapper, defaultBranchWrapper);
});

void test("ribbon block profile carries exact signed frame bytes through resize", () => {
  const symbol = generateRibbonSymbol(defaultBranchWrapper);
  const source = makeNoCarrierImage(1000, 1500);
  const region = fullRegion(source.width, source.height);
  const blocked = embedBlockPayload(source, symbol.frame, region);
  const resized = resizeNearest(blocked, 750, 1125);
  const decoded = decodeRibbonImage(resized);

  assert.deepEqual(extractBlockPayload(blocked, region), symbol.frame);
  assert.equal(decoded.status, "block decoded");
  assert.equal(decoded.wrapper, defaultBranchWrapper);
  assert.deepEqual(decoded.foundRegion, fullRegion(750, 1125));
});

void test("large undecodable ribbon image uses bounded block-only decode work", () => {
  const image = makeNoCarrierImage(1200, 1500);
  const decoded = decodeRibbonImage(image, makeAutoDecodeBaseOptions(image.width, image.height));

  assert.equal(decoded.status, "block extraction failed");
  assert.equal(decoded.wrapper, "");
});

void test("ribbon decode worker reconstructs generated block wrapper", () => {
  const source = makeNoCarrierImage(1000, 1500);
  const symbol = generateRibbonSymbol(defaultBranchWrapper);
  const image = embedBlockPayload(source, symbol.frame, fullRegion(source.width, source.height));
  const response = handleWorkerMessage({
    type: "decode-ribbon-image",
    requestId: 1,
    image: {
      width: image.width,
      height: image.height,
      data: copyToArrayBuffer(image.data)
    },
    options: makeAutoDecodeBaseOptions(image.width, image.height)
  });

  assert.equal(response.type, "decode-ribbon-image-result");
  assert.equal(response.result.status, "block decoded");
  assert.equal(response.result.wrapper, defaultBranchWrapper);
});

void test("auto decode candidate search is block-only and bounded", () => {
  const candidates = makeAutoDecodeCandidates(1000, 1500);

  assert.equal(maxAutoDecodeCandidates, 1);
  assert.deepEqual(candidates, [{}]);
});

void test("transform lab preset catalog covers service-processing simulations", () => {
  const ids = transformLabPresets.map((preset) => preset.id);
  const idSet = new Set<string>(ids);

  assert.deepEqual(ids.slice(0, maxTransformLabMatrixPresets), ids);
  assert(ids.includes("jpeg-95"));
  assert(ids.includes("jpeg-80"));
  assert(ids.includes("jpeg-60"));
  assert(ids.includes("webp-95"));
  assert(ids.includes("webp-80"));
  assert(ids.includes("webp-60"));
  assert(ids.includes("resize-75"));
  assert(ids.includes("resize-50"));
  assert(ids.includes("resize-75-jpeg-80"));
  assert(ids.includes("screenshot-scale-2"));
  assert(ids.includes("pinterest-like-simulation"));
  assert(!idSet.has("thumbnail-center-crop"));
  assert(!idSet.has("thumbnail-fit-padding"));
  assert(!idSet.has("rotate-90"));
  assert(!idSet.has("blur"));
  assert(!idSet.has("sharpen"));
});

void test("transform lab selection is bounded and has stable fallback", () => {
  assert.deepEqual(selectTransformLabPresets("selected", "jpeg-60").map((preset) => preset.id), ["jpeg-60"]);
  assert.deepEqual(selectTransformLabPresets("selected", "missing").map((preset) => preset.id), ["jpeg-80"]);
  assert.equal(selectTransformLabPresets("matrix", "jpeg-60").length, maxTransformLabMatrixPresets);
});

void test("transform lab runner reports visible per-case progress", async () => {
  const progress: string[] = [];
  const image = makeNoCarrierImage(4, 4);
  const noOpPreset: TransformLabPreset = {
    id: "jpeg-80",
    label: "No-op preset",
    simulation: false,
    operations: []
  };
  const results = await runTransformLab({
    source: image,
    sourceMime: "image/png",
    presets: [noOpPreset],
    decodeOptions: makeAutoDecodeBaseOptions(image.width, image.height),
    decode: () => Promise.resolve({ status: "block decoded", wrapper: defaultBranchWrapper }),
    onProgress: (step) => {
      progress.push(`${String(step.current)}/${String(step.total)} ${step.label}`);
    },
    signal: new AbortController().signal
  });

  assert.deepEqual(progress, ["1/2 Original decode", "2/2 No-op preset"]);
  assert.equal(results.length, 2);
});

void test("transform lab classification requires exact baseline match and reports block regions", () => {
  const summary: TransformImageSummary = {
    width: 1000,
    height: 1500,
    mime: "image/png",
    quality: null,
    byteSize: 1234
  };
  const exactInput = {
    presetId: "jpeg-80",
    presetLabel: "JPEG 80",
    simulation: false,
    input: summary,
    output: { ...summary, mime: "image/jpeg", quality: 0.8 },
    operations: ["JPEG quality 80"],
    decodeStatus: "block decoded",
    decodedWrapper: defaultBranchWrapper,
    wrapperSha256: "abc",
    baselineSha256: "abc",
    signatureValidation: "not_available",
    foundRegion: { x: 0, y: 0, size: 1000, width: 1000, height: 1500, source: "block" },
    durationMs: 12.6
  } as const;
  const exact = classifyTransformLabResult(exactInput);
  const mismatch = classifyTransformLabResult({
    ...exactInput,
    decodedWrapper: "BRANCH0.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    wrapperSha256: "def"
  });

  assert.equal(exact.status, "exact-unverified");
  assert.equal(exact.foundRegion?.source, "block");
  assert.equal(mismatch.status, "mismatch");
});

void test("transform lab report omits image bytes filenames and raw wrappers", () => {
  const summary: TransformImageSummary = {
    width: 1000,
    height: 1500,
    mime: "image/jpeg",
    quality: 0.8,
    byteSize: 4567
  };
  const failed = makeFailedTransformLabResult(
    transformLabPresets[1] ?? failPreset(),
    summary,
    "unsupported",
    5,
    "webp encoder unsupported"
  );
  const json = makeTransformLabJson([failed], "2026-09-01T00:00:00.000Z", ribbonBlockProfile);

  assert.match(json, /branch\.transform-lab\/0/);
  assert.match(json, /ribbon-block\/0\.draft/);
  assert.match(json, /webp encoder unsupported/);
  assert.doesNotMatch(json, /BRANCH0\.|data:|blob:|source\.png|samples\//);
  assert.doesNotMatch(json, /"data"\s*:/);
});

function jsonResponse(value: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers
    }
  });
}

function base64Text(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function makeNoCarrierImage(width: number, height: number): RibbonImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 7;
    data[index + 1] = 17;
    data[index + 2] = 29;
    data[index + 3] = 255;
  }
  return { width, height, data };
}

function fullRegion(width: number, height: number): { readonly x: 0; readonly y: 0; readonly size: number; readonly width: number; readonly height: number } {
  return {
    x: 0,
    y: 0,
    size: Math.min(width, height),
    width,
    height
  };
}

function copyToArrayBuffer(data: Uint8ClampedArray): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8ClampedArray(buffer).set(data);
  return buffer;
}

function failPreset(): never {
  throw new Error("missing test preset");
}

function failGitHubDiscoveryResult(): never {
  throw new Error("missing GitHub discovery result");
}

function readZipEntryPaths(archive: Uint8Array): readonly string[] {
  const decoder = new TextDecoder();
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const endOffset = archive.byteLength - 22;
  assert.equal(view.getUint32(endOffset, true), 0x06054b50);
  const entryCount = view.getUint16(endOffset + 10, true);
  let offset = view.getUint32(endOffset + 16, true);
  const paths: string[] = [];

  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    paths.push(decoder.decode(archive.subarray(nameStart, nameStart + nameLength)));
    offset = nameStart + nameLength + extraLength + commentLength;
  }

  return paths;
}

function readZipFileText(archive: Uint8Array, path: string): string {
  const decoder = new TextDecoder();
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const endOffset = archive.byteLength - 22;
  const entryCount = view.getUint16(endOffset + 10, true);
  let offset = view.getUint32(endOffset + 16, true);

  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const entryPath = decoder.decode(archive.subarray(nameStart, nameStart + nameLength));
    if (entryPath === path) {
      assert.equal(view.getUint32(localHeaderOffset, true), 0x04034b50);
      const localNameLength = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      return decoder.decode(archive.subarray(dataStart, dataStart + compressedSize));
    }
    offset = nameStart + nameLength + extraLength + commentLength;
  }

  throw new Error(`missing zip entry ${path}`);
}
