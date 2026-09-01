import {
  centerCrop,
  fitInsideWithPadding,
  screenshotScale
} from "../visual/corpus.js";
import type { DecodeRibbonImageOptions, DecodedRibbonWrapper } from "../visual/ribbon-decode.js";
import type { RibbonImageData } from "../visual/ribbon-image.js";
import {
  classifyTransformLabResult,
  makeFailedTransformLabResult,
  type SignatureValidationStatus,
  type TransformImageSummary,
  type TransformLabPreset,
  type TransformLabProgress,
  type TransformLabResult,
  type TransformOperation,
  type TransformOutputMime
} from "./transform-lab.js";

export type TransformLabDecode = (
  image: RibbonImageData,
  options: DecodeRibbonImageOptions,
  signal: AbortSignal
) => Promise<DecodedRibbonWrapper>;

export interface RunTransformLabRequest {
  readonly source: RibbonImageData;
  readonly sourceMime: TransformImageSummary["mime"];
  readonly presets: readonly TransformLabPreset[];
  readonly decodeOptions: DecodeRibbonImageOptions;
  readonly decode: TransformLabDecode;
  readonly onProgress?: (progress: TransformLabProgress) => void;
  readonly signal: AbortSignal;
}

interface AppliedTransform {
  readonly image: RibbonImageData;
  readonly mime: TransformImageSummary["mime"];
  readonly quality: number | null;
  readonly byteSize: number | null;
  readonly carrierScale: number;
}

interface TransformUnsupported {
  readonly unsupported: true;
  readonly reason: string;
}

const maxTransformPixels = 4096 * 4096;
const textEncoder = new TextEncoder();

export async function runTransformLab(request: RunTransformLabRequest): Promise<readonly TransformLabResult[]> {
  validateTransformImage(request.source);
  const sourceSummary = summarizeImage(request.source, request.sourceMime, null, null);
  const results: TransformLabResult[] = [];
  const total = request.presets.length + 1;
  await reportProgress(request, { current: 1, total, label: "Original decode" });
  const baseline = await decodeOne({
    image: request.source,
    input: sourceSummary,
    output: sourceSummary,
    presetId: "original",
    presetLabel: "Original decode",
    simulation: false,
    operations: ["original"],
    decodeOptions: request.decodeOptions,
    decode: request.decode,
    baselineSha256: null,
    signal: request.signal
  });
  results.push(baseline.result);

  const baselineSha256 = baseline.wrapperSha256;
  for (const [index, preset] of request.presets.entries()) {
    throwIfAborted(request.signal);
    await reportProgress(request, { current: index + 2, total, label: preset.label });
    const startedAt = performance.now();
    try {
      const transformed = await applyPreset(request.source, request.sourceMime, preset, request.signal);
      if ("unsupported" in transformed) {
        results.push(makeFailedTransformLabResult(preset, sourceSummary, "unsupported", performance.now() - startedAt, transformed.reason));
        continue;
      }

      const outputSummary = summarizeImage(transformed.image, transformed.mime, transformed.quality, transformed.byteSize);
      const decodeOptions = scaleDecodeOptions(request.decodeOptions, transformed.carrierScale, transformed.image);
      const decoded = await decodeOne({
        image: transformed.image,
        input: sourceSummary,
        output: outputSummary,
        presetId: preset.id,
        presetLabel: preset.label,
        simulation: preset.simulation,
        operations: preset.operations.map((operation) => operation.label),
        decodeOptions,
        decode: request.decode,
        baselineSha256,
        signal: request.signal,
        startedAt
      });
      results.push(decoded.result);
    } catch (error) {
      const status = request.signal.aborted ? "cancelled" : "failed";
      results.push(makeFailedTransformLabResult(preset, sourceSummary, status, performance.now() - startedAt, errorMessage(error)));
      if (request.signal.aborted) {
        break;
      }
    }
  }

  return results;
}

async function reportProgress(request: RunTransformLabRequest, progress: TransformLabProgress): Promise<void> {
  request.onProgress?.(progress);
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}

