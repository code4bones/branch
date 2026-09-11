import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { localImageProjectionMemoKey, localImageProjectionsForContact } from "../src/state/hooks.js";
import type { ImageMessageProjection } from "../src/state/slices/image-message-projections-slice.js";

function projection(messageId: string, contactId: string): ImageMessageProjection {
  return {
    messageId,
    contactId,
    direction: "incoming",
    sentAt: 1,
    mediaType: "image/png",
    byteCount: 3,
    width: 1,
    height: 3
  };
}

void test("active image projection memo key ignores another contact but tracks rendered metadata", () => {
  const active = projection("active-image", "contact-a");
  const before = localImageProjectionsForContact({ [active.messageId]: active }, "contact-a");
  const afterUnrelatedUpdate = localImageProjectionsForContact({
    [active.messageId]: active,
    "other-image": projection("other-image", "contact-b")
  }, "contact-a");

  assert.equal(localImageProjectionMemoKey(afterUnrelatedUpdate), localImageProjectionMemoKey(before));
  assert.notEqual(
    localImageProjectionMemoKey(localImageProjectionsForContact({
      [active.messageId]: { ...active, width: active.width + 1 },
      "other-image": projection("other-image", "contact-b")
    }, "contact-a")),
    localImageProjectionMemoKey(before)
  );
});

void test("local image hook retains Blob loaders when its contact memo key is unchanged", async () => {
  const source = await readFile(resolve(process.cwd(), "src/state/hooks.ts"), "utf8");
  assert.match(source, /localImageProjectionsForContact\(allProjections, contactId\)/);
  assert.match(source, /localImageProjectionMemoKey\(projections\)/);
  assert.match(source, /}\)\), \[contactId, projectionKey\]\);/);
});
