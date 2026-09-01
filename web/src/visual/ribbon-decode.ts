import jsQR from "jsqr";

import { computeModulePitch, computePlacement, type RibbonPlacement } from "./geometry.js";
import {
  decodeRibbonFrame,
  type RibbonDecodeResult,
  type RibbonImageData
} from "./ribbon-image.js";
import { extractChromaTintCandidates, extractStegoTintCandidates } from "./ribbon-tint.js";

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
}

export interface DecodedRibbonWrapper {
  readonly status: string;
  readonly wrapper: string;
}

export function decodeRibbonImage(image: RibbonImageData, options: DecodeRibbonImageOptions): DecodedRibbonWrapper {
  const direct = decodeQRCodeData(image.data, image.width, image.height);
  if (direct.status === "beacon_accepted") {
    return { status: "seal decoded", wrapper: decodePayload(direct.frame.payload) };
  }

  const tinted = decodeTintImage(image, options);
  if (tinted.wrapper !== "") {
    return tinted;
  }

  return { status: tinted.status || statusLabel(direct.status), wrapper: "" };
}

function decodeTintImage(image: RibbonImageData, options: DecodeRibbonImageOptions): DecodedRibbonWrapper {
  for (let version = 1; version <= 30; version += 1) {
    const moduleCount = 21 + (version - 1) * 4;
    const modulePitch = computeModulePitch(moduleCount, options.quietZone, options.carrierSize);
    const symbolSize = (moduleCount + options.quietZone * 2) * modulePitch;
    if (symbolSize > image.width || symbolSize > image.height) {
      continue;
    }

    const placement = computePlacement(options.placement, image.width, image.height, symbolSize);
    const candidates = [
      ...extractStegoTintCandidates(image, placement, moduleCount, modulePitch, options.quietZone),
      ...extractChromaTintCandidates(image, placement, moduleCount, modulePitch, options.quietZone)
    ];
    for (const candidate of candidates) {
      const decoded = decodeQRCodeData(candidate.data, candidate.width, candidate.height);
      if (decoded.status === "beacon_accepted") {
        return { status: `tint decoded v${String(version)}`, wrapper: decodePayload(decoded.frame.payload) };
      }
    }
  }
  return { status: "tint extraction failed", wrapper: "" };
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
