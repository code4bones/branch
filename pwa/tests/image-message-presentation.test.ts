import assert from "node:assert/strict";
import { test } from "node:test";

import { stageVerifiedImageMessage } from "../src/app/image-message-presentation.js";
import { maxImageMessageProjections, type ImageMessageProjection } from "../src/state/slices/image-message-projections-slice.js";
import { createAppStore } from "../src/state/store.js";
import type { ImageMessageMediaStorePort } from "../src/storage/image-media-store.js";

function projection(messageId = "image-message-1", contactId = "contact-1"): ImageMessageProjection {
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

function memoryMediaStore(): ImageMessageMediaStorePort & { readonly acceptedBytes: readonly Uint8Array[] } {
  const accepted: Uint8Array[] = [];
  return {
    acceptedBytes: accepted,
    storeVerified: (_projection, bytes) => {
      accepted.push(new Uint8Array(bytes));
      return Promise.resolve("stored");
    },
    loadProjectionMetadata: () => Promise.resolve([]),
    loadBlob: () => Promise.resolve(null),
    deleteMessages: () => Promise.resolve(),
    deleteContact: () => Promise.resolve(),
    clear: () => Promise.resolve()
  };
}

void test("verified image staging keeps only serializable projection data in Zustand", async () => {
  const store = createAppStore();
  const media = memoryMediaStore();
  const source = new Uint8Array([1, 2, 3]);

  assert.equal(await stageVerifiedImageMessage(store, { projection: projection(), bytes: source }, media), "stored");
  source.fill(9);
  assert.deepEqual(media.acceptedBytes[0], new Uint8Array([1, 2, 3]));
  assert.deepEqual(store.getState().imageMessageProjectionsById["image-message-1"], projection());
  const serialized = JSON.stringify(store.getState().imageMessageProjectionsById);
  assert.equal(serialized.includes("Uint8Array"), false);
  assert.equal(serialized.includes("blob:"), false);
});

void test("projection rejects unknown media, unsafe dimensions and conflicting duplicate message identity", () => {
  const store = createAppStore();
  assert.equal(store.getState().stageImageMessageProjection({ ...projection(), mediaType: "image/svg+xml" as "image/png" }), false);
  assert.equal(store.getState().stageImageMessageProjection({ ...projection(), width: Number.MAX_SAFE_INTEGER, height: 2 }), false);
  assert.equal(store.getState().stageImageMessageProjection(projection()), true);
  assert.equal(store.getState().stageImageMessageProjection({ ...projection(), byteCount: 4 }), false);
});

void test("local message deletion releases its image projection without a remote effect", () => {
  const store = createAppStore();
  assert.equal(store.getState().stageImageMessageProjection(projection()), true);
  store.getState().appendMessage({
    messageId: "image-message-1",
    contactId: "contact-1",
    direction: "incoming",
    body: "",
    sentAt: 1,
    deliveryState: "received"
  });

  store.getState().deleteMessagesLocally("contact-1", ["image-message-1"]);
  assert.equal(store.getState().imageMessageProjectionsById["image-message-1"], undefined);
});

void test("contact removal releases all locally projected media for that contact", () => {
  const store = createAppStore();
  assert.equal(store.getState().stageImageMessageProjection(projection("image-1", "contact-1")), true);
  assert.equal(store.getState().stageImageMessageProjection(projection("image-2", "contact-2")), true);
  store.getState().upsertContact({
    contactId: "contact-1",
    displayName: "One",
    peerId: null,
    hpkePublicKey: null,
    lastRouteHint: null
  });

  store.getState().forgetContact("contact-1");
  assert.equal(store.getState().imageMessageProjectionsById["image-1"], undefined);
  assert.notEqual(store.getState().imageMessageProjectionsById["image-2"], undefined);
});

void test("projection hydration remains bounded and serializable", () => {
  const store = createAppStore();
  const projections = Array.from({ length: maxImageMessageProjections + 1 }, (_, index) => projection(`image-${String(index)}`));
  store.getState().hydrateImageMessageProjections(projections);
  assert.equal(Object.keys(store.getState().imageMessageProjectionsById).length, maxImageMessageProjections);
});
