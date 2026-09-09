import { test } from "node:test";
import assert from "node:assert/strict";

import { DeliveryDedupWindow } from "../src/connectivity/delivery-dedup-window.js";

void test("reserves duplicate deliveries before async work can append twice", async () => {
  const window = new DeliveryDedupWindow(4);
  let decryptCount = 0;
  let appendCount = 0;

  const receive = async (deliveryId: string): Promise<void> => {
    if (!window.reserve(deliveryId)) {
      return;
    }
    decryptCount += 1;
    await Promise.resolve();
    appendCount += 1;
  };

  await Promise.all([receive("delivery-1"), receive("delivery-1")]);

  assert.equal(decryptCount, 1);
  assert.equal(appendCount, 1);
  assert.equal(window.size, 1);
});

void test("keeps distinct delivery identifiers independent", () => {
  const window = new DeliveryDedupWindow(4);

  assert.equal(window.reserve("delivery-1"), true);
  assert.equal(window.reserve("delivery-2"), true);
  assert.equal(window.size, 2);
});

void test("evicts the oldest identifier at the explicit capacity", () => {
  const window = new DeliveryDedupWindow(2);

  assert.equal(window.reserve("delivery-1"), true);
  assert.equal(window.reserve("delivery-2"), true);
  assert.equal(window.reserve("delivery-3"), true);
  assert.equal(window.size, 2);
  assert.equal(window.reserve("delivery-1"), true);
  assert.equal(window.reserve("delivery-2"), true);
  assert.equal(window.reserve("delivery-1"), false);
});

void test("reset starts a fresh live-session window", () => {
  const window = new DeliveryDedupWindow(2);

  assert.equal(window.reserve("delivery-1"), true);
  window.reset();
  assert.equal(window.size, 0);
  assert.equal(window.reserve("delivery-1"), true);
});
