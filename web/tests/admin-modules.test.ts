import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultBranchWrapper } from "../src/admin/defaults.js";
import { makeBundle, makeGitHubArchive, makeGitHubFiles, parseBranchRecords } from "../src/admin/github-dropin.js";
import { makeAutoDecodeCandidates, maxAutoDecodeCandidates } from "../src/admin/ribbon-auto-decode.js";
import { handleWorkerMessage } from "../src/admin/ribbon-decode-worker.js";
import {
  classifyTransformLabResult,
  makeFailedTransformLabResult,
  makeTransformLabJson,
  maxTransformLabMatrixPresets,
  selectTransformLabPresets,
  transformLabPresets,
  type TransformImageSummary
} from "../src/admin/transform-lab.js";
import { boxBlur, fitInsideWithPadding, resizeNearest, sharpen } from "../src/visual/corpus.js";
import { computeModulePitch, computePlacement, type RibbonPlacement } from "../src/visual/geometry.js";
import { decodeRibbonImage } from "../src/visual/ribbon-decode.js";
import {
  embedRibbonLocator,
  makeRibbonLocatorHint,
  readRibbonLocator,
  ribbonLocatorProfile,
  ribbonTintProfile
} from "../src/visual/ribbon-locator.js";
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

void test("transform lab preset catalog covers service-processing simulations", () => {
  const ids = transformLabPresets.map((preset) => preset.id);

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
  assert(ids.includes("thumbnail-center-crop"));
  assert(ids.includes("thumbnail-fit-padding"));
  assert(ids.includes("rotate-90"));
  assert(ids.includes("rotate-180"));
  assert(ids.includes("color-shift"));
  assert(ids.includes("blur"));
  assert(ids.includes("sharpen"));
  assert(ids.includes("screenshot-scale-2"));
  assert(ids.includes("pinterest-like-simulation"));
  assert.equal(transformLabPresets.find((preset) => preset.id === "pinterest-like-simulation")?.label, "Pinterest-like simulation");
});

void test("transform lab selection is bounded and has stable fallback", () => {
  assert.deepEqual(selectTransformLabPresets("selected", "jpeg-60").map((preset) => preset.id), ["jpeg-60"]);
  assert.deepEqual(selectTransformLabPresets("selected", "missing").map((preset) => preset.id), ["jpeg-80"]);
  assert.equal(selectTransformLabPresets("matrix", "jpeg-60").length, maxTransformLabMatrixPresets);
});

void test("transform lab classification requires exact baseline match and reports unverified signatures honestly", () => {
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
    decodeStatus: "seal decoded auto",
    decodedWrapper: defaultBranchWrapper,
    wrapperSha256: "abc",
    baselineSha256: "abc",
    signatureValidation: "not_available",
    durationMs: 12.6
  } as const;
  const exact = classifyTransformLabResult(exactInput);
  const mismatch = classifyTransformLabResult({
    ...exactInput,
    decodedWrapper: "BRANCH0.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    wrapperSha256: "def"
  });

  assert.equal(exact.status, "exact-unverified");
  assert.equal(exact.signatureValidation, "not_available");
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
  const json = makeTransformLabJson([failed], "2026-09-01T00:00:00.000Z");

  assert.match(json, /branch\.transform-lab\/0/);
  assert.match(json, /webp encoder unsupported/);
  assert.doesNotMatch(json, /BRANCH0\.|data:|blob:|source\.png|samples\//);
  assert.doesNotMatch(json, /"data"\s*:/);
});

void test("auto decode candidate search is bounded and does not need UI geometry hints", () => {
  const candidates = makeAutoDecodeCandidates(1000, 1500);

  assert(candidates.length > 1);
  assert(candidates.length <= maxAutoDecodeCandidates);
  const firstCandidate = candidates[0] ?? failCandidate();
  assert.equal(firstCandidate.carrierSize, 720);
  assert.equal(firstCandidate.maxDirectPixels, 1);
  assert.equal(firstCandidate.preferredVersion, 10);
  assert.equal(new Set(candidates.map((candidate) => candidate.placement)).size, 5);
});

void test("auto decode prioritizes default generated tint images", () => {
  const quietZone = 8;
  const carrierSize = 720;
  const symbol = generateRibbonSymbol(defaultBranchWrapper, quietZone, carrierSize);
  const image = makePlacedStegoImage(
    1000,
    1500,
    symbol.modules,
    symbol.diagnostics.modulePitch,
    quietZone,
    "bottom-right"
  );
  const firstCandidate = makeAutoDecodeCandidates(image.width, image.height)[0];

  assert.equal((firstCandidate ?? failCandidate()).preferredVersion, symbol.diagnostics.sourceSymbolVersion);
  const decoded = decodeRibbonImage(image, firstCandidate ?? failCandidate());

  assert.equal(decoded.status, `tint decoded v${String(symbol.diagnostics.sourceSymbolVersion)}`);
  assert.equal(decoded.wrapper, defaultBranchWrapper);
});

