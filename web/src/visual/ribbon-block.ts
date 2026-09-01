import type { RibbonImageData } from "./ribbon-image.js";

export const ribbonBlockProfile = "ribbon-block/0.draft" as const;

export interface RibbonBlockRegion {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

interface RibbonBlockLayout {
  readonly origin: number;
  readonly cellSize: number;
  readonly gridSide: number;
  readonly capacityBits: number;
}

const blockMagic = Uint8Array.from("BRBLK0", (value) => value.charCodeAt(0));
const blockVersion = 0;
const blockStrength = 44;
const blockTargetGridSide = 82;
const blockHeaderBytes = blockMagic.byteLength + 1 + 2;
const blockTrailerBytes = 4;
const blockRepeatCandidates = [5, 3, 1] as const;

export function drawBlockPayload(context: CanvasRenderingContext2D, frame: Uint8Array, region: RibbonBlockRegion): void {
  validateRegion(region);
  const image = context.getImageData(region.x, region.y, region.size, region.size);
  writeBlockPayload(image.data, image.width, frame, makeBlockLayout(region.size));
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
  writeBlockPayload(output.data, output.width, frame, makeBlockLayout(region.size), region.x, region.y);
  return output;
}

export function extractBlockPayload(image: RibbonImageData, region: RibbonBlockRegion): Uint8Array | null {
  if (!isValidImage(image) || !regionFits(image, region)) {
    return null;
  }
  const layout = makeBlockLayout(region.size);
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
  const repeat = selectRepeat(packetBits, layout.capacityBits);
  for (let bitIndex = 0; bitIndex < packetBits; bitIndex += 1) {
    const byte = packet[Math.floor(bitIndex / 8)] ?? 0;
    const bit = ((byte >> (7 - bitIndex % 8)) & 1) === 1;
    for (let repeated = 0; repeated < repeat; repeated += 1) {
      tintBlockCell(data, width, layout, offsetX, offsetY, bitIndex * repeat + repeated, bit);
    }
  }
}

function readRepeatedPacket(
  image: RibbonImageData,
  region: RibbonBlockRegion,
  layout: RibbonBlockLayout,
  repeat: number
): Uint8Array {
  const bitCapacity = Math.floor(layout.capacityBits / repeat);
  const byteCapacity = Math.floor(bitCapacity / 8);
  const packet = new Uint8Array(byteCapacity);
  for (let bitIndex = 0; bitIndex < byteCapacity * 8; bitIndex += 1) {
    let score = 0;
    for (let repeated = 0; repeated < repeat; repeated += 1) {
      score += readBlockCellScore(image, region, layout, bitIndex * repeat + repeated);
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
  if (cellIndex >= layout.capacityBits) {
    throw new Error("block payload exceeds carrier capacity");
  }
  const cellX = cellIndex % layout.gridSide;
  const cellY = Math.floor(cellIndex / layout.gridSide);
  const startX = offsetX + layout.origin + cellX * layout.cellSize;
  const startY = offsetY + layout.origin + cellY * layout.cellSize;
  const midpoint = startX + Math.floor(layout.cellSize / 2);
  for (let y = startY; y < startY + layout.cellSize; y += 1) {
    for (let x = startX; x < startX + layout.cellSize; x += 1) {
      const leftHalf = x < midpoint;
      const blueSide = bit ? leftHalf : !leftHalf;
      const offset = (y * width + x) * 4;
      const red = data[offset] ?? 0;
      const green = data[offset + 1] ?? 0;
      const blue = data[offset + 2] ?? 0;
      data[offset] = clampByte(red + (blueSide ? -blockStrength : blockStrength));
      data[offset + 1] = clampByte(green + (blueSide ? -6 : 6));
      data[offset + 2] = clampByte(blue + (blueSide ? blockStrength : -blockStrength));
    }
  }
}

function readBlockCellScore(
  image: RibbonImageData,
  region: RibbonBlockRegion,
  layout: RibbonBlockLayout,
  cellIndex: number
): number {
  const cellX = cellIndex % layout.gridSide;
  const cellY = Math.floor(cellIndex / layout.gridSide);
  const margin = Math.max(1, Math.floor(layout.cellSize * 0.18));
  const startX = region.x + layout.origin + cellX * layout.cellSize + margin;
  const startY = region.y + layout.origin + cellY * layout.cellSize + margin;
  const endX = region.x + layout.origin + (cellX + 1) * layout.cellSize - margin;
  const endY = region.y + layout.origin + (cellY + 1) * layout.cellSize - margin;
  const midpoint = region.x + layout.origin + cellX * layout.cellSize + Math.floor(layout.cellSize / 2);
  let score = 0;
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = (y * image.width + x) * 4;
      const red = image.data[offset] ?? 0;
      const blue = image.data[offset + 2] ?? 0;
      score += (x < midpoint ? 1 : -1) * (blue - red);
    }
  }
  return score;
}

function makeBlockLayout(size: number): RibbonBlockLayout {
  validateRegion({ x: 0, y: 0, size });
  const cellSize = Math.max(6, Math.floor(size / blockTargetGridSide));
  const gridSide = Math.floor(size / cellSize);
  const gridPixels = gridSide * cellSize;
  return {
    origin: Math.floor((size - gridPixels) / 2),
    cellSize,
    gridSide,
    capacityBits: gridSide * gridSide
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
  if (!Number.isInteger(region.x) || !Number.isInteger(region.y) || !Number.isInteger(region.size) || region.size < 128 || region.size > 4096) {
    throw new Error("invalid block payload region");
  }
}

function regionFits(image: RibbonImageData, region: RibbonBlockRegion): boolean {
  return Number.isInteger(region.x) &&
    Number.isInteger(region.y) &&
    Number.isInteger(region.size) &&
    region.x >= 0 &&
    region.y >= 0 &&
    region.size >= 128 &&
    region.x + region.size <= image.width &&
    region.y + region.size <= image.height;
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
