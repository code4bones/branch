import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const adminHtmlPath = resolve(process.cwd(), "public/admin/index.html");
const adminAppPath = resolve(process.cwd(), "src/admin/App.tsx");
const adminMainPath = resolve(process.cwd(), "src/admin/main.tsx");
const adminStorePath = resolve(process.cwd(), "src/admin/store.tsx");
const ribbonToolPath = resolve(process.cwd(), "src/admin/components/RibbonTool.tsx");
const githubToolPath = resolve(process.cwd(), "src/admin/components/GitHubTool.tsx");
const githubDiscoveryPath = resolve(process.cwd(), "src/admin/github-discovery.ts");
const discoveryGitHubPath = resolve(process.cwd(), "src/discovery/github.ts");
const discoveryClientPath = resolve(process.cwd(), "src/discovery/client.ts");
const githubDropInPath = resolve(process.cwd(), "src/admin/github-dropin.ts");
const publicationProfilePath = resolve(process.cwd(), "src/discovery/publication-profile.ts");
const defaultsPath = resolve(process.cwd(), "src/admin/defaults.ts");
const canvasImagePath = resolve(process.cwd(), "src/visual/canvas-image.ts");
const ribbonRenderPath = resolve(process.cwd(), "src/visual/ribbon-render.ts");
const ribbonDecodePath = resolve(process.cwd(), "src/visual/ribbon-decode.ts");
const ribbonBlockPath = resolve(process.cwd(), "src/visual/ribbon-block.ts");
const ribbonDecodeClientPath = resolve(process.cwd(), "src/admin/ribbon-decode-client.ts");
const ribbonDecodeWorkerPath = resolve(process.cwd(), "src/admin/ribbon-decode-worker.ts");
const ribbonAutoDecodePath = resolve(process.cwd(), "src/admin/ribbon-auto-decode.ts");
const transformLabPath = resolve(process.cwd(), "src/admin/transform-lab.ts");
const transformLabRunnerPath = resolve(process.cwd(), "src/admin/transform-lab-runner.ts");
const adminCssPath = resolve(process.cwd(), "public/admin/admin.css");
const buildScriptPath = resolve(process.cwd(), "scripts/build-static.mjs");
const nginxConfigPath = resolve(process.cwd(), "../deployments/nginx/branch.undoo.ru.conf");

void test("admin surface is static and open", async () => {
  const html = await readFile(adminHtmlPath, "utf8");

  assert.match(html, /\/admin\/admin-app\.js/);
  assert.match(html, /id="admin-root"/);
  assert.doesNotMatch(html, /\/vendor\/qrcode-browser\.js/);
  assert.doesNotMatch(html, /\/vendor\/jsqr\.js/);
  assert.doesNotMatch(html, /\/admin\/admin\.js/);
  assert.doesNotMatch(html, /login|password|token/i);
});

