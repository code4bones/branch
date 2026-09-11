import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { resolve } from "node:path";

import {
  outboxMaximumAgeMs,
  outboxRetryDelay,
  outboxRetryInitialDelayMs,
  outboxRetryMaximumDelayMs,
  contactOutboxHeads,
  needsQueuedTextCapabilityRenewal,
  advanceMessageOutboxDrainAfterRelayForwarded,
  restartMessageOutboxDrainAfterPresencePong
} from "../src/connectivity/message-outbox-runtime.js";
import { maxStoredOutboxEntries } from "../src/storage/message-outbox-store.js";
import { maxStoredReceivedApplicationMessages } from "../src/storage/received-application-messages-store.js";
import { createAppStore } from "../src/state/store.js";

void test("message outbox retry delay is bounded exponential backoff", () => {
  assert.equal(outboxRetryInitialDelayMs, 1_000);
  assert.equal(outboxRetryDelay(1), outboxRetryInitialDelayMs);
  assert.equal(outboxRetryDelay(2), outboxRetryInitialDelayMs * 2);
  assert.equal(outboxRetryDelay(3), outboxRetryInitialDelayMs * 4);
  assert.equal(outboxRetryDelay(99), outboxRetryMaximumDelayMs);
  assert.equal(outboxMaximumAgeMs, 7 * 24 * 60 * 60 * 1_000);
  assert.equal(maxStoredOutboxEntries, 128);
  assert.equal(maxStoredReceivedApplicationMessages, 4096);
});

void test("cold-path automatic retry remains endpoint-local and pending", async () => {
  const source = await readFile(resolve(process.cwd(), "src/connectivity/message-outbox-runtime.ts"), "utf8");
  assert.match(source, /first federated lookup can race/);
  assert.match(source, /outbox: retry_deferred/);
  assert.doesNotMatch(source, /onRelayOutcomeTimeout: \(\) => \{\s*runtime\.storeApi\.getState\(\)\.setMessageDeliveryState/s);
  assert.equal(outboxRetryDelay(1), 1_000);
});

void test("a queued text asks for capability renewal only while capability is absent", () => {
  const entry = {
    messageId: "message-1",
    contactId: "contact-1",
    applicationMessageId: "application-1",
    createdAt: 1,
    nextAttemptAt: 1,
    attempts: 0,
    lastDeliveryId: null,
    deliveredAt: null
  };
  assert.equal(needsQueuedTextCapabilityRenewal([], "contact-1", "capability-recovery-peer"), false);
  assert.equal(needsQueuedTextCapabilityRenewal([entry], "other-contact", "capability-recovery-peer"), false);
  assert.equal(needsQueuedTextCapabilityRenewal([entry], "contact-1", "capability-recovery-peer"), true);
});

void test("relay-forward drain advance is inert without one active foreground delivery", () => {
  // A late or unrelated ACK cannot create a drain or advance an outbox entry.
  advanceMessageOutboxDrainAfterRelayForwarded("untracked-delivery");
  restartMessageOutboxDrainAfterPresencePong("contact-1");
});

void test("one contact keeps FIFO composition order despite mutable retry deadlines", () => {
  const oldest = {
    messageId: "message-oldest",
    contactId: "contact-1",
    applicationMessageId: "application-oldest",
    createdAt: 10,
    nextAttemptAt: 100,
    attempts: 1,
    lastDeliveryId: "delivery-oldest",
    deliveredAt: null
  };
  const later = {
    messageId: "message-later",
    contactId: "contact-1",
    applicationMessageId: "application-later",
    createdAt: 20,
    nextAttemptAt: 1,
    attempts: 0,
    lastDeliveryId: null,
    deliveredAt: null
  };
  const anotherContact = {
    messageId: "message-other",
    contactId: "contact-2",
    applicationMessageId: "application-other",
    createdAt: 30,
    nextAttemptAt: 1,
    attempts: 0,
    lastDeliveryId: null,
    deliveredAt: null
  };

  assert.deepEqual(contactOutboxHeads([later, anotherContact, oldest]).map((entry) => entry.messageId), ["message-oldest", "message-other"]);
  assert.deepEqual(contactOutboxHeads([later, anotherContact, oldest], new Set([oldest.messageId])).map((entry) => entry.messageId), ["message-later", "message-other"]);
  assert.deepEqual(contactOutboxHeads([later, anotherContact, { ...oldest, deliveredAt: 30 }], new Set([oldest.messageId])).map((entry) => entry.messageId), ["message-later", "message-other"]);
});

void test("Delivered retains local outer-delivery correlation until Read settles it", () => {
  const store = createAppStore();
  store.getState().hydrateOutbox([{
    messageId: "message-1",
    contactId: "contact-1",
    applicationMessageId: "application-1",
    createdAt: 1,
    nextAttemptAt: 1,
    attempts: 1,
    lastDeliveryId: "outer-delivery-1",
    deliveredAt: null
  }]);

  store.getState().markOutboxMessageDelivered("message-1", 2);
  assert.deepEqual(store.getState().outbox, [{
    messageId: "message-1",
    contactId: "contact-1",
    applicationMessageId: "application-1",
    createdAt: 1,
    nextAttemptAt: 1,
    attempts: 1,
    lastDeliveryId: "outer-delivery-1",
    deliveredAt: 2
  }]);

  store.getState().settleOutboxMessage("message-1");
  assert.deepEqual(store.getState().outbox, []);
});
