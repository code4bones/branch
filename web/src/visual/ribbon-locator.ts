import { computePlacement, type RibbonPlacement } from "./geometry.js";
import type { RibbonImageData } from "./ribbon-image.js";

export const ribbonLocatorProfile = "ribbon-locator/0.draft" as const;
export const ribbonLocatorMagicText = "BRLOC0" as const;
export const ribbonTintProfile = "ribbon-tint/0" as const;
export const ribbonLocatorByteLength = 23;

export type RibbonLocatorVisualProfile = "ribbon-seal/0" | typeof ribbonTintProfile;

export interface RibbonLocatorHint {
  readonly profile: typeof ribbonLocatorProfile;
  readonly visualProfile: RibbonLocatorVisualProfile;
  readonly quietZone: number;
  readonly modulePitch: number;
  readonly sourceModulePitch: number;
  readonly sourceSymbolVersion: number;
  readonly moduleCount: number;
  readonly placement: RibbonPlacement;
  readonly symbolSize: number;
  readonly sourceSymbolSize: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly payloadRegion: RibbonLocatorRegion;
}

export interface RibbonLocatorRegion {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

export interface MakeRibbonLocatorHintRequest {
  readonly visualProfile: RibbonLocatorVisualProfile;
  readonly quietZone: number;
  readonly modulePitch: number;
  readonly sourceSymbolVersion: number;
  readonly moduleCount: number;
  readonly placement: RibbonPlacement;
  readonly outputWidth: number;
  readonly outputHeight: number;
}

interface LocatorLayout {
  readonly x: number;
  readonly y: number;
  readonly cellSize: number;
}

interface LocatorGrid {
  readonly columns: number;
  readonly rows: number;
  readonly crcRequired: boolean;
}

const locatorMagic = Uint8Array.from(ribbonLocatorMagicText, (value) => value.charCodeAt(0));
const locatorVersion = 0;
const locatorGrid: LocatorGrid = { columns: 46, rows: 4, crcRequired: true };
const legacyLocatorGrid: LocatorGrid = { columns: 38, rows: 4, crcRequired: false };
const locatorBitCount = ribbonLocatorByteLength * 8;

export function makeRibbonLocatorHint(request: MakeRibbonLocatorHintRequest): RibbonLocatorHint {
  const symbolSize = (request.moduleCount + request.quietZone * 2) * request.modulePitch;
  return {
    profile: ribbonLocatorProfile,
    visualProfile: request.visualProfile,
    quietZone: request.quietZone,
    modulePitch: request.modulePitch,
    sourceModulePitch: request.modulePitch,
    sourceSymbolVersion: request.sourceSymbolVersion,
    moduleCount: request.moduleCount,
    placement: request.placement,
    symbolSize,
    sourceSymbolSize: symbolSize,
    sourceWidth: request.outputWidth,
    sourceHeight: request.outputHeight,
    payloadRegion: {
      ...computePlacement(request.placement, request.outputWidth, request.outputHeight, symbolSize),
      size: symbolSize
    }
  };
}

export function drawRibbonLocator(
  context: CanvasRenderingContext2D,
  outputWidth: number,
  outputHeight: number,
  hint: RibbonLocatorHint
): void {
  const layout = makePrimaryLayout(outputWidth, outputHeight);
  if (!layoutFits(layout, locatorGrid, outputWidth, outputHeight)) {
    return;
  }
  const payload = encodeLocatorPayload(hint);
  const image = context.getImageData(layout.x, layout.y, locatorGrid.columns * layout.cellSize, locatorGrid.rows * layout.cellSize);
  const data = image.data;

  for (let bitIndex = 0; bitIndex < locatorBitCount; bitIndex += 1) {
    const byte = payload[Math.floor(bitIndex / 8)] ?? 0;
    const bit = ((byte >> (7 - bitIndex % 8)) & 1) === 1;
    const cellX = bitIndex % locatorGrid.columns;
    const cellY = Math.floor(bitIndex / locatorGrid.columns);
    tintLocatorCell(data, image.width, cellX, cellY, layout.cellSize, bit);
  }

  context.putImageData(image, layout.x, layout.y);
}

export function embedRibbonLocator(image: RibbonImageData, hint: RibbonLocatorHint): RibbonImageData {
  if (!isValidImage(image)) {
    throw new Error("locator image data outside bounds");
  }
  const layout = makePrimaryLayout(image.width, image.height);
  if (!layoutFits(layout, locatorGrid, image.width, image.height)) {
    throw new Error("locator does not fit image");
  }

  const output = {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data)
  };
  const payload = encodeLocatorPayload(hint);
  for (let bitIndex = 0; bitIndex < locatorBitCount; bitIndex += 1) {
    const byte = payload[Math.floor(bitIndex / 8)] ?? 0;
    const bit = ((byte >> (7 - bitIndex % 8)) & 1) === 1;
    const cellX = bitIndex % locatorGrid.columns;
    const cellY = Math.floor(bitIndex / locatorGrid.columns);
    tintLocatorCellInImage(output, layout, cellX, cellY, bit);
  }
  return output;
}