async function decodeOne(
  request: {
    readonly image: RibbonImageData;
    readonly input: TransformImageSummary;
    readonly output: TransformImageSummary;
    readonly presetId: TransformLabResult["presetId"];
    readonly presetLabel: string;
    readonly simulation: boolean;
    readonly operations: readonly string[];
    readonly decodeOptions: DecodeRibbonImageOptions;
    readonly decode: TransformLabDecode;
    readonly baselineSha256: string | null;
    readonly signal: AbortSignal;
    readonly startedAt?: number;
  }
): Promise<{ readonly result: TransformLabResult; readonly wrapperSha256: string | null }> {
  throwIfAborted(request.signal);
  const startedAt = request.startedAt ?? performance.now();
  const decoded = await request.decode(request.image, request.decodeOptions, request.signal);
  throwIfAborted(request.signal);
  const wrapperSha256 = decoded.wrapper === "" ? null : await sha256Text(decoded.wrapper);
  const baselineSha256 = request.presetId === "original" ? wrapperSha256 : request.baselineSha256;
  const signatureValidation = signatureValidationStatus(decoded.wrapper);
  return {
    wrapperSha256,
    result: classifyTransformLabResult({
      presetId: request.presetId,
      presetLabel: request.presetLabel,
      simulation: request.simulation,
      input: request.input,
      output: request.output,
      operations: request.operations,
      decodeStatus: decoded.status,
      decodedWrapper: decoded.wrapper,
      wrapperSha256,
      baselineSha256,
      signatureValidation,
      foundRegion: decoded.foundRegion === undefined
        ? null
        : {
          x: decoded.foundRegion.x,
          y: decoded.foundRegion.y,
          size: decoded.foundRegion.size,
          source: decoded.locator === undefined ? "heuristic" : "locator"
        },
      locatorProfile: decoded.locator?.profile ?? null,
      durationMs: performance.now() - startedAt
    })
  };
}

async function applyPreset(
  source: RibbonImageData,
  sourceMime: TransformImageSummary["mime"],
  preset: TransformLabPreset,
  signal: AbortSignal
): Promise<AppliedTransform | TransformUnsupported> {
  let image = source;
  let mime = sourceMime;
  let quality: number | null = null;
  let byteSize: number | null = null;
  let carrierScale = 1;

  for (const operation of preset.operations) {
    throwIfAborted(signal);
    const output = await applyOperation(image, operation, signal);
    if ("unsupported" in output) {
      return output;
    }
    image = output.image;
    mime = output.mime;
    quality = output.quality;
    byteSize = output.byteSize;
    carrierScale *= output.carrierScale;
  }

  return { image, mime, quality, byteSize, carrierScale };
}

async function applyOperation(
  image: RibbonImageData,
  operation: TransformOperation,
  signal: AbortSignal
): Promise<AppliedTransform | TransformUnsupported> {
  switch (operation.kind) {
    case "recompress":
      return recompressImage(image, operation.mime ?? "image/jpeg", operation.quality ?? 0.8, signal);
    case "resize":
      return resizeByPercent(image, operation.percent ?? 1);
    case "center-crop":
      return centerCropByPercent(image, operation.percent ?? 0.8);
    case "fit-padding":
      return fitPaddingByPercent(image, operation.percent ?? 0.75);
    case "screenshot":
      return applyImageOnly(screenshotScale(image, operation.percent ?? 2), 1);
  }
}

async function recompressImage(
  image: RibbonImageData,
  mime: TransformOutputMime,
  quality: number,
  signal: AbortSignal
): Promise<AppliedTransform | TransformUnsupported> {
  const blob = await imageToBlob(image, mime, quality);
  throwIfAborted(signal);
  if (mime === "image/webp" && blob.type !== "image/webp") {
    return { unsupported: true, reason: "webp encoder unsupported" };
  }
  const decoded = await blobToImageData(blob);
  throwIfAborted(signal);
  return {
    image: decoded,
    mime: readBlobMime(blob.type),
    quality,
    byteSize: blob.size,
    carrierScale: 1
  };
}

function resizeByPercent(image: RibbonImageData, percent: number): AppliedTransform {
  if (!Number.isFinite(percent) || percent <= 0 || percent > 1) {
    throw new Error("resize percent outside bounds");
  }
  const width = Math.max(1, Math.round(image.width * percent));
  const height = Math.max(1, Math.round(image.height * percent));
  return applyImageOnly(resizeWithCanvas(image, width, height), percent);
}

