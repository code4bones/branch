import { extractBlockPayload } from "./ribbon-block.js";
import {
  decodeRibbonFrame,
  type RibbonDecodeResult,
  type RibbonImageData
} from "./ribbon-image.js";

export interface DecodeRibbonImageOptions {
  readonly maxInputPixels?: number;
}

export interface RibbonFoundRegion {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly width: number;
  readonly height: number;
}

export interface DecodedRibbonWrapper {
  readonly status: string;
  readonly wrapper: string;
  readonly foundRegion?: RibbonFoundRegion;
}

const defaultMaxInputPixels = 4096 * 4096;

export function decodeRibbonImage(image: RibbonImageData, options: DecodeRibbonImageOptions = {}): DecodedRibbonWrapper {
  const validationStatus = validateImageData(image, options.maxInputPixels ?? defaultMaxInputPixels);
  if (validationStatus !== null) {
    return { status: statusLabel(validationStatus), wrapper: "" };
  }

  const region = makeFullImageBlockRegion(image);
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

function makeFullImageBlockRegion(image: RibbonImageData): RibbonFoundRegion {
  return {
    x: 0,
    y: 0,
    size: Math.min(image.width, image.height),
    width: image.width,
    height: image.height
  };
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
