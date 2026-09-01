import { decodeRibbonImageWithWorker } from "./ribbon-decode-client.js";
import type { DecodeRibbonImageOptions, DecodedRibbonWrapper } from "../visual/ribbon-decode.js";
import type { RibbonPlacement } from "../visual/geometry.js";
import type { RibbonImageData } from "../visual/ribbon-image.js";

export const maxAutoDecodeCandidates = 48;

const autoPlacements: readonly RibbonPlacement[] = ["bottom-right", "center", "top-left", "top-right", "bottom-left"];
const autoQuietZones: readonly number[] = [8, 4, 12];
const autoPreferredVersions: readonly number[] = [10, 11, 9, 12, 8, 13];
const directDecodeMaxPixels = 1024 * 1024;

export async function decodeRibbonImageAutoWithWorker(
  image: RibbonImageData,
  signal?: AbortSignal
): Promise<DecodedRibbonWrapper> {
  let lastStatus = "no carrier detected";
  for (const candidate of makeAutoDecodeCandidates(image.width, image.height)) {
    if (signal?.aborted === true) {
      return { status: "decode cancelled", wrapper: "" };
    }
    const result = await decodeRibbonImageWithWorker(image, candidate, undefined, signal);
    if (result.wrapper !== "") {
      return {
        status: `${result.status} auto`,
        wrapper: result.wrapper,
        ...(result.locator === undefined ? {} : { locator: result.locator }),
        ...(result.foundRegion === undefined ? {} : { foundRegion: result.foundRegion })
      };
    }
    lastStatus = result.status;
  }
  return { status: `auto decode failed: ${lastStatus}`, wrapper: "" };
}

export function makeAutoDecodeCandidates(width: number, height: number): readonly DecodeRibbonImageOptions[] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return [];
  }

  const minSide = Math.min(width, height);
  const candidates: DecodeRibbonImageOptions[] = [];

  appendFastTintCandidates(candidates, minSide);

  if (width * height <= directDecodeMaxPixels) {
    candidates.push({
      quietZone: 8,
      carrierSize: boundCarrierSize(minSide),
      placement: "bottom-right",
      maxDirectPixels: width * height,
      maxVersionAttempts: 6,
      maxTintCandidates: 24
    });
  }

  for (const carrierSize of estimateCarrierSizes(minSide)) {
    for (const quietZone of autoQuietZones) {
      for (const placement of autoPlacements) {
        candidates.push({
          quietZone,
          carrierSize,
          placement,
          maxDirectPixels: 1,
          maxVersionAttempts: 4,
          maxTintCandidates: 16
        });
      }
    }
  }

  return dedupeDecodeCandidates(candidates).slice(0, maxAutoDecodeCandidates);
}

export function makeAutoDecodeBaseOptions(width: number, height: number): DecodeRibbonImageOptions {
  return {
    quietZone: 8,
    carrierSize: boundCarrierSize(Math.min(width, height)),
    placement: "bottom-right",
    maxDirectPixels: Math.min(width * height, 4096 * 4096),
    maxVersionAttempts: 6,
    maxTintCandidates: 24
  };
}

function appendFastTintCandidates(candidates: DecodeRibbonImageOptions[], minSide: number): void {
  for (const carrierSize of estimateCarrierSizes(minSide)) {
    for (const quietZone of autoQuietZones) {
      for (const placement of autoPlacements) {
        for (const preferredVersion of autoPreferredVersions) {
          candidates.push({
            quietZone,
            carrierSize,
            placement,
            preferredVersion,
            maxDirectPixels: 1,
            maxVersionAttempts: 1,
            maxTintCandidates: 2
          });
        }
      }
    }
  }
}

function estimateCarrierSizes(minSide: number): readonly number[] {
  return uniqueNumbers([
    boundCarrierSize(720),
    boundCarrierSize(Math.round(minSide * 0.72)),
    boundCarrierSize(640),
    boundCarrierSize(minSide),
    boundCarrierSize(Math.round(minSide * 0.75)),
    boundCarrierSize(Math.round(minSide * 0.5))
  ]);
}

function boundCarrierSize(size: number): number {
  return Math.max(320, Math.min(1600, size));
}

function dedupeDecodeCandidates(candidates: readonly DecodeRibbonImageOptions[]): readonly DecodeRibbonImageOptions[] {
  const seen = new Set<string>();
  const unique: DecodeRibbonImageOptions[] = [];
  for (const candidate of candidates) {
    const key = [
      String(candidate.quietZone),
      String(candidate.carrierSize),
      candidate.placement,
      String(candidate.maxDirectPixels),
      String(candidate.maxVersionAttempts),
      String(candidate.maxTintCandidates),
      String(candidate.preferredVersion ?? "")
    ].join(":");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
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
