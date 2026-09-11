import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { acceptedImageFromFiles, acceptedImageMediaTypes, imageInputFromFiles, isAcceptedImageMediaType, isLocalImageObjectUrl } from "../src/app/image-message.js";
import { mergeChatTimeline } from "../src/app/MessageLog.js";

function file(name: string, type: string): File {
  return new File(["image-bytes"], name, { type });
}

void test("image input accepts only the initial raster MIME allowlist", () => {
  assert.deepEqual(acceptedImageMediaTypes, ["image/jpeg", "image/png", "image/webp"]);
  assert.equal(isAcceptedImageMediaType("image/PNG"), true);
  assert.equal(isAcceptedImageMediaType("image/gif"), false);
  assert.equal(acceptedImageFromFiles([file("screenshot.png", "image/png")])?.name, "screenshot.png");
  assert.equal(acceptedImageFromFiles([file("animation.gif", "image/gif")]), null);
  assert.equal(imageInputFromFiles([file("shot.webp", "image/webp")], "clipboard")?.source, "clipboard");
});

void test("image projection permits only endpoint-local Blob URLs", () => {
  assert.equal(isLocalImageObjectUrl("blob:https://branch.example/a0f8"), true);
  assert.equal(isLocalImageObjectUrl("https://image.example/screenshot.png"), false);
  assert.equal(isLocalImageObjectUrl("data:image/png;base64,unsafe"), false);
});

void test("message log image surface remains projection-only and never creates a network image URL", async () => {
  const source = await readFile(resolve(process.cwd(), "src/app/image-message.tsx"), "utf8");
  assert.match(source, /onObjectUrlReleased/);
  assert.match(source, /loadObjectUrl/);
  assert.match(source, /IntersectionObserver/);
  assert.match(source, /isLocalImageObjectUrl\(objectUrl\)/);
  assert.match(source, /URL\.revokeObjectURL/);
  assert.match(source, /src=\{objectUrl\}/);
  assert.match(source, /aria-label="Open shared image"/);
  assert.match(source, /className="pwa-image-preview-full"/);
  assert.match(source, /className="pwa-image-preview-title"/);
  assert.match(source, /aria-label="Close image preview"/);
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|https?:\\\/\\\//);
});

void test("message-log timeline interleaves text and image projections deterministically", () => {
  const timeline = mergeChatTimeline(
    [{ messageId: "text-b", contactId: "c", body: "Later", direction: "incoming", sentAt: 20, deliveryState: "received" }],
    [{ messageId: "image-a", direction: "outgoing", sentAt: 10, mediaType: "image/png", width: 640, height: 480, objectUrl: "blob:https://branch.example/a" }]
  );
  assert.deepEqual(timeline.map((entry) => entry.messageId), ["image-a", "text-b"]);
});