function centerCropByPercent(image: RibbonImageData, percent: number): AppliedTransform {
  if (!Number.isFinite(percent) || percent <= 0 || percent > 1) {
    throw new Error("crop percent outside bounds");
  }
  const width = Math.max(1, Math.round(image.width * percent));
  const height = Math.max(1, Math.round(image.height * percent));
  return applyImageOnly(centerCrop(image, width, height), 1);
}

function fitPaddingByPercent(image: RibbonImageData, percent: number): AppliedTransform {
  if (!Number.isFinite(percent) || percent <= 0 || percent > 1) {
    throw new Error("padding percent outside bounds");
  }
  const width = Math.max(1, Math.round(image.width * percent));
  const height = Math.max(1, Math.round(image.height * percent));
  return applyImageOnly(fitInsideWithPadding(image, width, height, [248, 251, 255]), percent);
}

function applyImageOnly(image: RibbonImageData, carrierScale: number): AppliedTransform {
  validateTransformImage(image);
  return {
    image,
    mime: "image/unknown",
    quality: null,
    byteSize: null,
    carrierScale
  };
}

function resizeWithCanvas(image: RibbonImageData, width: number, height: number): RibbonImageData {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = requireCanvasContext(canvas);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(imageToCanvas(image), 0, 0, width, height);
  return {
    width,
    height,
    data: context.getImageData(0, 0, width, height).data
  };
}

function imageToBlob(image: RibbonImageData, mime: TransformOutputMime, quality: number): Promise<Blob> {
  const canvas = imageToCanvas(image);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error(`${mime} export failed`));
        return;
      }
      resolve(blob);
    }, mime, quality);
  });
}

async function blobToImageData(blob: Blob): Promise<RibbonImageData> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = requireCanvasContext(canvas);
      context.drawImage(bitmap, 0, 0);
      return {
        width: bitmap.width,
        height: bitmap.height,
        data: context.getImageData(0, 0, bitmap.width, bitmap.height).data
      };
    } finally {
      bitmap.close();
    }
  }
  return blobToImageDataWithElement(blob);
}

function blobToImageDataWithElement(blob: Blob): Promise<RibbonImageData> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = requireCanvasContext(canvas);
      context.drawImage(image, 0, 0);
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight,
        data: context.getImageData(0, 0, image.naturalWidth, image.naturalHeight).data
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("recompressed image decode failed"));
    };
    image.src = url;
  });
}

function imageToCanvas(image: RibbonImageData): HTMLCanvasElement {
  validateTransformImage(image);
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  requireCanvasContext(canvas).putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  return canvas;
}

function validateTransformImage(image: RibbonImageData): void {
  if (image.width <= 0 || image.height <= 0 || image.width * image.height > maxTransformPixels) {
    throw new Error("transform image dimensions outside bounds");
  }
  if (image.data.byteLength !== image.width * image.height * 4) {
    throw new Error("transform image data outside bounds");
  }
}

function summarizeImage(
  image: RibbonImageData,
  mime: TransformImageSummary["mime"],
  quality: number | null,
  byteSize: number | null
): TransformImageSummary {
  return {
    width: image.width,
    height: image.height,
    mime,
    quality,
    byteSize
  };
}

function scaleDecodeOptions(options: DecodeRibbonImageOptions, carrierScale: number, image: RibbonImageData): DecodeRibbonImageOptions {
  const scaledCarrierSize = Math.round(options.carrierSize * carrierScale);
  return {
    ...options,
    carrierSize: Math.max(320, Math.min(image.width, image.height, scaledCarrierSize))
  };
}

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function signatureValidationStatus(wrapper: string): SignatureValidationStatus {
  void wrapper;
  return "not_available";
}

function readBlobMime(type: string): TransformImageSummary["mime"] {
  if (type === "image/png" || type === "image/jpeg" || type === "image/webp") {
    return type;
  }
  return "image/unknown";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("transform lab cancelled");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "transform failed";
}

function requireCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) {
    throw new Error("canvas unavailable");
  }
  return context;
}
