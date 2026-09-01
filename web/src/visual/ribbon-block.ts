import type { RibbonImageData } from "./ribbon-image.js";

export const ribbonBlockProfile = "ribbon-block/0.draft" as const;

export interface RibbonBlockRegion {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly width?: number;
  readonly height?: number;
}

interface RibbonBlockLayout {
  readonly originX: number;
  readonly originY: number;
  readonly cellSize: number;
  readonly columns: number;
  readonly rows: number;
  readonly capacityCells: number;
  readonly permutationStep: number;
}

const blockMagic = Uint8Array.from("BRBLK0", (value) => value.charCodeAt(0));
const blockVersion = 0;
const blockStrength = 20;
const blockTargetGridSide = 125;
const blockHeaderBytes = blockMagic.byteLength + 1 + 2;
const blockTrailerBytes = 4;
const blockRepeatCandidates = [15, 11, 7, 5, 3, 1] as const;

export function drawBlockPayload(context: CanvasRenderingContext2D, frame: Uint8Array, region: RibbonBlockRegion): void {
  validateRegion(region);
  const image = context.getImageData(region.x, region.y, regionWidth(region), regionHeight(region));
  writeBlockPayload(image.data, image.width, frame, makeBlockLayout(regionWidth(region), regionHeight(region)));
  context.putImageData(image, region.x, region.y);
}

export function embedBlockPayload(image: RibbonImageData, frame: Uint8Array, region: RibbonBlockRegion): RibbonImageData {
  if (!isValidImage(image) || !regionFits(image, region)) {
    throw new Error("block payload region outside image bounds");
  }
  const output = {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data)
  };
  writeBlockPayload(output.data, output.width, frame, makeBlockLayout(regionWidth(region), regionHeight(region)), region.x, region.y);
  return output;
}

export function extractBlockPayload(image: RibbonImageData, region: RibbonBlockRegion): Uint8Array | null {
  if (!isValidImage(image) || !regionFits(image, region)) {
    return null;
  }
  const layout = makeBlockLayout(regionWidth(region), regionHeight(region));
  for (const repeat of blockRepeatCandidates) {
    const packet = readRepeatedPacket(image, region, layout, repeat);
    const frame = decodeBlockPacket(packet);
    if (frame !== null) {
      return frame;
    }
  }
  return null;
}

function writeBlockPayload(
  data: Uint8ClampedArray,
  width: number,
  frame: Uint8Array,
  layout: RibbonBlockLayout,
  offsetX = 0,
  offsetY = 0
): void {
  const packet = encodeBlockPacket(frame);
  const packetBits = packet.byteLength * 8;
  const repeat = selectRepeat(packetBits, layout.capacityCells);
  for (let bitIndex = 0; bitIndex < packetBits; bitIndex += 1) {
    const byte = packet[Math.floor(bitIndex / 8)] ?? 0;
    const bit = ((byte >> (7 - bitIndex % 8)) & 1) === 1;
    for (let repeated = 0; repeated < repeat; repeated += 1) {
      tintBlockCell(data, width, layout, offsetX, offsetY, permuteCellIndex(layout, bitIndex * repeat + repeated), bit);
    }
  }
}

function readRepeatedPacket(
  image: RibbonImageData,
  region: RibbonBlockRegion,
  layout: RibbonBlockLayout,
  repeat: number
): Uint8Array {
  const bitCapacity = Math.floor(layout.capacityCells / repeat);
  const byteCapacity = Math.floor(bitCapacity / 8);
  const packet = new Uint8Array(byteCapacity);
  for (let bitIndex = 0; bitIndex < byteCapacity * 8; bitIndex += 1) {
    let score = 0;
    for (let repeated = 0; repeated < repeat; repeated += 1) {
      score += readBlockCellScore(image, region, layout, permuteCellIndex(layout, bitIndex * repeat + repeated));
    }
    if (score < 0) {
      continue;
    }
    packet[Math.floor(bitIndex / 8)] = (packet[Math.floor(bitIndex / 8)] ?? 0) | (1 << (7 - bitIndex % 8));
  }
  return packet;
}

function encodeBlockPacket(frame: Uint8Array): Uint8Array {
  if (frame.byteLength > 0xffff) {
    throw new Error("block payload frame too large");
  }
  const packet = new Uint8Array(blockHeaderBytes + frame.byteLength + blockTrailerBytes);
  packet.set(blockMagic, 0);
  packet[blockMagic.byteLength] = blockVersion;
  packet[blockMagic.byteLength + 1] = (frame.byteLength >> 8) & 0xff;
  packet[blockMagic.byteLength + 2] = frame.byteLength & 0xff;
  packet.set(frame, blockHeaderBytes);
  writeUint32BE(packet, blockHeaderBytes + frame.byteLength, crc32c(frame));
  return packet;
}

