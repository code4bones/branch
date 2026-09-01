import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const adminHtmlPath = resolve(process.cwd(), "public/admin/index.html");
const adminJsPath = resolve(process.cwd(), "public/admin/admin.js");
const adminCssPath = resolve(process.cwd(), "public/admin/admin.css");
const buildScriptPath = resolve(process.cwd(), "scripts/build-static.mjs");
const nginxConfigPath = resolve(process.cwd(), "../deployments/nginx/branch.undoo.ru.conf");

void test("admin surface is static and open", async () => {
  const html = await readFile(adminHtmlPath, "utf8");

  assert.match(html, /\/admin\/admin\.js/);
  assert.match(html, /\/vendor\/qrcode-browser\.js/);
  assert.match(html, /id="cover-image"/);
  assert.match(html, /id="carrier-placement"/);
  assert.doesNotMatch(html, /login|password|token/i);
});

void test("admin ribbon generator mirrors ribbon-seal frame constants", async () => {
  const source = await readFile(adminJsPath, "utf8");

  assert.match(source, /BRANCH0\./);
  assert.match(source, /BRIMG0/);
  assert.match(source, /ribbon-seal\/0/);
  assert.match(source, /payloadLimit = 768/);
  assert.match(source, /0x82f63b78/);
  assert.match(source, /loadLocalImage/);
  assert.match(source, /FileReader/);
  assert.match(source, /readAsDataURL/);
  assert.match(source, /drawCoverImage/);
  assert.match(source, /drawCoverPreview/);
  assert.match(source, /cover loaded/);
  assert.match(source, /clearRibbonDownload/);
  assert.match(source, /computePlacement/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /XMLHttpRequest|localStorage|indexedDB/);
});

void test("admin github generator stays offline and produces local drop-in paths", async () => {
  const source = await readFile(adminJsPath, "utf8");

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

void test("static build bundles qrcode from local dependency", async () => {
  const source = await readFile(buildScriptPath, "utf8");

  assert.match(source, /node_modules\/qrcode\/lib\/browser\.js/);
  assert.match(source, /qrcode-browser\.js/);
  assert.match(source, /createRequire/);
});

void test("nginx csp permits local cover image object urls", async () => {
  const source = await readFile(nginxConfigPath, "utf8");

  assert.match(source, /img-src 'self' data: blob:/);
});
