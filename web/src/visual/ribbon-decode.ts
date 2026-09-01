import jsQR from "jsqr";

import { computeModulePitch, computePlacement, type RibbonPlacement } from "./geometry.js";
import { extractBlockPayload, ribbonBlockProfile } from "./ribbon-block.js";
import {
  decodeRibbonFrame,
  type RibbonDecodeResult,
  type RibbonImageData
} from "./ribbon-image.js";
import { readRibbonLocator, type RibbonLocatorHint, type RibbonLocatorRegion } from "./ribbon-locator.js";
import { extractChromaTintCandidates, extractStegoTintCandidates } from "./ribbon-tint.js";
import { extractWatermarkPayload } from "./ribbon-watermark.js";

type JSQRDecoder = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { readonly inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" }
) => { readonly binaryData: readonly number[] } | null;

const decodeQR: JSQRDecoder = jsQR as unknown as JSQRDecoder;

export interface DecodeRibbonImageOptions {
  readonly quietZone: number;
  readonly carrierSize: number;
  readonly placement: RibbonPlacement;
  readonly maxInputPixels?: number;
  readonly maxDirectPixels?: number;
  readonly maxVersionAttempts?: number;
  readonly maxTintCandidates?: number;
  readonly preferredVersion?: number;
}

export interface DecodedRibbonWrapper {
  readonly status: string;
  readonly wrapper: string;
  readonly locator?: RibbonLocatorHint;
  readonly foundRegion?: RibbonLocatorRegion;
}

interface VersionAttempt {
  readonly version: number;
  readonly moduleCount: number;
  readonly modulePitch: number;
  readonly symbolSize: number;
}

const maxQRVersion = 30;
const defaultMaxInputPixels = 4096 * 4096;
const defaultMaxDirectPixels = 1024 * 1024;
const defaultMaxVersionAttempts = 6;
const defaultMaxTintCandidates = 48;
const defaultBlockSourceWidth = 1000;
const defaultBlockSourceHeight = 1500;
const defaultBlockSourceSymbolSize = 657;

export function decodeRibbonImage(image: RibbonImageData, options: DecodeRibbonImageOptions): DecodedRibbonWrapper {
  const validationStatus = validateImageData(image, options.maxInputPixels ?? defaultMaxInputPixels);
  if (validationStatus !== null) {
    return { status: statusLabel(validationStatus), wrapper: "" };
  }

  const locator = readRibbonLocator(image);
  if (locator !== null) {
    const located = decodeWithLocatedHint(image, locator);
    if (located.wrapper !== "") {
      return located;
    }
  }

  const attempts = selectVersionAttempts(image, options);
  const watermarked = decodeWatermarkImage(image, options);
  if (watermarked.wrapper !== "") {
    return watermarked;
  }
  const blocked = decodeBlockImage(image, options, attempts);
  if (blocked.wrapper !== "") {
    return blocked;
  }
  const heuristicBlock = decodeDefaultBlockImage(image, options);
  if (heuristicBlock.wrapper !== "") {
    return heuristicBlock;
  }

  const placedDirect = decodePlacedQRCode(image, options, attempts);
  if (placedDirect.status === "beacon_accepted") {
    return {
      status: "seal decoded",
      wrapper: decodePayload(placedDirect.frame.payload),
      ...(placedDirect.region === undefined ? {} : { foundRegion: placedDirect.region })
    };
  }

  const direct = image.width * image.height <= (options.maxDirectPixels ?? defaultMaxDirectPixels)
    ? decodeQRCodeData(image.data, image.width, image.height)
    : placedDirect;
  if (direct.status === "beacon_accepted") {
    return { status: "seal decoded", wrapper: decodePayload(direct.frame.payload) };
  }

  const tinted = decodeTintImage(image, options, attempts);
  if (tinted.wrapper !== "") {
    return tinted;
  }

  return { status: tinted.status || statusLabel(direct.status), wrapper: "" };
}

function decodeWithLocatedHint(image: RibbonImageData, locator: RibbonLocatorHint): DecodedRibbonWrapper {
  const options: DecodeRibbonImageOptions = {
    quietZone: locator.quietZone,
    carrierSize: locator.symbolSize,
    placement: locator.placement,
    preferredVersion: locator.sourceSymbolVersion,
    maxDirectPixels: 1,
    maxVersionAttempts: 1,
    maxTintCandidates: locator.visualProfile === "ribbon-tint/0" ? 8 : 2
  };
  const attempts = selectVersionAttempts(image, options);
  if (locator.visualProfile === ribbonBlockProfile) {
    for (const region of makeLocatedBlockRegions(image, locator)) {
      const blocked = decodeBlockRegion(image, region);
      if (blocked.wrapper !== "") {
        return {
          ...blocked,
          status: `${blocked.status} locator`,
          locator,
          foundRegion: region
        };
      }
    }
  }

  if (locator.visualProfile === "ribbon-tint/0") {
    const tinted = decodeTintImage(image, options, attempts);
    if (tinted.wrapper !== "") {
      return {
        ...tinted,
        status: `${tinted.status} locator`,
        locator,
        foundRegion: locator.payloadRegion
      };
    }
  }

  const placedDirect = decodePlacedQRCode(image, options, attempts);
  if (placedDirect.status === "beacon_accepted") {
    return {
      status: "seal decoded locator",
      wrapper: decodePayload(placedDirect.frame.payload),
      locator,
      foundRegion: locator.payloadRegion
    };
  }

  return { status: "locator hint rejected", wrapper: "", locator };
}

