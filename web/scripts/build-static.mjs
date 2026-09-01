import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "public");
const target = resolve(root, "dist");

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

await bundleReactAdmin();
await bundleRibbonDecodeWorker();

async function bundleReactAdmin() {
  await build({
    entryPoints: [resolve(root, "src/admin/main.tsx")],
    outfile: resolve(target, "admin/admin-app.js"),
    bundle: true,
    format: "iife",
    target: ["es2022"],
    platform: "browser",
    sourcemap: false,
    minify: true,
    legalComments: "none"
  });
}

async function bundleRibbonDecodeWorker() {
  await build({
    entryPoints: [resolve(root, "src/admin/ribbon-decode-worker.ts")],
    outfile: resolve(target, "admin/ribbon-decode-worker.js"),
    bundle: true,
    format: "iife",
    target: ["es2022"],
    platform: "browser",
    sourcemap: false,
    minify: true,
    legalComments: "none"
  });
}
