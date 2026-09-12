import assert from "node:assert/strict";
import { test } from "node:test";

import { clientMonitorCountBucket, clientMonitorEvent, clientMonitorEventForCategories, clientMonitorOutboxItems } from "../src/app/client-monitor.js";

void test("client monitor reduces receipt traces to an allow-listed redacted event", () => {
  assert.deepEqual(clientMonitorEvent({ at: 1_700_000_000_000, detail: "delivery receipt: read_unmatched" }), {
    at: "2023-11-14T22:13:20.000Z",
    category: "receipts",
    event: "receipt.read_unmatched"
  });
  assert.deepEqual(clientMonitorEvent({ at: 1_700_000_000_000, detail: "delivery receipt: read_failed_network" }), {
    at: "2023-11-14T22:13:20.000Z",
    category: "receipts",
    event: "receipt.read_failed"
  });
});

void test("client monitor never forwards arbitrary local trace detail", () => {
  assert.deepEqual(clientMonitorEvent({ at: 1_700_000_000_000, detail: "relay notice: peer abc delivery 123" }), {
    at: "2023-11-14T22:13:20.000Z",
    category: "transport",
    event: "transport.relay_notice"
  });
  assert.equal(clientMonitorEvent({ at: 1_700_000_000_000, detail: "message plaintext: do not export" }), null);
});

void test("client monitor honours the selected local trace categories", () => {
  const receipt = { at: 1_700_000_000_000, detail: "delivery receipt: read_matched" };
  const frame = { at: 1_700_000_000_000, detail: "outbound frame: ENVELOPE" };
  assert.notEqual(clientMonitorEventForCategories(receipt, ["receipts"]), null);
  assert.equal(clientMonitorEventForCategories(frame, ["receipts"]), null);
});

void test("client monitor uses bounded count buckets rather than contact or message identifiers", () => {
  assert.equal(clientMonitorCountBucket(0), "zero");
  assert.equal(clientMonitorCountBucket(1), "one");
  assert.equal(clientMonitorCountBucket(4), "two_to_four");
  assert.equal(clientMonitorCountBucket(8), "five_to_eight");
  assert.equal(clientMonitorCountBucket(9), "nine_plus");
});

void test("client monitor assigns only ephemeral outbox display refs", () => {
  const items = clientMonitorOutboxItems([
    { messageId: "canonical-id-stays-local", deliveredAt: null },
    { messageId: "another-local-id", deliveredAt: 1 }
  ]);
  assert.deepEqual(items, [
    { ref: "m1", state: "awaiting_delivery" },
    { ref: "m2", state: "awaiting_read" }
  ]);
  assert.doesNotMatch(JSON.stringify(items), /canonical|another/);
});
