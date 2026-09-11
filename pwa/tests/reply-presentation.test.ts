import assert from "node:assert/strict";
import { test } from "node:test";

import { compactReplyText, resolveLocalReplyPreview } from "../src/app/reply-presentation.js";

const textId = "AQEBAQEBAQEBAQEBAQEBAQ";
const imageId = "AgICAgICAgICAgICAgICAg";

void test("reply previews resolve only local text and image projections", () => {
  const messages = [{ messageId: "local-text", applicationMessageId: textId, contactId: "contact", direction: "incoming" as const, body: "The original text", sentAt: 1, deliveryState: "received" as const }];
  const images = [{ messageId: imageId, direction: "incoming" as const, sentAt: 2, mediaType: "image/png" as const, width: 4, height: 3, objectUrl: "blob:local-image", caption: "Screenshot" }];

  assert.deepEqual(resolveLocalReplyPreview(textId, messages, images), { kind: "text", body: "The original text" });
  assert.deepEqual(resolveLocalReplyPreview(imageId, messages, images), { kind: "image", objectUrl: "blob:local-image", caption: "Screenshot" });
  assert.deepEqual(resolveLocalReplyPreview("AwMDAwMDAwMDAwMDAwMDAw", messages, images), { kind: "missing" });
});

void test("image reply previews retain the local-only Blob loader when the bubble has not entered view", () => {
  const loadObjectUrl = (): Promise<string | null> => Promise.resolve("blob:loaded-locally");
  const images = [{ messageId: imageId, direction: "incoming" as const, sentAt: 2, mediaType: "image/png" as const, width: 4, height: 3, loadObjectUrl }];
  assert.deepEqual(resolveLocalReplyPreview(imageId, [], images), { kind: "image", objectUrl: null, loadObjectUrl });
});

void test("reply text preview is compact without copying more content", () => {
  assert.equal(compactReplyText(` ${"a".repeat(150)} `), `${"a".repeat(139)}…`);
});
