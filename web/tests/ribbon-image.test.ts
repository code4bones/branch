import { test } from "node:test";
import assert from "node:assert/strict";

import {
  branchWrapperBytes,
  decodeRibbonFrame,
  decodeRibbonSeal,
  encodeRibbonFrame,
  generateRibbonSeal,
  maxRibbonPayloadBytes,
  type RibbonImageData
} from "../src/visual/ribbon-image.js";

const wrapper =
  "BRANCH0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

void test("ribbon seal QR preserves exact BRANCH0 payload bytes", () => {
  const generated = generateRibbonSeal(wrapper, { modulePitch: 8, quietZone: 4 });
  const decoded = decodeRibbonSeal(generated.image);

  assert.equal(decoded.status, "beacon_accepted");
  assert.deepEqual(decoded.frame.payload, branchWrapperBytes(wrapper));
  assert.equal(generated.diagnostics.profile, "ribbon-seal/0");
  assert.equal(generated.diagnostics.errorCorrectionLevel, "H");
  assert.equal(generated.diagnostics.payloadLength, branchWrapperBytes(wrapper).byteLength);
});

void test("ribbon frame rejects corrupted payload CRC", () => {
  const payload = branchWrapperBytes(wrapper);
  const frame = encodeRibbonFrame(payload);
  const payloadIndex = frame.length - 5;
  frame[payloadIndex] = (frame[payloadIndex] ?? 0) ^ 0xff;

  assert.deepEqual(decodeRibbonFrame(frame), { status: "visual_crc_failed" });
});

void test("ribbon decoder reports no carrier for blank image", () => {
  const image = blankImage(256, 256);

  assert.deepEqual(decodeRibbonSeal(image), { status: "no_carrier_detected" });
});

void test("ribbon frame rejects non-BRANCH0 payload kind", () => {
  const frame = encodeRibbonFrame(new TextEncoder().encode("not-a-branch-wrapper"));

  assert.deepEqual(decodeRibbonFrame(frame), { status: "payload_not_branch_wrapper" });
});

void test("ribbon frame bounds payload size", () => {
  const payload = new Uint8Array(maxRibbonPayloadBytes + 1);

  assert.throws(() => encodeRibbonFrame(payload), /payload too large/);
});

function blankImage(width: number, height: number): RibbonImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  for (let index = 3; index < data.length; index += 4) {
    data[index] = 255;
  }
  return { width, height, data };
}
