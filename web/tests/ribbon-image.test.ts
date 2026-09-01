import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyColorShift,
  centerCrop,
  cropEdges,
  mildCameraPerspective,
  resizeNearest,
  rotateRight,
  screenshotScale
} from "../src/visual/corpus.js";
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

void test("ribbon seal local transform corpus records decode outcomes", async (t) => {
  const generated = generateRibbonSeal(wrapper, { modulePitch: 16, quietZone: 8 });
  const source = generated.image;

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly transform: (image: RibbonImageData) => RibbonImageData;
    readonly expected: "beacon_accepted" | "no_carrier_detected";
  }> = [
    {
      name: "resize-short-side-640",
      transform: (image) => resizeNearest(image, 640, 640),
      expected: "beacon_accepted"
    },
    {
      name: "resize-short-side-480",
      transform: (image) => resizeNearest(image, 480, 480),
      expected: "beacon_accepted"
    },
    {
      name: "resize-short-side-240",
      transform: (image) => resizeNearest(image, 240, 240),
      expected: "beacon_accepted"
    },
    {
      name: "resize-short-side-200",
      transform: (image) => resizeNearest(image, 200, 200),
      expected: "no_carrier_detected"
    },
    {
      name: "center-thumbnail-80-percent",
      transform: (image) =>
        centerCrop(image, Math.round(image.width * 0.8), Math.round(image.height * 0.8)),
      expected: "beacon_accepted"
    },
    {
      name: "edge-crop-5-percent",
      transform: (image) => cropEdges(image, { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 }),
      expected: "beacon_accepted"
    },
    {
      name: "edge-crop-10-percent",
      transform: (image) => cropEdges(image, { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 }),
      expected: "beacon_accepted"
    },
    {
      name: "edge-crop-15-percent",
      transform: (image) => cropEdges(image, { top: 0.15, right: 0.15, bottom: 0.15, left: 0.15 }),
      expected: "no_carrier_detected"
    },
    {
      name: "rotate-90",
      transform: (image) => rotateRight(image, 90),
      expected: "beacon_accepted"
    },
    {
      name: "rotate-180",
      transform: (image) => rotateRight(image, 180),
      expected: "beacon_accepted"
    },
    {
      name: "rotate-270",
      transform: (image) => rotateRight(image, 270),
      expected: "beacon_accepted"
    },
    {
      name: "brightness-contrast-gamma-saturation",
      transform: (image) =>
        applyColorShift(image, {
          brightness: 10,
          contrast: 1.12,
          gamma: 0.92,
          saturation: 0.78,
          whiteBalance: { red: 1.04, green: 1, blue: 0.94 }
      }),
      expected: "beacon_accepted"
    },
    {
      name: "strong-color-shift",
      transform: (image) =>
        applyColorShift(image, {
          brightness: 35,
          contrast: 1.4,
          gamma: 0.75,
          saturation: 0.45,
          whiteBalance: { red: 1.15, green: 1, blue: 0.85 }
        }),
      expected: "beacon_accepted"
    },
    {
      name: "screenshot-scale-2",
      transform: (image) => screenshotScale(image, 2),
      expected: "beacon_accepted"
    },
    {
      name: "screenshot-scale-4",
      transform: (image) => screenshotScale(image, 4),
      expected: "beacon_accepted"
    },
    {
      name: "mild-camera-perspective",
      transform: mildCameraPerspective,
      expected: "no_carrier_detected"
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const transformed = testCase.transform(source);
      const decoded = decodeRibbonSeal(transformed);

      assert.equal(decoded.status, testCase.expected);
      if (decoded.status === "beacon_accepted") {
        assert.deepEqual(decoded.frame.payload, branchWrapperBytes(wrapper));
      }
    });
  }
});

function blankImage(width: number, height: number): RibbonImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  for (let index = 3; index < data.length; index += 4) {
    data[index] = 255;
  }
  return { width, height, data };
}