export function readRibbonLocator(image: RibbonImageData): RibbonLocatorHint | null {
  if (!isValidImage(image)) {
    return null;
  }
  for (const candidate of makeCandidateLayouts(image.width, image.height)) {
    if (!layoutFits(candidate.layout, candidate.grid, image.width, image.height)) {
      continue;
    }
    const payload = readLocatorPayload(image, candidate.layout, candidate.grid);
    const hint = decodeLocatorPayload(payload, image.width, image.height, candidate.grid.crcRequired);
    if (hint !== null) {
      return hint;
    }
  }
  return null;
}

function encodeLocatorPayload(hint: RibbonLocatorHint): Uint8Array {
  const bytes = new Uint8Array(ribbonLocatorByteLength);
  bytes.set(locatorMagic, 0);
  bytes[6] = locatorVersion;
  bytes[7] = encodeVisualProfile(hint.visualProfile);
  bytes[8] = encodePlacement(hint.placement);
  bytes[9] = hint.quietZone;
  bytes[10] = hint.modulePitch;
  bytes[11] = hint.sourceSymbolVersion;
  bytes[12] = hint.moduleCount;
  bytes[13] = (hint.symbolSize >> 8) & 0xff;
  bytes[14] = hint.symbolSize & 0xff;
  bytes[15] = (hint.sourceWidth >> 8) & 0xff;
  bytes[16] = hint.sourceWidth & 0xff;
  bytes[17] = (hint.sourceHeight >> 8) & 0xff;
  bytes[18] = hint.sourceHeight & 0xff;
  writeUint32BE(bytes, 19, crc32c(bytes.subarray(0, 19)));
  return bytes;
}

function decodeLocatorPayload(payload: Uint8Array, outputWidth: number, outputHeight: number, crcRequired: boolean): RibbonLocatorHint | null {
  if (payload.byteLength !== ribbonLocatorByteLength) {
    return null;
  }
  for (let index = 0; index < locatorMagic.byteLength; index += 1) {
    if (payload[index] !== locatorMagic[index]) {
      return null;
    }
  }
  if (payload[6] !== locatorVersion) {
    return null;
  }
  const crcValid = readUint32BE(payload, 19) === crc32c(payload.subarray(0, 19));
  if (crcRequired && !crcValid) {
    return null;
  }

  const visualProfile = decodeVisualProfile(readByte(payload, 7));
  const placement = decodePlacement(readByte(payload, 8));
  const quietZone = readByte(payload, 9);
  const sourceModulePitch = readByte(payload, 10);
  const sourceSymbolVersion = readByte(payload, 11);
  const moduleCount = readByte(payload, 12);
  const sourceSymbolSize = (readByte(payload, 13) << 8) | readByte(payload, 14);
  const sourceWidth = (readByte(payload, 15) << 8) | readByte(payload, 16);
  const sourceHeight = (readByte(payload, 17) << 8) | readByte(payload, 18);
  if (visualProfile === null || placement === null || !isBoundedHint(quietZone, sourceModulePitch, sourceSymbolVersion, moduleCount, sourceSymbolSize, sourceWidth, sourceHeight)) {
    return null;
  }
  if ((moduleCount + quietZone * 2) * sourceModulePitch !== sourceSymbolSize) {
    return null;
  }
  const scale = Math.min(outputWidth / sourceWidth, outputHeight / sourceHeight);
  if (!Number.isFinite(scale) || scale <= 0.1 || scale > 4) {
    return null;
  }
  const modulePitch = Math.max(3, Math.min(32, Math.round(sourceModulePitch * scale)));
  const symbolSize = (moduleCount + quietZone * 2) * modulePitch;
  if (symbolSize > outputWidth || symbolSize > outputHeight) {
    return null;
  }

  return {
    profile: ribbonLocatorProfile,
    visualProfile,
    quietZone,
    modulePitch,
    sourceModulePitch,
    sourceSymbolVersion,
    moduleCount,
    placement,
    symbolSize,
    sourceSymbolSize,
    sourceWidth,
    sourceHeight,
    payloadRegion: {
      ...computePlacement(placement, outputWidth, outputHeight, symbolSize),
      size: symbolSize
    }
  };
}

