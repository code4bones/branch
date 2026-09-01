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
const githubDropInPath = resolve(process.cwd(), "src/admin/github-dropin.ts");
const defaultsPath = resolve(process.cwd(), "src/admin/defaults.ts");
const ribbonRenderPath = resolve(process.cwd(), "src/visual/ribbon-render.ts");
const ribbonDecodePath = resolve(process.cwd(), "src/visual/ribbon-decode.ts");
const ribbonDecodeClientPath = resolve(process.cwd(), "src/admin/ribbon-decode-client.ts");
const ribbonDecodeWorkerPath = resolve(process.cwd(), "src/admin/ribbon-decode-worker.ts");
const ribbonTintPath = resolve(process.cwd(), "src/visual/ribbon-tint.ts");
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
  const defaults = await readFile(defaultsPath, "utf8");

  assert.match(main, /createRoot/);
  assert.match(app, /Blue Ribbon Autonomous Network for Carrier Hopping/);
  assert.match(app, /AdminStoreProvider/);
  assert.match(store, /zustand\/vanilla/);
  assert.match(store, /defaultBranchWrapper/);
  assert.match(store, /export type RibbonTab = "encode" \| "decode"/);
  assert.match(store, /ribbonTab: "encode"/);
  assert.match(store, /setRibbonTab/);
  assert.match(store, /tintStrength: "0"/);
  assert.match(ribbonTool, /id="ribbon-tab-encode"/);
  assert.match(ribbonTool, /id="ribbon-tab-decode"/);
  assert.match(ribbonTool, /aria-controls="ribbon-panel-encode"/);
  assert.match(ribbonTool, /id="ribbon-panel-decode"/);
  assert.match(ribbonTool, /RibbonEncodePanel/);
  assert.match(ribbonTool, /RibbonDecodePanel/);
  assert.match(ribbonTool, /id="cover-image"/);
  assert.match(ribbonTool, /id="visual-mode"/);
  assert.match(ribbonTool, /id="tint-strength"/);
  assert.match(ribbonTool, /min="0"/);
  assert.match(ribbonTool, /max="24"/);
  assert.match(ribbonTool, /step="1"/);
  assert.match(ribbonTool, /controlId\(idPrefix, "carrier-placement"\)/);
  assert.match(ribbonTool, /idPrefix=""/);
  assert.match(ribbonTool, /idPrefix="decode"/);
  assert.match(ribbonTool, /id="decode-image"/);
  assert.match(ribbonTool, /id="decoded-wrapper"/);
  assert.match(ribbonTool, /decodeRibbonImageWithWorker/);
  assert.match(ribbonTool, /className="tool-grid is-active ribbon-tool"/);
  assert.match(githubTool, /id="github-form"/);
  assert.match(githubTool, /className="tool-grid is-active"/);
  assert.match(githubTool, /downloadBytes\(makeGitHubArchive/);
  assert.match(defaults, /branch-github-dropin\.zip/);
  assert.doesNotMatch(`${app}\n${store}\n${ribbonTool}\n${githubTool}`, /\bfetch\s*\(/);
  assert.doesNotMatch(`${app}\n${store}\n${ribbonTool}\n${githubTool}`, /XMLHttpRequest|localStorage|indexedDB/);
});

void test("admin ribbon logic is split into typed visual modules", async () => {
  const render = await readFile(ribbonRenderPath, "utf8");
  const decode = await readFile(ribbonDecodePath, "utf8");
  const decodeClient = await readFile(ribbonDecodeClientPath, "utf8");
  const decodeWorker = await readFile(ribbonDecodeWorkerPath, "utf8");
  const tint = await readFile(ribbonTintPath, "utf8");

  assert.match(render, /generateRibbonSymbol/);
  assert.match(render, /encodeRibbonFrame/);
  assert.match(render, /drawCoverImage/);
  assert.match(render, /renderRibbonImage/);
  assert.match(decode, /decodeRibbonImage/);
  assert.match(decode, /decodeRibbonFrame/);
  assert.match(decode, /extractStegoTintCandidates/);
  assert.match(decodeClient, /new Worker/);
  assert.match(decodeClient, /postMessage\(request, \[request\.image\.data\]\)/);
  assert.match(decodeClient, /decodeRibbonImage\(image, options\)/);
  assert.match(decodeWorker, /handleWorkerMessage/);
  assert.match(decodeWorker, /decodeRibbonImage\(image, message\.options\)/);
  assert.match(tint, /drawTintQR/);
  assert.match(tint, /extractStegoTintCandidates/);
  assert.match(tint, /extractChromaTintCandidates/);
  assert.doesNotMatch(`${render}\n${decode}\n${decodeClient}\n${decodeWorker}\n${tint}`, /window\.BranchQRCode|window\.jsQR/);
});

void test("admin github generator stays offline and produces local drop-in paths", async () => {
  const source = await readFile(githubDropInPath, "utf8");

  assert.match(source, /makeGitHubArchive/);
  assert.match(source, /\.branch\/records\.br0/);
  assert.match(source, /\.branch\/manifest\.json/);
  assert.match(source, /\.branch\/ribbon\.svg/);
  assert.match(source, /\.github\/workflows\/branch-carry-ribbon\.yml/);
  assert.match(source, /permissions:[\s\S]*contents: read/);
  assert.doesNotMatch(source, /api\.github\.com|GITHUB_TOKEN|actions\/checkout|contents: write/);
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
  assert.match(source, /worker-src 'self'/);
});