function decodeBlockPacket(packet: Uint8Array): Uint8Array | null {
  if (packet.byteLength < blockHeaderBytes + blockTrailerBytes) {
    return null;
  }
  for (let index = 0; index < blockMagic.byteLength; index += 1) {
    if (packet[index] !== blockMagic[index]) {
      return null;
    }
  }
  if (packet[blockMagic.byteLength] !== blockVersion) {
    return null;
  }
  const frameLength = ((packet[blockMagic.byteLength + 1] ?? 0) << 8) | (packet[blockMagic.byteLength + 2] ?? 0);
  const packetLength = blockHeaderBytes + frameLength + blockTrailerBytes;
  if (frameLength <= 0 || packetLength > packet.byteLength) {
    return null;
  }
  const frame = packet.slice(blockHeaderBytes, blockHeaderBytes + frameLength);
  if (readUint32BE(packet, blockHeaderBytes + frameLength) !== crc32c(frame)) {
    return null;
  }
  return frame;
}

function tintBlockCell(
  data: Uint8ClampedArray,
  width: number,
  layout: RibbonBlockLayout,
  offsetX: number,
  offsetY: number,
  cellIndex: number,
  bit: boolean
): void {
  if (cellIndex >= layout.capacityCells) {
    throw new Error("block payload exceeds carrier capacity");
  }
  const cellX = cellIndex % layout.columns;
  const cellY = Math.floor(cellIndex / layout.columns);
  const startX = offsetX + layout.originX + cellX * layout.cellSize;
  const startY = offsetY + layout.originY + cellY * layout.cellSize;
  for (let y = startY; y < startY + layout.cellSize; y += 1) {
    for (let x = startX; x < startX + layout.cellSize; x += 1) {
      const polarity = readCellPolarity(cellIndex, x - startX, y - startY, layout.cellSize);
      const offset = (y * width + x) * 4;
      const red = data[offset] ?? 0;
      const green = data[offset + 1] ?? 0;
      const blue = data[offset + 2] ?? 0;
      const delta = (bit ? polarity : -polarity) * blockStrength;
      data[offset] = clampByte(red + delta);
      data[offset + 1] = clampByte(green + delta);
      data[offset + 2] = clampByte(blue + delta);
    }
  }
}

function readBlockCellScore(
  image: RibbonImageData,
  region: RibbonBlockRegion,
  layout: RibbonBlockLayout,
  cellIndex: number
): number {
  const cellX = cellIndex % layout.columns;
  const cellY = Math.floor(cellIndex / layout.columns);
  const margin = Math.max(1, Math.floor(layout.cellSize * 0.18));
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
      score += readCellPolarity(cellIndex, x - cellStartX, y - cellStartY, layout.cellSize) * luma;
    }
  }
  return score;
}

function readCellPolarity(cellIndex: number, x: number, y: number, cellSize: number): 1 | -1 {
  const midpoint = Math.floor(cellSize / 2);
  switch (hashCell(cellIndex) & 3) {
    case 0:
      return x < midpoint ? 1 : -1;
    case 1:
      return y < midpoint ? 1 : -1;
    case 2:
      return (x < midpoint) === (y < midpoint) ? 1 : -1;
    default:
      return x + y < cellSize ? 1 : -1;
  }
}

function hashCell(cellIndex: number): number {
  let value = (cellIndex + 1) * 0x9e3779b1;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  return value >>> 0;
}

function makeBlockLayout(width: number, height: number): RibbonBlockLayout {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 128 || height < 128 || width > 4096 || height > 4096) {
    throw new Error("invalid block payload region");
  }
  const cellSize = Math.max(6, Math.floor(Math.min(width, height) / blockTargetGridSide));
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
  for (const repeat of blockRepeatCandidates) {
    if (packetBits * repeat <= capacityBits) {
      return repeat;
    }
  }
  throw new Error("block payload exceeds carrier capacity");
}

function validateRegion(region: RibbonBlockRegion): void {
  const width = regionWidth(region);
  const height = regionHeight(region);
  if (!Number.isInteger(region.x) || !Number.isInteger(region.y) || !Number.isInteger(width) || !Number.isInteger(height) || width < 128 || height < 128 || width > 4096 || height > 4096) {
    throw new Error("invalid block payload region");
  }
}

function regionFits(image: RibbonImageData, region: RibbonBlockRegion): boolean {
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

function regionWidth(region: RibbonBlockRegion): number {
  return region.width ?? region.size;
}

function regionHeight(region: RibbonBlockRegion): number {
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

function permuteCellIndex(layout: RibbonBlockLayout, sequentialIndex: number): number {
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
