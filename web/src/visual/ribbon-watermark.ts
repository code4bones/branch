import type { RibbonImageData } from "./ribbon-image.js";

export const ribbonWatermarkProfile = "ribbon-watermark/0.draft" as const;

export interface RibbonWatermarkRegion {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly width?: number;
  readonly height?: number;
}

interface RibbonWatermarkLayout {
  readonly originX: number;
  readonly originY: number;
  readonly cellSize: number;
  readonly columns: number;
  readonly rows: number;
  readonly capacityCells: number;
  readonly permutationStep: number;
}

const watermarkMagic = Uint8Array.from("BRWMK0", (value) => value.charCodeAt(0));
const watermarkVersion = 0;
const watermarkStrength = 3;
const watermarkTargetGridSide = 250;
const watermarkHeaderBytes = watermarkMagic.byteLength + 1 + 2;
const watermarkTrailerBytes = 4;
const watermarkRepeatCandidates = [63, 47, 31, 23, 15, 11, 7, 5, 3, 1] as const;

export function drawWatermarkPayload(
  context: CanvasRenderingContext2D,
  frame: Uint8Array,
  region: RibbonWatermarkRegion
): void {
  validateRegion(region);
  const image = context.getImageData(region.x, region.y, regionWidth(region), regionHeight(region));
  writeWatermarkPayload(image.data, image.width, frame, makeWatermarkLayout(regionWidth(region), regionHeight(region)));
  context.putImageData(image, region.x, region.y);
}

export function embedWatermarkPayload(
  image: RibbonImageData,
  frame: Uint8Array,
  region: RibbonWatermarkRegion
): RibbonImageData {
  if (!isValidImage(image) || !regionFits(image, region)) {
    throw new Error("watermark payload region outside image bounds");
  }
  const output = {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data)
  };
  writeWatermarkPayload(
    output.data,
    output.width,
    frame,
    makeWatermarkLayout(regionWidth(region), regionHeight(region)),
    region.x,
    region.y
  );
  return output;
}

export function extractWatermarkPayload(image: RibbonImageData, region: RibbonWatermarkRegion): Uint8Array | null {
  if (!isValidImage(image) || !regionFits(image, region)) {
    return null;
  }
  const layout = makeWatermarkLayout(regionWidth(region), regionHeight(region));
  for (const repeat of watermarkRepeatCandidates) {
    const packet = readRepeatedPacket(image, region, layout, repeat);
    const frame = decodeWatermarkPacket(packet);
    if (frame !== null) {
      return frame;
    }
  }
  return null;
}

function writeWatermarkPayload(
  data: Uint8ClampedArray,
  width: number,
  frame: Uint8Array,
  layout: RibbonWatermarkLayout,
  offsetX = 0,
  offsetY = 0
): void {
  const packet = encodeWatermarkPacket(frame);
  const packetBits = packet.byteLength * 8;
  const repeat = selectRepeat(packetBits, layout.capacityCells);
  for (let bitIndex = 0; bitIndex < packetBits; bitIndex += 1) {
    const byte = packet[Math.floor(bitIndex / 8)] ?? 0;
    const bit = ((byte >> (7 - bitIndex % 8)) & 1) === 1;
    for (let repeated = 0; repeated < repeat; repeated += 1) {
      tintWatermarkCell(data, width, layout, offsetX, offsetY, permuteCellIndex(layout, bitIndex * repeat + repeated), bit);
    }
  }
}

function readRepeatedPacket(
  image: RibbonImageData,
  region: RibbonWatermarkRegion,
  layout: RibbonWatermarkLayout,
  repeat: number
): Uint8Array {
  const bitCapacity = Math.floor(layout.capacityCells / repeat);
  const byteCapacity = Math.floor(bitCapacity / 8);
  const packet = new Uint8Array(byteCapacity);
  for (let bitIndex = 0; bitIndex < byteCapacity * 8; bitIndex += 1) {
    let score = 0;
    for (let repeated = 0; repeated < repeat; repeated += 1) {
      score += readWatermarkCellScore(image, region, layout, permuteCellIndex(layout, bitIndex * repeat + repeated));
    }
    if (score < 0) {
      continue;
    }
    packet[Math.floor(bitIndex / 8)] = (packet[Math.floor(bitIndex / 8)] ?? 0) | (1 << (7 - bitIndex % 8));
  }
  return packet;
}

