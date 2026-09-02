import { drawBlockPayload, ribbonBlockProfile } from "./ribbon-block.js";
import {
  branchWrapperBytes,
  encodeRibbonFrame,
  type RibbonCarrierDiagnostics
} from "./ribbon-image.js";
import type { LoadedBrowserImage } from "./canvas-image.js";

export type RibbonVisualMode = "block";

export interface GeneratedRibbonSymbol {
  readonly frame: Uint8Array;
  readonly diagnostics: RibbonCarrierDiagnostics;
}

export interface RenderRibbonOptions {
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly coverImage: LoadedBrowserImage | null;
}

export function generateRibbonSymbol(wrapper: string): GeneratedRibbonSymbol {
  const payload = branchWrapperBytes(wrapper);
  return {
    frame: encodeRibbonFrame(payload),
    diagnostics: {
      profile: ribbonBlockProfile,
      payloadLength: payload.byteLength,
      errorCorrectionLevel: "block-repeat"
    }
  };
}

export function renderRibbonImage(
  canvas: HTMLCanvasElement,
  symbol: GeneratedRibbonSymbol,
  options: RenderRibbonOptions
): void {
  canvas.width = options.outputWidth;
  canvas.height = options.outputHeight;
  const context = requireCanvasContext(canvas);
  if (options.coverImage === null) {
    drawNeutralBackground(context, options.outputWidth, options.outputHeight);
  } else {
    drawCoverImage(context, options.coverImage, options.outputWidth, options.outputHeight);
  }

  drawBlockPayload(context, symbol.frame, {
    x: 0,
    y: 0,
    size: Math.min(options.outputWidth, options.outputHeight),
    width: options.outputWidth,
    height: options.outputHeight
  });
}

export function drawIdleCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 640;
  canvas.height = 640;
  const context = requireCanvasContext(canvas);
  drawNeutralBackground(context, canvas.width, canvas.height);
  context.fillStyle = "#1f6feb";
  context.fillRect(136, 136, 368, 72);
  context.fillRect(136, 288, 368, 72);
  context.fillRect(136, 440, 368, 72);
}

export function drawCoverPreview(
  canvas: HTMLCanvasElement,
  coverImage: LoadedBrowserImage,
  outputWidth: number,
  outputHeight: number
): void {
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  drawCoverImage(requireCanvasContext(canvas), coverImage, outputWidth, outputHeight);
}

export function drawCoverImage(
  context: CanvasRenderingContext2D,
  coverImage: LoadedBrowserImage,
  outputWidth: number,
  outputHeight: number
): void {
  context.fillStyle = "#07111d";
  context.fillRect(0, 0, outputWidth, outputHeight);
  const scale = Math.max(outputWidth / coverImage.width, outputHeight / coverImage.height);
  const width = Math.round(coverImage.width * scale);
  const height = Math.round(coverImage.height * scale);
  const x = Math.round((outputWidth - width) / 2);
  const y = Math.round((outputHeight - height) / 2);
  context.drawImage(coverImage.image, x, y, width, height);
}

function drawNeutralBackground(context: CanvasRenderingContext2D, width: number, height: number): void {
  context.fillStyle = "#07111d";
  context.fillRect(0, 0, width, height);
}

function requireCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) {
    throw new Error("canvas unavailable");
  }
  return context;
}
