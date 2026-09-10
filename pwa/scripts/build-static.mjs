import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "public");
const target = resolve(root, "dist");
const packageManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const buildDefinitions = {
  __BRANCH_PWA_VERSION__: JSON.stringify(packageManifest.version)
};

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
await stampShellAssetVersion();

await bundleApp();
await bundleServiceWorker();

async function stampShellAssetVersion() {
  const indexPath = resolve(target, "index.html");
  const sourceHtml = await readFile(indexPath, "utf8");
  const stampedHtml = sourceHtml.replaceAll("__BRANCH_PWA_ASSET_VERSION__", encodeURIComponent(packageManifest.version));
  if (stampedHtml === sourceHtml || stampedHtml.includes("__BRANCH_PWA_ASSET_VERSION__")) {
    throw new Error("PWA shell asset version placeholder was not fully stamped");
  }
  await writeFile(indexPath, stampedHtml, "utf8");
}

async function bundleApp() {
  // main.tsx imports "antd/dist/reset.css", so esbuild also emits a CSS file
  // next to the JS outfile using the same basename (pwa-app.css). The
  // hand-authored stylesheet lives at public/pwa.css specifically so it
  // never shares that basename and gets silently overwritten by this step.
  await build({
    entryPoints: [resolve(root, "src/main.tsx")],
    outfile: resolve(target, "pwa-app.js"),
    bundle: true,
    format: "iife",
    target: ["es2022"],
    platform: "browser",
    define: buildDefinitions,
    sourcemap: false,
    minify: true,
    legalComments: "none"
  });
}

async function bundleServiceWorker() {
  await build({
    entryPoints: [resolve(root, "src/sw.ts")],
    outfile: resolve(target, "sw.js"),
    bundle: true,
    format: "iife",
    target: ["es2022"],
    platform: "browser",
    define: buildDefinitions,
    sourcemap: false,
    minify: true,
    legalComments: "none"
  });
}