function readLocatorPayload(image: RibbonImageData, layout: LocatorLayout, grid: LocatorGrid): Uint8Array {
  const payload = new Uint8Array(ribbonLocatorByteLength);
  for (let bitIndex = 0; bitIndex < locatorBitCount; bitIndex += 1) {
    const bit = readLocatorCellBit(image, layout, grid, bitIndex);
    if (!bit) {
      continue;
    }
    const byteIndex = Math.floor(bitIndex / 8);
    payload[byteIndex] = (payload[byteIndex] ?? 0) | (1 << (7 - bitIndex % 8));
  }
  return payload;
}

function tintLocatorCell(data: Uint8ClampedArray, width: number, cellX: number, cellY: number, cellSize: number, bit: boolean): void {
  const startX = cellX * cellSize;
  const startY = cellY * cellSize;
  for (let y = startY; y < startY + cellSize; y += 1) {
    for (let x = startX; x < startX + cellSize; x += 1) {
      const offset = (y * width + x) * 4;
      if (bit) {
        data[offset] = clampByte((data[offset] ?? 0) - 10);
        data[offset + 1] = clampByte((data[offset + 1] ?? 0) - 6);
        data[offset + 2] = clampByte((data[offset + 2] ?? 0) + 22) | 1;
        continue;
      }
      data[offset] = clampByte((data[offset] ?? 0) + 10);
      data[offset + 1] = clampByte((data[offset + 1] ?? 0) + 6);
      data[offset + 2] = clampByte((data[offset + 2] ?? 0) - 22) & 0xfe;
    }
  }
}

function tintLocatorCellInImage(image: RibbonImageData, layout: LocatorLayout, cellX: number, cellY: number, bit: boolean): void {
  const startX = layout.x + cellX * layout.cellSize;
  const startY = layout.y + cellY * layout.cellSize;
  for (let y = startY; y < startY + layout.cellSize; y += 1) {
    for (let x = startX; x < startX + layout.cellSize; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (bit) {
        image.data[offset] = clampByte((image.data[offset] ?? 0) - 10);
        image.data[offset + 1] = clampByte((image.data[offset + 1] ?? 0) - 6);
        image.data[offset + 2] = clampByte((image.data[offset + 2] ?? 0) + 22) | 1;
        continue;
      }
      image.data[offset] = clampByte((image.data[offset] ?? 0) + 10);
      image.data[offset + 1] = clampByte((image.data[offset + 1] ?? 0) + 6);
      image.data[offset + 2] = clampByte((image.data[offset + 2] ?? 0) - 22) & 0xfe;
    }
  }
}

function readLocatorCellBit(image: RibbonImageData, layout: LocatorLayout, grid: LocatorGrid, bitIndex: number): boolean {
  const cellX = bitIndex % grid.columns;
  const cellY = Math.floor(bitIndex / grid.columns);
  const margin = Math.max(1, Math.floor(layout.cellSize * 0.25));
  const startX = layout.x + cellX * layout.cellSize + margin;
  const startY = layout.y + cellY * layout.cellSize + margin;
  const endX = layout.x + (cellX + 1) * layout.cellSize - margin;
  const endY = layout.y + (cellY + 1) * layout.cellSize - margin;
  let lsbOnes = 0;
  let chromaTotal = 0;
  let count = 0;

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = (y * image.width + x) * 4;
      const red = image.data[offset] ?? 0;
      const green = image.data[offset + 1] ?? 0;
      const blue = image.data[offset + 2] ?? 0;
      lsbOnes += blue & 1;
      chromaTotal += blue - (red + green) / 2;
      count += 1;
    }
  }

  if (count === 0) {
    return false;
  }
  const lsbRatio = lsbOnes / count;
  if (lsbRatio >= 0.62) {
    return true;
  }
  if (lsbRatio <= 0.38) {
    return false;
  }
  return chromaTotal / count >= 0;
}

