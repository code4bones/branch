import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultBranchWrapper } from "../src/admin/defaults.js";
import { makeBundle, makeGitHubArchive, makeGitHubFiles, parseBranchRecords } from "../src/admin/github-dropin.js";
import { handleWorkerMessage } from "../src/admin/ribbon-decode-worker.js";
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

void test("github drop-in archive contains repository paths", () => {
  const records = parseBranchRecords(defaultBranchWrapper);
  const files = makeGitHubFiles(records, "", 1_789_000_000);
  const archive = makeGitHubArchive(files);

  assert.deepEqual(readZipEntryPaths(archive), [
    ".branch/records.br0",
    ".branch/manifest.json",
    ".branch/README.md",
    ".branch/ribbon.svg",
    ".github/workflows/branch-carry-ribbon.yml"
  ]);
  assert.equal(readZipFileText(archive, ".branch/records.br0"), `${defaultBranchWrapper}\n`);
  assert.match(readZipFileText(archive, ".branch/manifest.json"), /branch\.repository-dropin\/0/);
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

void test("ribbon decode worker reconstructs generated tint wrapper", () => {
  const quietZone = 8;
  const carrierSize = 720;
  const symbol = generateRibbonSymbol(defaultBranchWrapper, quietZone, carrierSize);
  const image = makeStegoImage(symbol.modules, symbol.diagnostics.modulePitch, quietZone);
  const response = handleWorkerMessage({
    type: "decode-ribbon-image",
    requestId: 1,
    image: {
      width: image.width,
      height: image.height,
      data: copyToArrayBuffer(image.data)
    },
    options: {
      quietZone,
      carrierSize,
      placement: "top-left",
      preferredVersion: symbol.diagnostics.sourceSymbolVersion
    }
  });

  assert.equal(response.type, "decode-ribbon-image-result");
  assert.equal(response.result.status, `tint decoded v${String(symbol.diagnostics.sourceSymbolVersion)}`);
  assert.equal(response.result.wrapper, defaultBranchWrapper);
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

function copyToArrayBuffer(data: Uint8ClampedArray): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8ClampedArray(buffer).set(data);
  return buffer;
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
  let offset = 0;
  while (offset < archive.byteLength - 22) {
    if (view.getUint32(offset, true) !== 0x04034b50) {
      break;
    }
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(archive.subarray(nameStart, nameStart + nameLength));
    if (name === path) {
      return decoder.decode(archive.subarray(contentStart, contentStart + compressedSize));
    }
    offset = contentStart + compressedSize;
  }
  throw new Error(`zip entry not found: ${path}`);
}