function makeLocatedBlockRegions(image: RibbonImageData, locator: RibbonLocatorHint): readonly RibbonLocatorRegion[] {
  const scale = Math.min(image.width / locator.sourceWidth, image.height / locator.sourceHeight);
  const scaledSize = Math.max(128, Math.min(4096, Math.round(locator.sourceSymbolSize * scale)));
  const scaledPlacement = {
    ...computePlacement(locator.placement, image.width, image.height, scaledSize),
    size: scaledSize
  };
  return dedupeRegions([makeFullImageBlockRegion(image), locator.payloadRegion, scaledPlacement]);
}

function dedupeRegions(regions: readonly RibbonLocatorRegion[]): readonly RibbonLocatorRegion[] {
  const seen = new Set<string>();
  const unique: RibbonLocatorRegion[] = [];
  for (const region of regions) {
    const key = `${String(region.x)}:${String(region.y)}:${String(region.size)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(region);
  }
  return unique;
}

function decodeBlockImage(
  image: RibbonImageData,
  options: DecodeRibbonImageOptions,
  attempts: readonly VersionAttempt[]
): DecodedRibbonWrapper {
  for (const { symbolSize } of attempts) {
    const placement = computePlacement(options.placement, image.width, image.height, symbolSize);
    const decoded = decodeBlockRegion(image, { ...placement, size: symbolSize });
    if (decoded.wrapper !== "") {
      return decoded;
    }
  }
  return { status: "block extraction failed", wrapper: "" };
}

function decodeDefaultBlockImage(image: RibbonImageData, options: DecodeRibbonImageOptions): DecodedRibbonWrapper {
  for (const region of makeDefaultBlockRegions(image, options)) {
    const decoded = decodeBlockRegion(image, region);
    if (decoded.wrapper !== "") {
      return { ...decoded, status: "block decoded heuristic" };
    }
  }
  return { status: "block extraction failed", wrapper: "" };
}

function decodeWatermarkImage(image: RibbonImageData, options: DecodeRibbonImageOptions): DecodedRibbonWrapper {
  for (const region of makeDefaultWatermarkRegions(image, options)) {
    const frame = extractWatermarkPayload(image, region);
    if (frame === null) {
      continue;
    }
    const decoded = decodeRibbonFrame(frame);
    if (decoded.status !== "beacon_accepted") {
      continue;
    }
    return {
      status: "watermark decoded heuristic",
      wrapper: decodePayload(decoded.frame.payload),
      foundRegion: region
    };
  }
  return { status: "watermark extraction failed", wrapper: "" };
}

function makeDefaultWatermarkRegions(image: RibbonImageData, options: DecodeRibbonImageOptions): readonly RibbonLocatorRegion[] {
  void options;
  return [makeFullImageBlockRegion(image)];
}

function makeDefaultBlockRegions(image: RibbonImageData, options: DecodeRibbonImageOptions): readonly RibbonLocatorRegion[] {
  const scale = Math.min(image.width / defaultBlockSourceWidth, image.height / defaultBlockSourceHeight);
  if (!Number.isFinite(scale) || scale <= 0.1 || scale > 4) {
    return [];
  }
  const scaledSize = Math.round(defaultBlockSourceSymbolSize * scale);
  const sizes = uniqueNumbers([
    scaledSize,
    Math.round(options.carrierSize * scale),
    scaledSize - 2,
    scaledSize + 2
  ]).filter((size) => size >= 128 && size <= image.width && size <= image.height);
  const regions: RibbonLocatorRegion[] = [];
  regions.push(makeFullImageBlockRegion(image));
  for (const size of sizes) {
    regions.push({ ...computePlacement(options.placement, image.width, image.height, size), size });
  }
  return dedupeRegions(regions);
}

function makeFullImageBlockRegion(image: RibbonImageData): RibbonLocatorRegion & { readonly width: number; readonly height: number } {
  return {
    x: 0,
    y: 0,
    size: Math.min(image.width, image.height),
    width: image.width,
    height: image.height
  };
}

function decodeBlockRegion(image: RibbonImageData, region: RibbonLocatorRegion): DecodedRibbonWrapper {
  const frame = extractBlockPayload(image, region);
  if (frame === null) {
    return { status: "block extraction failed", wrapper: "" };
  }
  const decoded = decodeRibbonFrame(frame);
  if (decoded.status !== "beacon_accepted") {
    return { status: statusLabel(decoded.status), wrapper: "" };
  }
  return {
    status: "block decoded",
    wrapper: decodePayload(decoded.frame.payload),
    foundRegion: region
  };
}

function uniqueNumbers(values: readonly number[]): readonly number[] {
  const seen = new Set<number>();
  const unique: number[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function decodeTintImage(
  image: RibbonImageData,
  options: DecodeRibbonImageOptions,
  attempts: readonly VersionAttempt[]
): DecodedRibbonWrapper {
  let decodedCandidates = 0;
  const maxCandidates = options.maxTintCandidates ?? defaultMaxTintCandidates;
  for (const { version, moduleCount, modulePitch, symbolSize } of attempts) {
    const placement = computePlacement(options.placement, image.width, image.height, symbolSize);
    const candidates = [
      ...extractStegoTintCandidates(image, placement, moduleCount, modulePitch, options.quietZone),
      ...extractChromaTintCandidates(image, placement, moduleCount, modulePitch, options.quietZone)
    ];
    for (const candidate of candidates) {
      if (decodedCandidates >= maxCandidates) {
        return { status: "tint extraction failed", wrapper: "" };
      }
      decodedCandidates += 1;
      const decoded = decodeQRCodeData(candidate.data, candidate.width, candidate.height);
      if (decoded.status === "beacon_accepted") {
        return {
          status: `tint decoded v${String(version)}`,
          wrapper: decodePayload(decoded.frame.payload),
          foundRegion: { ...placement, size: symbolSize }
        };
      }
    }
  }
  return { status: "tint extraction failed", wrapper: "" };
}

function decodePlacedQRCode(
  image: RibbonImageData,
  options: DecodeRibbonImageOptions,
  attempts: readonly VersionAttempt[]
): RibbonDecodeResult & { readonly region?: RibbonLocatorRegion } {
  for (const { symbolSize } of attempts) {
    const placement = computePlacement(options.placement, image.width, image.height, symbolSize);
    const candidate = cropSquare(image, placement.x, placement.y, symbolSize);
    const decoded = decodeQRCodeData(candidate.data, candidate.width, candidate.height);
    if (decoded.status === "beacon_accepted") {
      return { ...decoded, region: { ...placement, size: symbolSize } };
    }
  }
  return { status: "no_carrier_detected" };
}

function selectVersionAttempts(image: RibbonImageData, options: DecodeRibbonImageOptions): readonly VersionAttempt[] {
  const attempts: Array<VersionAttempt & { readonly score: number }> = [];
  for (let version = 1; version <= maxQRVersion; version += 1) {
    const moduleCount = 21 + (version - 1) * 4;
    let modulePitch = 0;
    try {
      modulePitch = computeModulePitch(moduleCount, options.quietZone, options.carrierSize);
    } catch {
      continue;
    }
    const symbolSize = (moduleCount + options.quietZone * 2) * modulePitch;
    if (symbolSize > image.width || symbolSize > image.height) {
      continue;
    }
    attempts.push({
      version,
      moduleCount,
      modulePitch,
      symbolSize,
      score: Math.abs(options.carrierSize - symbolSize)
    });
  }

  const preferred = Number.isInteger(options.preferredVersion)
    ? attempts.find((attempt) => attempt.version === options.preferredVersion)
    : undefined;
  const ordered = attempts
    .sort((left, right) => left.score - right.score || left.version - right.version)
    .filter((attempt) => attempt.version !== preferred?.version);
  const selected = preferred === undefined ? ordered : [preferred, ...ordered];

  return selected.slice(0, options.maxVersionAttempts ?? defaultMaxVersionAttempts);
}

function cropSquare(image: RibbonImageData, sourceX: number, sourceY: number, size: number): RibbonImageData {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const sourceOffset = ((sourceY + y) * image.width + sourceX) * 4;
    data.set(image.data.subarray(sourceOffset, sourceOffset + size * 4), y * size * 4);
  }
  return { width: size, height: size, data };
}

function validateImageData(image: RibbonImageData, maxPixels: number): RibbonDecodeResult["status"] | null {
  if (image.width <= 0 || image.height <= 0 || image.width * image.height > maxPixels) {
    return "visual_sync_failed";
  }
  if (image.data.byteLength !== image.width * image.height * 4) {
    return "visual_sync_failed";
  }
  return null;
}

function decodeQRCodeData(data: Uint8ClampedArray, width: number, height: number): RibbonDecodeResult {
  const code = decodeQR(data, width, height, { inversionAttempts: "attemptBoth" });
  if (code === null) {
    return { status: "no_carrier_detected" };
  }
  return decodeRibbonFrame(Uint8Array.from(code.binaryData));
}

function decodePayload(payload: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    return "";
  }
}

function statusLabel(status: RibbonDecodeResult["status"]): string {
  return status.replaceAll("_", " ");
}