function makeCandidateLayouts(width: number, height: number): readonly { readonly layout: LocatorLayout; readonly grid: LocatorGrid }[] {
  const primary = makePrimaryLayout(width, height);
  const cellSizes = uniqueNumbers([primary.cellSize, primary.cellSize - 1, primary.cellSize + 1, 6, 5, 4, 8, 3]);
  const offsets = uniqueNumbers([primary.x, primary.x - 2, primary.x + 2, 16, 12, 8, 24]);
  const candidates: { readonly layout: LocatorLayout; readonly grid: LocatorGrid }[] = [];
  for (const grid of [locatorGrid, legacyLocatorGrid]) {
    for (const cellSize of cellSizes) {
      if (cellSize < 3 || cellSize > 12) {
        continue;
      }
      for (const offset of offsets) {
        if (offset < 0) {
          continue;
        }
        candidates.push({ layout: { x: offset, y: offset, cellSize }, grid });
      }
    }
  }
  return candidates;
}

function makePrimaryLayout(width: number, height: number): LocatorLayout {
  const minSide = Math.min(width, height);
  return {
    x: Math.max(4, Math.round(minSide * 0.008)),
    y: Math.max(4, Math.round(minSide * 0.008)),
    cellSize: Math.max(5, Math.round(minSide / 125))
  };
}

function layoutFits(layout: LocatorLayout, grid: LocatorGrid, width: number, height: number): boolean {
  const readRows = Math.max(grid.rows, Math.ceil(locatorBitCount / grid.columns));
  return layout.x + grid.columns * layout.cellSize <= width && layout.y + readRows * layout.cellSize <= height;
}

function encodeVisualProfile(profile: RibbonLocatorVisualProfile): number {
  return profile === ribbonTintProfile ? 2 : 1;
}

function decodeVisualProfile(value: number): RibbonLocatorVisualProfile | null {
  if (value === 1) {
    return "ribbon-seal/0";
  }
  if (value === 2) {
    return ribbonTintProfile;
  }
  return null;
}

function encodePlacement(placement: RibbonPlacement): number {
  switch (placement) {
    case "center":
      return 1;
    case "bottom-right":
      return 2;
    case "bottom-left":
      return 3;
    case "top-right":
      return 4;
    case "top-left":
      return 5;
  }
}

function decodePlacement(value: number): RibbonPlacement | null {
  switch (value) {
    case 1:
      return "center";
    case 2:
      return "bottom-right";
    case 3:
      return "bottom-left";
    case 4:
      return "top-right";
    case 5:
      return "top-left";
    default:
      return null;
  }
}

function isBoundedHint(
  quietZone: number,
  modulePitch: number,
  sourceSymbolVersion: number,
  moduleCount: number,
  symbolSize: number,
  sourceWidth: number,
  sourceHeight: number
): boolean {
  return quietZone >= 4 &&
    quietZone <= 16 &&
    modulePitch >= 3 &&
    modulePitch <= 32 &&
    sourceSymbolVersion >= 1 &&
    sourceSymbolVersion <= 30 &&
    moduleCount === 21 + (sourceSymbolVersion - 1) * 4 &&
    symbolSize >= 128 &&
    symbolSize <= 4096 &&
    sourceWidth >= symbolSize &&
    sourceHeight >= symbolSize &&
    sourceWidth <= 4096 &&
    sourceHeight <= 4096;
}

function isValidImage(image: RibbonImageData): boolean {
  return image.width > 0 && image.height > 0 && image.data.byteLength === image.width * image.height * 4;
}

function crc32c(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ readCRC32CTable((crc ^ byte) & 0xff);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCRC32CTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
    }
    table[index] = crc >>> 0;
  }
  return table;
}

const crc32cTable = makeCRC32CTable();

function readCRC32CTable(index: number): number {
  const value = crc32cTable[index];
  if (value === undefined) {
    throw new Error("crc32c table index outside range");
  }
  return value;
}

function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readUint32BE(source: Uint8Array, offset: number): number {
  return (
    ((readByte(source, offset) << 24) |
      (readByte(source, offset + 1) << 16) |
      (readByte(source, offset + 2) << 8) |
      readByte(source, offset + 3)) >>>
    0
  );
}

function readByte(source: Uint8Array, offset: number): number {
  const value = source[offset];
  if (value === undefined) {
    throw new Error("locator byte outside range");
  }
  return value;
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

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
