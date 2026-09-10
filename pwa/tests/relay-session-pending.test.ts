import assert from "node:assert/strict";
import { test } from "node:test";

import {
  armBestEffortPendingAbandonment,
  clearDelivery,
  clearPendingAbandonment,
  messageForDelivery,
  trackDelivery
} from "../src/connectivity/relay-session.js";

void test("a fresh relay delivery remains mapped to its original local message", () => {
  trackDelivery("outer-retry-2", "contact-1", "message-1", () => {});
  assert.deepEqual(messageForDelivery("outer-retry-2"), { contactId: "contact-1", messageId: "message-1" });
  clearDelivery("outer-retry-2");
  assert.equal(messageForDelivery("outer-retry-2"), undefined);
});

void test("best-effort envelope expiry abandons only its local pending entry and never retries", async () => {
  const abandoned: string[] = [];
  const client = {
    abandonPendingEnvelope: (deliveryId: string): boolean => {
      abandoned.push(deliveryId);
      return true;
    }
  };
  armBestEffortPendingAbandonment(client, "control-a", 0);
  await nextTurn();
  assert.deepEqual(abandoned, ["control-a"]);
  clearPendingAbandonment("control-a");
});

void test("settled best-effort entry has its local expiry cancelled", async () => {
  const abandoned: string[] = [];
  const client = {
    abandonPendingEnvelope: (deliveryId: string): boolean => {
      abandoned.push(deliveryId);
      return true;
    }
  };
  armBestEffortPendingAbandonment(client, "control-b", 0);
  clearPendingAbandonment("control-b");
  await nextTurn();
  assert.deepEqual(abandoned, []);
});

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}