function encodeWatermarkPacket(frame: Uint8Array): Uint8Array {
  if (frame.byteLength > 0xffff) {
    throw new Error("watermark payload frame too large");
  }
  const packet = new Uint8Array(watermarkHeaderBytes + frame.byteLength + watermarkTrailerBytes);
  packet.set(watermarkMagic, 0);
  packet[watermarkMagic.byteLength] = watermarkVersion;
  packet[watermarkMagic.byteLength + 1] = (frame.byteLength >> 8) & 0xff;
  packet[watermarkMagic.byteLength + 2] = frame.byteLength & 0xff;
  packet.set(frame, watermarkHeaderBytes);
  writeUint32BE(packet, watermarkHeaderBytes + frame.byteLength, crc32c(frame));
  return packet;
}

function decodeWatermarkPacket(packet: Uint8Array): Uint8Array | null {
  if (packet.byteLength < watermarkHeaderBytes + watermarkTrailerBytes) {
    return null;
  }
  for (let index = 0; index < watermarkMagic.byteLength; index += 1) {
    if (packet[index] !== watermarkMagic[index]) {
      return null;
    }
  }
  if (packet[watermarkMagic.byteLength] !== watermarkVersion) {
    return null;
  }
  const frameLength = ((packet[watermarkMagic.byteLength + 1] ?? 0) << 8) | (packet[watermarkMagic.byteLength + 2] ?? 0);
  const packetLength = watermarkHeaderBytes + frameLength + watermarkTrailerBytes;
  if (frameLength <= 0 || packetLength > packet.byteLength) {
    return null;
  }
  const frame = packet.slice(watermarkHeaderBytes, watermarkHeaderBytes + frameLength);
  if (readUint32BE(packet, watermarkHeaderBytes + frameLength) !== crc32c(frame)) {
    return null;
  }
  return frame;
}

function tintWatermarkCell(
  data: Uint8ClampedArray,
  width: number,
  layout: RibbonWatermarkLayout,
  offsetX: number,
  offsetY: number,
  cellIndex: number,
  bit: boolean
): void {
  if (cellIndex >= layout.capacityCells) {
    throw new Error("watermark payload exceeds carrier capacity");
  }
  const cellX = cellIndex % layout.columns;
  const cellY = Math.floor(cellIndex / layout.columns);
  const startX = offsetX + layout.originX + cellX * layout.cellSize;
  const startY = offsetY + layout.originY + cellY * layout.cellSize;
  for (let y = startY; y < startY + layout.cellSize; y += 1) {
    for (let x = startX; x < startX + layout.cellSize; x += 1) {
      const offset = (y * width + x) * 4;
      const weight = readWatermarkWeight(cellIndex, x - startX, y - startY, layout.cellSize);
      const delta = (bit ? weight : -weight) * watermarkStrength;
      data[offset] = clampByte((data[offset] ?? 0) + delta);
      data[offset + 1] = clampByte((data[offset + 1] ?? 0) + delta);
      data[offset + 2] = clampByte((data[offset + 2] ?? 0) + delta);
    }
  }
}

