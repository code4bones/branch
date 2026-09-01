import { decodeRibbonImageWithWorker } from "./ribbon-decode-client.js";
import type { DecodeRibbonImageOptions, DecodedRibbonWrapper } from "../visual/ribbon-decode.js";
import type { RibbonImageData } from "../visual/ribbon-image.js";

export const maxAutoDecodeCandidates = 1;

export async function decodeRibbonImageAutoWithWorker(
  image: RibbonImageData,
  signal?: AbortSignal
): Promise<DecodedRibbonWrapper> {
  if (signal?.aborted === true) {
    return { status: "decode cancelled", wrapper: "" };
  }
  return decodeRibbonImageWithWorker(image, makeAutoDecodeBaseOptions(image.width, image.height), undefined, signal);
}

export function makeAutoDecodeCandidates(width: number, height: number): readonly DecodeRibbonImageOptions[] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return [];
  }
  return [makeAutoDecodeBaseOptions(width, height)];
}

export function makeAutoDecodeBaseOptions(width: number, height: number): DecodeRibbonImageOptions {
  void width;
  void height;
  return {};
}
