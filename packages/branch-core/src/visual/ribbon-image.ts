import { embedBlockPayload, ribbonBlockProfile } from "./ribbon-block.js";

const magic = new Uint8Array([0x42, 0x52, 0x49, 0x4d, 0x47, 0x30]);
const branchWrapperPrefix = "BRANCH0.";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export const ribbonPayloadKindBranchWrapper = 0x01;
export const maxRibbonPayloadBytes = 768;

export type RibbonDecodeStatus =
  | "no_carrier_detected"
  | "visual_sync_failed"
  | "visual_crc_failed"
  | "payload_too_large"
  | "payload_kind_unsupported"
  | "payload_not_branch_wrapper"
  | "beacon_accepted";

export interface RibbonImageData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface RibbonFrame {
  readonly profileId: typeof ribbonBlockProfile;
  readonly flags: number;
  readonly payload: Uint8Array;
}

export interface RibbonCarrierDiagnostics {
  readonly profile: typeof ribbonBlockProfile;
  readonly payloadLength: number;
  readonly errorCorrectionLevel: "block-repeat";
}

export interface GeneratedRibbonCarrier {
  readonly image: RibbonImageData;
  readonly frame: Uint8Array;
  readonly diagnostics: RibbonCarrierDiagnostics;
}

export interface RibbonDecodeSuccess {
  readonly status: "beacon_accepted";
  readonly frame: RibbonFrame;
}

export interface RibbonDecodeFailure {
  readonly status: Exclude<RibbonDecodeStatus, "beacon_accepted">;
}

export type RibbonDecodeResult = RibbonDecodeSuccess | RibbonDecodeFailure;

export function branchWrapperBytes(wrapper: string): Uint8Array {
  if (!wrapper.startsWith(branchWrapperPrefix)) {
    throw new Error("payload must be a BRANCH0. wrapper");
  }
  return textEncoder.encode(wrapper);
}

export function encodeRibbonFrame(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > maxRibbonPayloadBytes) {
    throw new Error("payload too large");
  }

  const profile = textEncoder.encode(ribbonBlockProfile);
  if (profile.byteLength > 255) {
    throw new Error("profile id too large");
  }

  const frameLength = magic.byteLength + 1 + profile.byteLength + 1 + 2 + payload.byteLength + 4;
  const frame = new Uint8Array(frameLength);
  let offset = 0;
  frame.set(magic, offset);
  offset += magic.byteLength;
  frame[offset] = profile.byteLength;
  offset += 1;
  frame.set(profile, offset);
  offset += profile.byteLength;
  frame[offset] = ribbonPayloadKindBranchWrapper;
  offset += 1;
  frame[offset] = (payload.byteLength >> 8) & 0xff;
  frame[offset + 1] = payload.byteLength & 0xff;
  offset += 2;
  frame.set(payload, offset);
  offset += payload.byteLength;
  writeUint32BE(frame, offset, crc32c(payload));
  return frame;
}

export function decodeRibbonFrame(frame: Uint8Array): RibbonDecodeResult {
  if (frame.byteLength < magic.byteLength + 1 + 1 + 2 + 4) {
    return { status: "visual_sync_failed" };
  }

  let offset = 0;
  for (const expected of magic) {
    if (frame[offset] !== expected) {
      return { status: "visual_sync_failed" };
    }
    offset += 1;
  }

  const profileLength = frame[offset];
  offset += 1;
  if (profileLength === undefined || profileLength === 0) {
    return { status: "visual_sync_failed" };
  }
  if (offset + profileLength + 1 + 2 + 4 > frame.byteLength) {
    return { status: "visual_sync_failed" };
  }

  const profileId = decodeUTF8(frame.subarray(offset, offset + profileLength));
  offset += profileLength;
  if (profileId !== ribbonBlockProfile) {
    return { status: "payload_kind_unsupported" };
  }

  const flags = frame[offset];
  offset += 1;
  if (flags !== ribbonPayloadKindBranchWrapper) {
    return { status: "payload_kind_unsupported" };
  }

  const payloadLength = (readByte(frame, offset) << 8) | readByte(frame, offset + 1);
  offset += 2;
  if (payloadLength > maxRibbonPayloadBytes) {
    return { status: "payload_too_large" };
  }
  if (offset + payloadLength + 4 !== frame.byteLength) {
    return { status: "visual_sync_failed" };
  }

  const payload = frame.slice(offset, offset + payloadLength);
  offset += payloadLength;
  if (readUint32BE(frame, offset) !== crc32c(payload)) {
    return { status: "visual_crc_failed" };
  }

  const wrapper = decodeUTF8(payload);
  if (!wrapper.startsWith(branchWrapperPrefix)) {
    return { status: "payload_not_branch_wrapper" };
  }

  return {
    status: "beacon_accepted",
    frame: {
      profileId: ribbonBlockProfile,
      flags,
      payload
    }
  };
}

export function generateRibbonCarrier(branchWrapper: string): GeneratedRibbonCarrier {
  const payload = branchWrapperBytes(branchWrapper);
  const frame = encodeRibbonFrame(payload);
  const source = makeBlankRibbonImage(1000, 1500);

  return {
    frame,
    image: embedBlockPayload(source, frame, {
      x: 0,
      y: 0,
      size: Math.min(source.width, source.height),
      width: source.width,
      height: source.height
    }),
    diagnostics: {
      profile: ribbonBlockProfile,
      payloadLength: payload.byteLength,
      errorCorrectionLevel: "block-repeat"
    }
  };
}

function makeBlankRibbonImage(width: number, height: number): RibbonImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 7;
    data[index + 1] = 17;
    data[index + 2] = 29;
    data[index + 3] = 255;
  }
  return { width, height, data };
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
  for (let i = 0; i < table.length; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
    }
    table[i] = crc >>> 0;
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
    throw new Error("offset outside byte array");
  }
  return value;
}

function decodeUTF8(data: Uint8Array): string {
  try {
    return textDecoder.decode(data);
  } catch {
    return "";
  }
}
