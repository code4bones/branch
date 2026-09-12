import assert from "node:assert/strict";
import { test } from "node:test";

import { clientMonitorCountBucket, clientMonitorEvent, clientMonitorEventForCategories, clientMonitorMessageEvents, clientMonitorOutboxItems, type ClientMonitorMessage } from "../src/app/client-monitor.js";

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
  assert.deepEqual(clientMonitorEvent({ at: 1_700_000_000_000, detail: "delivery receipt: read_accepted_sent" }), {
    at: "2023-11-14T22:13:20.000Z",
    category: "receipts",
    event: "receipt.read_accepted"
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

void test("client monitor correlates only session-local message status transitions", () => {
  const previous = new Map<string, ClientMonitorMessage>();
  const outgoing = {
    messageId: "message-id-stays-local",
    contactId: "contact-stays-local",
    direction: "outgoing" as const,
    body: "never export this",
    sentAt: 1,
    deliveryState: "pending" as const
  };
  const initial = {
    "contact-stays-local": [outgoing]
  };
  assert.deepEqual(clientMonitorMessageEvents(initial, previous, false), []);
  const changed = clientMonitorMessageEvents({
    "contact-stays-local": [{ ...outgoing, deliveryState: "delivered" as const }]
  }, previous, true);
  assert.deepEqual(changed.map((event) => ({ category: event.category, event: event.event, message: event.message })), [{
    category: "messages",
    event: "message.status_changed",
    message: { ref: "m3", direction: "outgoing", status: "delivered" }
  }]);
  assert.doesNotMatch(JSON.stringify(changed), /contact|message-id|never export/);
});

void test("client monitor observes a new incoming bubble without its content", () => {
  const previous = new Map<string, ClientMonitorMessage>();
  void clientMonitorMessageEvents({}, previous, false);
  const events = clientMonitorMessageEvents({
    local: [{ messageId: "incoming-message", contactId: "local", direction: "incoming", body: "private", sentAt: 1, deliveryState: "received" }]
  }, previous, true);
  assert.deepEqual(events.map((event) => ({ category: event.category, event: event.event, message: event.message })), [{
    category: "messages",
    event: "message.observed",
    message: { ref: "m4", direction: "incoming", status: "received" }
  }]);
  assert.doesNotMatch(JSON.stringify(events), /incoming-message|private/);
});