void test("admin surface is scaffolded by React TypeScript source", async () => {
  const app = await readFile(adminAppPath, "utf8");
  const main = await readFile(adminMainPath, "utf8");
  const store = await readFile(adminStorePath, "utf8");
  const ribbonTool = await readFile(ribbonToolPath, "utf8");
  const githubTool = await readFile(githubToolPath, "utf8");
  const publicationProfile = await readFile(publicationProfilePath, "utf8");
  const defaults = await readFile(defaultsPath, "utf8");

  assert.match(main, /createRoot/);
  assert.match(app, /Blue Ribbon Autonomous Network for Carrier Hopping/);
  assert.match(app, /AdminStoreProvider/);
  assert.match(store, /zustand\/vanilla/);
  assert.match(store, /defaultBranchWrapper/);
  assert.match(store, /githubDiscoveryDefaultQuery/);
  assert.match(store, /export type RibbonTab = "encode" \| "decode"/);
  assert.match(store, /export type GitHubTab = "generate" \| "check"/);
  assert.match(store, /ribbonTab: "encode"/);
  assert.match(store, /githubTab: "generate"/);
  assert.match(store, /setRibbonTab/);
  assert.match(store, /setGitHubTab/);
  assert.match(store, /transformLab/);
  assert.match(store, /progress: null/);
  assert.match(store, /setTransformLabProgress/);
  assert.match(ribbonTool, /id="ribbon-tab-encode"/);
  assert.match(ribbonTool, /id="ribbon-tab-decode"/);
  assert.match(ribbonTool, /aria-controls="ribbon-panel-encode"/);
  assert.match(ribbonTool, /id="ribbon-panel-decode"/);
  assert.match(ribbonTool, /RibbonEncodePanel/);
  assert.match(ribbonTool, /RibbonDecodePanel/);
  assert.match(ribbonTool, /TransformLabPanel/);
  assert.match(ribbonTool, /id="transform-preset"/);
  assert.match(ribbonTool, /id="run-transform-preset"/);
  assert.match(ribbonTool, /id="run-transform-matrix"/);
  assert.match(ribbonTool, /id="cancel-transform-lab"/);
  assert.match(ribbonTool, /Transform Lab progress/);
  assert.match(ribbonTool, /running \$\{String\(progress\.current\)\}\/\$\{String\(progress\.total\)\}/);
  assert.match(ribbonTool, /id="copy-transform-report"/);
  assert.match(ribbonTool, /id="download-transform-report"/);
  assert.match(ribbonTool, /decodeRibbonImageAutoWithWorker/);
  assert.match(ribbonTool, /onDecodeImageChange/);
  assert.match(ribbonTool, /drawDecodePreview/);
  assert.match(ribbonTool, /drawFoundRegion/);
  assert.match(ribbonTool, /id="cover-image"/);
  assert.match(ribbonTool, /RibbonOutputSizeControls/);
  assert.doesNotMatch(ribbonTool, /idPrefix|carrier-placement|readPlacement|quiet-zone|carrier-size/);
  assert.doesNotMatch(ribbonTool, /visual-mode|tint-strength|watermark|ribbonTintProfile|ribbonWatermarkProfile/);
  assert.match(ribbonTool, /id="decode-image"/);
  assert.match(ribbonTool, /id="decoded-wrapper"/);
  assert.match(ribbonTool, /className="tool-grid is-active ribbon-tool"/);
  assert.match(githubTool, /id="github-form"/);
  assert.match(githubTool, /id="github-tab-generate"/);
  assert.match(githubTool, /id="github-tab-check"/);
  assert.match(githubTool, /id="github-panel-generate"/);
  assert.match(githubTool, /id="github-panel-check"/);
  assert.match(githubTool, /id="github-mode"/);
  assert.match(githubTool, /Demo fixture/);
  assert.match(githubTool, /Live publishable/);
  assert.match(githubTool, /Generate relay beacon/);
  assert.match(githubTool, /createBootstrapBeaconWrapper/);
  assert.match(githubTool, /id="relay-endpoint-uri"/);
  assert.match(githubTool, /id="github-badge-snippet"/);
  assert.match(githubTool, /Optional root README snippet/);
  assert.match(githubTool, /makeRootReadmeSnippet/);
  assert.match(githubTool, /id="github-discovery-form"/);
  assert.match(githubTool, /id="github-discovery-query"/);
  assert.match(githubTool, /id="github-discovery-forks"/);
  assert.match(githubTool, /discoverClientBootstrapBeacons/);
  assert.match(githubTool, /createGitHubSearchCarrier/);
  assert.match(githubTool, /github-discovery-fallback/);
  assert.match(githubTool, /acceptedCount/);
  assert.match(githubTool, /relayEndpoint/);
  assert.match(githubTool, /formatUnixSeconds/);
  assert.match(githubTool, /className="tool-grid is-active"/);
  assert.match(githubTool, /downloadBytes\(makeGitHubArchive/);
  assert.match(publicationProfile, /branchBootstrapLocator = "branchbootstrapv0"/);
  assert.match(publicationProfile, /githubPrimaryLocatorQuery/);
  assert.match(publicationProfile, /githubRepositoryTopics/);
  assert.match(defaults, /branch-github-dropin\.zip/);
  assert.doesNotMatch(`${app}\n${store}\n${ribbonTool}`, /\bfetch\s*\(/);
  assert.doesNotMatch(`${app}\n${store}\n${ribbonTool}\n${githubTool}`, /XMLHttpRequest|localStorage|indexedDB/);
});

void test("admin ribbon logic is split into typed visual modules", async () => {
  const canvasImage = await readFile(canvasImagePath, "utf8");
  const render = await readFile(ribbonRenderPath, "utf8");
  const decode = await readFile(ribbonDecodePath, "utf8");
  const block = await readFile(ribbonBlockPath, "utf8");
  const decodeClient = await readFile(ribbonDecodeClientPath, "utf8");
  const decodeWorker = await readFile(ribbonDecodeWorkerPath, "utf8");
  const autoDecode = await readFile(ribbonAutoDecodePath, "utf8");
  const transformLab = await readFile(transformLabPath, "utf8");
  const transformLabRunner = await readFile(transformLabRunnerPath, "utf8");

  assert.match(render, /generateRibbonSymbol/);
  assert.match(render, /encodeRibbonFrame/);
  assert.match(render, /drawCoverImage/);
  assert.match(render, /renderRibbonImage/);
  assert.match(render, /drawBlockPayload/);
  assert.match(decode, /decodeRibbonImage/);
  assert.match(decode, /decodeRibbonFrame/);
  assert.match(decode, /extractBlockPayload/);
  assert.match(block, /ribbon-block\/0\.draft/);
  assert.match(block, /BRBLK0/);
  assert.match(block, /blockRepeatCandidates/);
  assert.match(decodeClient, /new Worker/);
  assert.match(decodeClient, /postMessage\(request, \[request\.image\.data\]\)/);
  assert.match(decodeClient, /decodeRibbonImage\(image, options\)/);
  assert.match(decodeClient, /AbortSignal/);
  assert.match(decodeWorker, /handleWorkerMessage/);
  assert.match(decodeWorker, /decodeRibbonImage\(image, message\.options\)/);
  assert.match(autoDecode, /maxAutoDecodeCandidates/);
  assert.match(autoDecode, /decodeRibbonImageAutoWithWorker/);
  assert.match(autoDecode, /decodeRibbonImageWithWorker/);
  assert.match(transformLab, /Pinterest-like simulation/);
  assert.doesNotMatch(transformLab, /thumbnail-center-crop|thumbnail-fit-padding/);
  assert.match(transformLab, /branch\.transform-lab\/0/);
  assert.match(transformLab, /sourceProfile/);
  assert.match(transformLab, /foundRegion/);
  assert.doesNotMatch(transformLab, /locatorProfile/);
  assert.match(transformLab, /TransformLabProgress/);
  assert.match(transformLabRunner, /canvas\.toBlob/);
  assert.match(transformLabRunner, /decoded\.foundRegion/);
  assert.match(transformLabRunner, /onProgress/);
  assert.match(transformLabRunner, /request\.decode\(request\.image, request\.decodeOptions, request\.signal\)/);
  assert.match(canvasImage, /willReadFrequently:\s*true/);
  assert.match(render, /willReadFrequently:\s*true/);
  assert.match(transformLabRunner, /willReadFrequently:\s*true/);
  assert.doesNotMatch(`${render}\n${decode}\n${block}\n${decodeClient}\n${decodeWorker}\n${autoDecode}\n${transformLab}\n${transformLabRunner}`, /window\.BranchQRCode|window\.jsQR|fetch\s*\(|XMLHttpRequest|WebSocket|ribbon-tint|ribbon-watermark|ribbon-locator/);
});

void test("admin github generator stays offline and produces local drop-in paths", async () => {
  const source = await readFile(githubDropInPath, "utf8");

  assert.match(source, /makeGitHubArchive/);
  assert.match(source, /mode/);
  assert.match(source, /records_sha256/);
  assert.match(source, /makeBadgeSnippet/);
  assert.match(source, /branchBootstrapLocator/);
  assert.match(source, /root_readme_snippet/);
  assert.match(source, /github_repository_topics/);
  assert.match(source, /live GitHub drop-in refuses the demo BRANCH0 fixture/);
  assert.match(source, /\.branch\/records\.br0/);
  assert.match(source, /\.branch\/manifest\.json/);
  assert.match(source, /\.branch\/ribbon\.svg/);
  assert.match(source, /\.github\/workflows\/branch-carry-ribbon\.yml/);
  assert.match(source, /drop-in lint/);
  assert.match(source, /pull_request/);
  assert.match(source, /permissions:[\s\S]*contents: read/);
  assert.doesNotMatch(source, /api\.github\.com|GITHUB_TOKEN|actions\/checkout|contents: write|schedule:/);
});

void test("admin github discovery uses bounded public GitHub API reads", async () => {
  const facade = await readFile(githubDiscoveryPath, "utf8");
  const source = await readFile(discoveryGitHubPath, "utf8");
  const client = await readFile(discoveryClientPath, "utf8");

  assert.match(facade, /export \* from "\.\.\/discovery\/github\.js"/);
  assert.match(source, /https:\/\/api\.github\.com\/search\/repositories/);
  assert.match(source, /githubPrimaryLocatorQuery/);
  assert.match(source, /githubLegacyMarkerQuery/);
  assert.match(source, /createGitHubSearchCarrier/);
  assert.match(client, /SearchCarrier/);
  assert.match(client, /discoverClientBootstrapBeacons/);
  assert.match(client, /fallbackQuery/);
  assert.match(client, /dedupeObservations/);
  assert.match(source, /\.branch\/records\.br0/);
  assert.match(source, /x-ratelimit-remaining/);
  assert.match(source, /403/);
  assert.match(source, /429/);
  assert.match(source, /incomplete_results/);
  assert.match(source, /fork:true/);
  assert.match(source, /default branch/);
  assert.match(source, /extractBranchTextWrappers/);
  assert.doesNotMatch(`${source}\n${client}`, /GITHUB_TOKEN|Authorization|raw\.githubusercontent\.com|contents: write|localStorage|indexedDB|WebSocket/);
});

void test("admin css remains dark and bounded", async () => {
  const source = await readFile(adminCssPath, "utf8");

  assert.match(source, /--admin-bg: #0a0d11/);
  assert.match(source, /color: var\(--admin-ink\)/);
  assert.match(source, /border-radius: 8px/);
  assert.match(source, /overflow-wrap: anywhere/);
  assert.doesNotMatch(source, /color-scheme:\s*light/);
});

void test("static build bundles the React admin app from local dependencies", async () => {
  const source = await readFile(buildScriptPath, "utf8");

  assert.match(source, /src\/admin\/main\.tsx/);
  assert.match(source, /src\/admin\/ribbon-decode-worker\.ts/);
  assert.match(source, /admin-app\.js/);
  assert.match(source, /ribbon-decode-worker\.js/);
  assert.match(source, /esbuild/);
  assert.doesNotMatch(source, /qrcode-browser\.js|vendor\/jsqr\.js|createRequire/);
});

void test("nginx csp permits local cover image object urls", async () => {
  const source = await readFile(nginxConfigPath, "utf8");

  assert.match(source, /img-src 'self' data: blob:/);
  assert.match(source, /connect-src 'self' https:\/\/api\.github\.com/);
  assert.match(source, /worker-src 'self'/);
  assert.doesNotMatch(source, /raw\.githubusercontent\.com|\*/);
});
