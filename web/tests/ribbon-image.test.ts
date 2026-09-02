import { test } from "node:test";
import assert from "node:assert/strict";

import { resizeNearest, screenshotScale } from "@code4bones/branch-core/visual/corpus.js";
import { embedBlockPayload, extractBlockPayload, ribbonBlockProfile } from "@code4bones/branch-core/visual/ribbon-block.js";
import { decodeRibbonImage } from "@code4bones/branch-core/visual/ribbon-decode.js";
import {
  branchWrapperBytes,
  decodeRibbonFrame,
  encodeRibbonFrame,
  maxRibbonPayloadBytes,
  type RibbonImageData
} from "@code4bones/branch-core/visual/ribbon-image.js";

const wrapper =
  "BRANCH0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

void test("ribbon block frame preserves exact BRANCH0 payload bytes", () => {
  const payload = branchWrapperBytes(wrapper);
  const frame = encodeRibbonFrame(payload);
  const decoded = decodeRibbonFrame(frame);

  assert.equal(decoded.status, "beacon_accepted");
  assert.equal(decoded.frame.profileId, ribbonBlockProfile);
  assert.deepEqual(decoded.frame.payload, payload);
});

void test("ribbon frame rejects corrupted payload CRC", () => {
  const frame = encodeRibbonFrame(branchWrapperBytes(wrapper));
  const payloadIndex = frame.length - 5;
  frame[payloadIndex] = (frame[payloadIndex] ?? 0) ^ 0xff;

  assert.deepEqual(decodeRibbonFrame(frame), { status: "visual_crc_failed" });
});

void test("ribbon frame rejects non-BRANCH0 payload kind", () => {
  const frame = encodeRibbonFrame(new TextEncoder().encode("not-a-branch-wrapper"));

  assert.deepEqual(decodeRibbonFrame(frame), { status: "payload_not_branch_wrapper" });
});

void test("ribbon frame bounds payload size", () => {
  const payload = new Uint8Array(maxRibbonPayloadBytes + 1);

  assert.throws(() => encodeRibbonFrame(payload), /payload too large/);
});

void test("ribbon block decoder reports bounded failure for blank image", () => {
  const image = blankImage(640, 640);

  assert.deepEqual(decodeRibbonImage(image), { status: "block extraction failed", wrapper: "" });
});

void test("ribbon block carrier recovers exact frame bytes from full image", () => {
  const source = blankImage(1000, 1500);
  const frame = encodeRibbonFrame(branchWrapperBytes(wrapper));
  const region = fullRegion(source);
  const encoded = embedBlockPayload(source, frame, region);
  const extracted = extractBlockPayload(encoded, region);
  const decoded = decodeRibbonImage(encoded);

  assert.deepEqual(extracted, frame);
  assert.equal(decoded.status, "block decoded");
  assert.equal(decoded.wrapper, wrapper);
  assert.deepEqual(decoded.foundRegion, region);
});

void test("ribbon block carrier survives bounded resize and screenshot-style scaling", async (t) => {
  const source = blankImage(1000, 1500);
  const frame = encodeRibbonFrame(branchWrapperBytes(wrapper));
  const encoded = embedBlockPayload(source, frame, fullRegion(source));

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly transform: (image: RibbonImageData) => RibbonImageData;
    readonly expected: "block decoded" | "block extraction failed";
  }> = [
    { name: "resize-75", transform: (image) => resizeNearest(image, 750, 1125), expected: "block decoded" },
    { name: "resize-50", transform: (image) => resizeNearest(image, 500, 750), expected: "block extraction failed" },
    { name: "screenshot-scale-2", transform: (image) => screenshotScale(image, 2), expected: "block decoded" }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const decoded = decodeRibbonImage(testCase.transform(encoded));

      assert.equal(decoded.status, testCase.expected);
      assert.equal(decoded.wrapper, testCase.expected === "block decoded" ? wrapper : "");
    });
  }
});

function blankImage(width: number, height: number): RibbonImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 7;
    data[index + 1] = 17;
    data[index + 2] = 29;
    data[index + 3] = 255;
  }
  return { width, height, data };
}

function fullRegion(image: RibbonImageData): { readonly x: 0; readonly y: 0; readonly size: number; readonly width: number; readonly height: number } {
  return {
    x: 0,
    y: 0,
    size: Math.min(image.width, image.height),
    width: image.width,
    height: image.height
  };
}
