import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultBranchWrapper } from "../src/admin/defaults.js";
import { makeBundle, makeGitHubFiles, parseBranchRecords } from "../src/admin/github-dropin.js";
import { computeModulePitch, computePlacement } from "../src/visual/geometry.js";
import { decodeRibbonImage } from "../src/visual/ribbon-decode.js";
import { generateRibbonSymbol, symbolSizePixels } from "../src/visual/ribbon-render.js";
import { extractStegoTintCandidates } from "../src/visual/ribbon-tint.js";
import { decodeRibbonSeal, type RibbonImageData } from "../src/visual/ribbon-image.js";

void test("github drop-in module validates exact BRANCH0 records and emits local files", () => {
  const records = parseBranchRecords(`# comment\n${defaultBranchWrapper}\n`);
  const files = makeGitHubFiles(records, "abc123", 1_789_000_000);
  const bundle = makeBundle(files);

  assert.deepEqual(records, [defaultBranchWrapper]);
  assert.equal(files[0]?.path, ".branch/records.br0");
  assert.match(bundle, /Blue Ribbon Autonomous Network for Carrier Hopping/);
  assert.match(bundle, /branch.repository-dropin\/0/);
  assert.doesNotMatch(bundle, /GITHUB_TOKEN|contents: write/);
});

void test("github drop-in module rejects non-BRANCH0 records", () => {
  assert.throws(() => parseBranchRecords("not-a-wrapper"), /records\.br0 accepts exact BRANCH0/);
});

void test("visual geometry preserves bounded placement and pitch", () => {
  assert.equal(computeModulePitch(57, 8, 720), 9);
  assert.deepEqual(computePlacement("bottom-right", 1000, 1500, 657), { x: 303, y: 803 });
});

void test("tint stego extractor reconstructs generated wrapper from PNG LSB modules", () => {
  const quietZone = 8;
  const carrierSize = 720;
  const symbol = generateRibbonSymbol(defaultBranchWrapper, quietZone, carrierSize);
  const image = makeStegoImage(symbol.modules, symbol.diagnostics.modulePitch, quietZone);
  const decoded = decodeRibbonImage(image, {
    quietZone,
    carrierSize,
    placement: "top-left",
    preferredVersion: symbol.diagnostics.sourceSymbolVersion
  });

  assert.equal(decoded.status, `tint decoded v${String(symbol.diagnostics.sourceSymbolVersion)}`);
  assert.equal(decoded.wrapper, defaultBranchWrapper);
});

void test("large undecodable ribbon image uses bounded decode work", () => {
  const image = makeNoCarrierImage(1200, 1500);
  const decoded = decodeRibbonImage(image, {
    quietZone: 8,
    carrierSize: 720,
    placement: "bottom-right",
    maxDirectPixels: 1,
    maxVersionAttempts: 2,
    maxTintCandidates: 8
  });

  assert.equal(decoded.status, "tint extraction failed");
  assert.equal(decoded.wrapper, "");
});

void test("raw stego candidates remain valid ribbon seal images", () => {
  const quietZone = 8;
  const carrierSize = 720;
  const symbol = generateRibbonSymbol(defaultBranchWrapper, quietZone, carrierSize);
  const image = makeStegoImage(symbol.modules, symbol.diagnostics.modulePitch, quietZone);
  const candidate = extractStegoTintCandidates(
    image,
    { x: 0, y: 0 },
    symbol.diagnostics.moduleCount,
    symbol.diagnostics.modulePitch,
    quietZone
  )[0];

  assert.equal(candidate === undefined ? "missing" : decodeRibbonSeal(candidate).status, "beacon_accepted");
});

function makeStegoImage(
  modules: { readonly size: number; get(x: number, y: number): unknown },
  modulePitch: number,
  quietZone: number
): RibbonImageData {
  const size = symbolSizePixels(modules.size, quietZone, modulePitch);
  const data = new Uint8ClampedArray(size * size * 4);
  data.fill(128);
  for (let index = 3; index < data.length; index += 4) {
    data[index] = 255;
  }

  for (let moduleY = 0; moduleY < modules.size; moduleY += 1) {
    for (let moduleX = 0; moduleX < modules.size; moduleX += 1) {
      const bit = modules.get(moduleX, moduleY) ? 1 : 0;
      for (let y = (moduleY + quietZone) * modulePitch; y < (moduleY + quietZone + 1) * modulePitch; y += 1) {
        for (let x = (moduleX + quietZone) * modulePitch; x < (moduleX + quietZone + 1) * modulePitch; x += 1) {
          data[(y * size + x) * 4 + 2] = 128 | bit;
        }
      }
    }
  }

  return { width: size, height: size, data };
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