function readWatermarkCellScore(
  image: RibbonImageData,
  region: RibbonWatermarkRegion,
  layout: RibbonWatermarkLayout,
  cellIndex: number
): number {
  const cellX = cellIndex % layout.columns;
  const cellY = Math.floor(cellIndex / layout.columns);
  const margin = Math.max(1, Math.floor(layout.cellSize * 0.12));
  const startX = region.x + layout.originX + cellX * layout.cellSize + margin;
  const startY = region.y + layout.originY + cellY * layout.cellSize + margin;
  const endX = region.x + layout.originX + (cellX + 1) * layout.cellSize - margin;
  const endY = region.y + layout.originY + (cellY + 1) * layout.cellSize - margin;
  const cellStartX = region.x + layout.originX + cellX * layout.cellSize;
  const cellStartY = region.y + layout.originY + cellY * layout.cellSize;
  let score = 0;
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = (y * image.width + x) * 4;
      const red = image.data[offset] ?? 0;
      const green = image.data[offset + 1] ?? 0;
      const blue = image.data[offset + 2] ?? 0;
      const luma = red * 0.299 + green * 0.587 + blue * 0.114;
      score += readWatermarkWeight(cellIndex, x - cellStartX, y - cellStartY, layout.cellSize) * luma;
    }
  }
  return score;
}

function readWatermarkWeight(cellIndex: number, x: number, y: number, cellSize: number): number {
  void cellSize;
  switch (hashCell(cellIndex) & 3) {
    case 0:
      return ((x + y) & 1) === 0 ? 1 : -1;
    case 1:
      return (x & 1) === 0 ? 1 : -1;
    case 2:
      return (y & 1) === 0 ? 1 : -1;
    default:
      return ((x - y) & 1) === 0 ? 1 : -1;
  }
}

function hashCell(cellIndex: number): number {
  let value = (cellIndex + 1) * 0x9e3779b1;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  return value >>> 0;
}

function makeWatermarkLayout(width: number, height: number): RibbonWatermarkLayout {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 128 || height < 128 || width > 4096 || height > 4096) {
    throw new Error("invalid watermark payload region");
  }
  const cellSize = Math.max(4, Math.floor(Math.min(width, height) / watermarkTargetGridSide));
  const columns = Math.floor(width / cellSize);
  const rows = Math.floor(height / cellSize);
  const gridWidth = columns * cellSize;
  const gridHeight = rows * cellSize;
  const capacityCells = columns * rows;
  return {
    originX: Math.floor((width - gridWidth) / 2),
    originY: Math.floor((height - gridHeight) / 2),
    cellSize,
    columns,
    rows,
    capacityCells,
    permutationStep: selectPermutationStep(capacityCells)
  };
}

function selectRepeat(packetBits: number, capacityBits: number): number {
  for (const repeat of watermarkRepeatCandidates) {
    if (packetBits * repeat <= capacityBits) {
      return repeat;
    }
  }
  throw new Error("watermark payload exceeds carrier capacity");
}

function validateRegion(region: RibbonWatermarkRegion): void {
  const width = regionWidth(region);
  const height = regionHeight(region);
  if (!Number.isInteger(region.x) || !Number.isInteger(region.y) || !Number.isInteger(width) || !Number.isInteger(height) || width < 128 || height < 128 || width > 4096 || height > 4096) {
    throw new Error("invalid watermark payload region");
  }
}

function regionFits(image: RibbonImageData, region: RibbonWatermarkRegion): boolean {
  const width = regionWidth(region);
  const height = regionHeight(region);
  return Number.isInteger(region.x) &&
    Number.isInteger(region.y) &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    region.x >= 0 &&
    region.y >= 0 &&
    width >= 128 &&
    height >= 128 &&
    region.x + width <= image.width &&
    region.y + height <= image.height;
}

function regionWidth(region: RibbonWatermarkRegion): number {
  return region.width ?? region.size;
}

function regionHeight(region: RibbonWatermarkRegion): number {
  return region.height ?? region.size;
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
    (((source[offset] ?? 0) << 24) |
      ((source[offset + 1] ?? 0) << 16) |
      ((source[offset + 2] ?? 0) << 8) |
      (source[offset + 3] ?? 0)) >>>
    0
  );
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function permuteCellIndex(layout: RibbonWatermarkLayout, sequentialIndex: number): number {
  return (sequentialIndex * layout.permutationStep + 97) % layout.capacityCells;
}

function selectPermutationStep(capacity: number): number {
  for (const candidate of [4093, 8191, 65537, 257, 131, 17]) {
    if (gcd(candidate, capacity) === 1) {
      return candidate;
    }
  }
  return 1;
}

function gcd(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}
