import * as QRCode from "qrcode";

import { computeModulePitch, computePlacement, type RibbonPlacement } from "./geometry.js";
import { drawBlockPayload, ribbonBlockProfile } from "./ribbon-block.js";
import {
  branchWrapperBytes,
  encodeRibbonFrame,
  ribbonSealProfile,
  type RibbonSealDiagnostics
} from "./ribbon-image.js";
import {
  drawRibbonLocator,
  makeRibbonLocatorHint,
  ribbonTintProfile,
  type RibbonLocatorVisualProfile
} from "./ribbon-locator.js";
import { drawTintQR } from "./ribbon-tint.js";
import type { LoadedBrowserImage } from "./canvas-image.js";

export type RibbonVisualMode = "seal" | "tint" | "block";

export interface QRModules {
  readonly size: number;
  get(x: number, y: number): unknown;
}

export interface GeneratedRibbonSymbol {
  readonly frame: Uint8Array;
  readonly modules: QRModules;
  readonly diagnostics: RibbonSealDiagnostics;
}

export interface RenderRibbonOptions {
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly carrierSize: number;
  readonly visualMode: RibbonVisualMode;
  readonly tintStrength: number;
  readonly placement: RibbonPlacement;
  readonly coverImage: LoadedBrowserImage | null;
}

export function generateRibbonSymbol(
  wrapper: string,
  quietZone: number,
  carrierSize: number
): GeneratedRibbonSymbol {
  const payload = branchWrapperBytes(wrapper);
  const frame = encodeRibbonFrame(payload);
  const qr = QRCode.create([{ mode: "byte", data: frame }], { errorCorrectionLevel: "H" });
  const modulePitch = computeModulePitch(qr.modules.size, quietZone, carrierSize);
  return {
    frame,
    modules: qr.modules,
    diagnostics: {
      profile: ribbonSealProfile,
      sourceSymbolVersion: qr.version,
      moduleCount: qr.modules.size,
      modulePitch,
      quietZone,
      payloadLength: payload.byteLength,
      errorCorrectionLevel: "H"
    }
  };
}

export function renderRibbonImage(
  canvas: HTMLCanvasElement,
  symbol: GeneratedRibbonSymbol,
  options: RenderRibbonOptions
): void {
  if (options.coverImage === null || options.visualMode === "seal") {
    const symbolSize = symbolSizePixels(symbol.diagnostics.moduleCount, symbol.diagnostics.quietZone, symbol.diagnostics.modulePitch);
    canvas.width = symbolSize;
    canvas.height = symbolSize;
    const context = requireCanvasContext(canvas);
    if (options.coverImage !== null) {
      canvas.width = options.outputWidth;
      canvas.height = options.outputHeight;
      drawCoverImage(context, options.coverImage, options.outputWidth, options.outputHeight);
      ensureCarrierFits(symbolSize, options.outputWidth, options.outputHeight);
      const placement = computePlacement(options.placement, options.outputWidth, options.outputHeight, symbolSize);
      drawQR(context, symbol.modules, placement.x, placement.y, symbol.diagnostics.modulePitch, symbol.diagnostics.quietZone);
      drawLocator(context, symbol, options, "ribbon-seal/0");
      return;
    }
    drawQR(context, symbol.modules, 0, 0, symbol.diagnostics.modulePitch, symbol.diagnostics.quietZone);
    return;
  }

  canvas.width = options.outputWidth;
  canvas.height = options.outputHeight;
  const context = requireCanvasContext(canvas);
  drawCoverImage(context, options.coverImage, options.outputWidth, options.outputHeight);

  const symbolSize = symbolSizePixels(symbol.diagnostics.moduleCount, symbol.diagnostics.quietZone, symbol.diagnostics.modulePitch);
  ensureCarrierFits(symbolSize, options.outputWidth, options.outputHeight);
  const placement = computePlacement(options.placement, options.outputWidth, options.outputHeight, symbolSize);
  if (options.visualMode === "block") {
    drawBlockPayload(context, symbol.frame, { ...placement, size: symbolSize });
    drawLocator(context, symbol, options, ribbonBlockProfile);
    return;
  }

  drawTintQR(
    context,
    symbol.modules,
    placement.x,
    placement.y,
    symbol.diagnostics.modulePitch,
    symbol.diagnostics.quietZone,
    options.tintStrength
  );
  drawLocator(context, symbol, options, ribbonTintProfile);
}

export function drawIdleCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 640;
  canvas.height = 640;
  const context = requireCanvasContext(canvas);
  context.fillStyle = "#f8fbff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#d8e3f1";
  context.fillRect(128, 128, 384, 384);
  context.fillStyle = "#003078";
  context.fillRect(168, 168, 96, 96);
  context.fillRect(376, 168, 96, 96);
  context.fillRect(168, 376, 96, 96);
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

export function symbolSizePixels(moduleCount: number, quietZone: number, modulePitch: number): number {
  return (moduleCount + quietZone * 2) * modulePitch;
}

function drawQR(
  context: CanvasRenderingContext2D,
  modules: QRModules,
  x: number,
  y: number,
  modulePitch: number,
  quietZone: number
): void {
  const moduleCount = modules.size;
  const size = symbolSizePixels(moduleCount, quietZone, modulePitch);
  context.fillStyle = "#f8fbff";
  context.fillRect(x, y, size, size);
  context.fillStyle = "#003078";

  for (let moduleY = 0; moduleY < moduleCount; moduleY += 1) {
    for (let moduleX = 0; moduleX < moduleCount; moduleX += 1) {
      if (!modules.get(moduleX, moduleY)) {
        continue;
      }
      context.fillRect(
        x + (moduleX + quietZone) * modulePitch,
        y + (moduleY + quietZone) * modulePitch,
        modulePitch,
        modulePitch
      );
    }
  }
}

function ensureCarrierFits(symbolSize: number, outputWidth: number, outputHeight: number): void {
  if (symbolSize > outputWidth || symbolSize > outputHeight) {
    throw new Error("carrier size too large for output");
  }
}

function drawLocator(
  context: CanvasRenderingContext2D,
  symbol: GeneratedRibbonSymbol,
  options: RenderRibbonOptions,
  visualProfile: RibbonLocatorVisualProfile
): void {
  drawRibbonLocator(
    context,
    options.outputWidth,
    options.outputHeight,
    makeRibbonLocatorHint({
      visualProfile,
      quietZone: symbol.diagnostics.quietZone,
      modulePitch: symbol.diagnostics.modulePitch,
      sourceSymbolVersion: symbol.diagnostics.sourceSymbolVersion,
      moduleCount: symbol.diagnostics.moduleCount,
      placement: options.placement,
      outputWidth: options.outputWidth,
      outputHeight: options.outputHeight
    })
  );
}

function requireCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) {
    throw new Error("canvas unavailable");
  }
  return context;
}