void test("ribbon locator embeds pixel magic and accelerates hidden tint decode", () => {
  const quietZone = 8;
  const carrierSize = 720;
  const placement = "bottom-right";
  const symbol = generateRibbonSymbol(defaultBranchWrapper, quietZone, carrierSize);
  const source = makePlacedStegoImage(
    1000,
    1500,
    symbol.modules,
    symbol.diagnostics.modulePitch,
    quietZone,
    placement
  );
  const hint = makeRibbonLocatorHint({
    visualProfile: ribbonTintProfile,
    quietZone,
    modulePitch: symbol.diagnostics.modulePitch,
    sourceSymbolVersion: symbol.diagnostics.sourceSymbolVersion,
    moduleCount: symbol.diagnostics.moduleCount,
    placement,
    outputWidth: source.width,
    outputHeight: source.height
  });
  const image = embedRibbonLocator(source, hint);
  const locator = readRibbonLocator(image) ?? failLocator();

  assert.equal(locator.profile, ribbonLocatorProfile);
  assert.equal(locator.visualProfile, ribbonTintProfile);
  assert.deepEqual(locator.payloadRegion, hint.payloadRegion);

  const decoded = decodeRibbonImage(image, {
    quietZone: 4,
    carrierSize: 320,
    placement: "top-left",
    maxDirectPixels: 1,
    maxVersionAttempts: 1,
    maxTintCandidates: 2
  });

  assert.equal(decoded.status, `tint decoded v${String(symbol.diagnostics.sourceSymbolVersion)} locator`);
  assert.equal(decoded.wrapper, defaultBranchWrapper);
  assert.deepEqual(decoded.foundRegion, hint.payloadRegion);
});

void test("ribbon locator remains non-authoritative without signed payload recovery", () => {
  const image = makeNoCarrierImage(1000, 1500);
  const located = embedRibbonLocator(image, {
    profile: ribbonLocatorProfile,
    visualProfile: ribbonTintProfile,
    quietZone: 8,
    modulePitch: 9,
    sourceModulePitch: 9,
    sourceSymbolVersion: 10,
    moduleCount: 57,
    placement: "bottom-right",
    symbolSize: 657,
    sourceSymbolSize: 657,
    sourceWidth: 1000,
    sourceHeight: 1500,
    payloadRegion: { x: 303, y: 803, size: 657 }
  });
  const locator = readRibbonLocator(located);
  const decoded = decodeRibbonImage(located, {
    quietZone: 8,
    carrierSize: 720,
    placement: "bottom-right",
    maxDirectPixels: 1,
    maxVersionAttempts: 1,
    maxTintCandidates: 2
  });

  assert.equal(locator?.profile, ribbonLocatorProfile);
  assert.equal(decoded.wrapper, "");
  assert.notEqual(decoded.status, "beacon_accepted");
});

void test("ribbon locator pixel magic survives nearest resize as a geometry hint", () => {
  const quietZone = 8;
  const carrierSize = 720;
  const placement = "bottom-right";
  const symbol = generateRibbonSymbol(defaultBranchWrapper, quietZone, carrierSize);
  const source = makePlacedStegoImage(
    1000,
    1500,
    symbol.modules,
    symbol.diagnostics.modulePitch,
    quietZone,
    placement
  );
  const image = embedRibbonLocator(source, makeRibbonLocatorHint({
    visualProfile: ribbonTintProfile,
    quietZone,
    modulePitch: symbol.diagnostics.modulePitch,
    sourceSymbolVersion: symbol.diagnostics.sourceSymbolVersion,
    moduleCount: symbol.diagnostics.moduleCount,
    placement,
    outputWidth: source.width,
    outputHeight: source.height
  }));
  const resized = resizeNearest(image, 750, 1125);
  const locator = readRibbonLocator(resized) ?? failLocator();

  assert.equal(locator.sourceWidth, 1000);
  assert.equal(locator.sourceHeight, 1500);
  assert.equal(locator.sourceModulePitch, symbol.diagnostics.modulePitch);
  assert.equal(locator.modulePitch, 7);
  assert.equal(locator.placement, placement);
});

void test("transform lab rgba helpers preserve bounds", () => {
  const image = makeNoCarrierImage(12, 10);

  assert.deepEqual(fitInsideWithPadding(image, 8, 8).data.byteLength, 8 * 8 * 4);
  assert.deepEqual(boxBlur(image, 1).data.byteLength, image.data.byteLength);
  assert.deepEqual(sharpen(image).data.byteLength, image.data.byteLength);
  assert.throws(() => boxBlur(image, 8), /blur radius outside/);
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

function makePlacedStegoImage(
  width: number,
  height: number,
  modules: { readonly size: number; get(x: number, y: number): unknown },
  modulePitch: number,
  quietZone: number,
  placement: RibbonPlacement
): RibbonImageData {
  const image = makeNoCarrierImage(width, height);
  const symbolSize = symbolSizePixels(modules.size, quietZone, modulePitch);
  const position = computePlacement(placement, width, height, symbolSize);

  for (let moduleY = 0; moduleY < modules.size; moduleY += 1) {
    for (let moduleX = 0; moduleX < modules.size; moduleX += 1) {
      const bit = modules.get(moduleX, moduleY) ? 1 : 0;
      for (let y = position.y + (moduleY + quietZone) * modulePitch; y < position.y + (moduleY + quietZone + 1) * modulePitch; y += 1) {
        for (let x = position.x + (moduleX + quietZone) * modulePitch; x < position.x + (moduleX + quietZone + 1) * modulePitch; x += 1) {
          image.data[(y * width + x) * 4 + 2] = (image.data[(y * width + x) * 4 + 2] ?? 0) & 0xfe | bit;
        }
      }
    }
  }

  return image;
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

function failPreset(): never {
  throw new Error("missing test preset");
}

function failCandidate(): never {
  throw new Error("missing auto decode candidate");
}

function failLocator(): never {
  throw new Error("missing ribbon locator");
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
