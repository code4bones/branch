import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "public");
const target = resolve(root, "dist");

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

await bundleCommonJS(
  resolve(root, "node_modules/qrcode/lib/browser.js"),
  resolve(target, "vendor/qrcode-browser.js"),
  "BranchQRCode"
);
await cp(
  resolve(root, "node_modules/jsqr/dist/jsQR.js"),
  resolve(target, "vendor/jsqr.js")
);

async function bundleCommonJS(entryPath, outputPath, globalName) {
  const modules = [];
  const idsByPath = new Map();

  async function collect(filePath) {
    if (idsByPath.has(filePath)) {
      return idsByPath.get(filePath);
    }

    const id = modules.length;
    idsByPath.set(filePath, id);
    const sourceText = await readFile(filePath, "utf8");
    const dependencies = [...sourceText.matchAll(/require\(["']([^"']+)["']\)/g)].map(
      (match) => match[1]
    );

    const mapping = {};
    modules.push({ id, filePath, mapping, sourceText });
    for (const dependency of dependencies) {
      const resolved = resolveModule(filePath, dependency);
      mapping[dependency] = await collect(resolved);
    }
    return id;
  }

  await collect(entryPath);
  const body = modules
    .map(
      (module) =>
        `${module.id}: [function(require, module, exports) {\n${module.sourceText}\n}, ${JSON.stringify(
          module.mapping
        )}]`
    )
    .join(",\n");

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `(function(global) {
  const modules = {
${body}
  };
  const cache = {};
  function load(id) {
    if (cache[id]) return cache[id].exports;
    const moduleRecord = modules[id];
    if (!moduleRecord) throw new Error("missing bundled module " + id);
    const module = { exports: {} };
    cache[id] = module;
    function localRequire(name) {
      const mapped = moduleRecord[1][name];
      if (mapped === undefined) throw new Error("missing bundled dependency " + name);
      return load(mapped);
    }
    moduleRecord[0](localRequire, module, module.exports);
    return module.exports;
  }
  global.${globalName} = load(0);
})(window);
`,
    "utf8"
  );
}

function resolveModule(fromPath, specifier) {
  const localRequire = createRequire(pathToFileURL(fromPath));
  return localRequire.resolve(specifier);
}
