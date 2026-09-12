import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldPersistReadReceipt, type StoredReadReceiptEntry } from "../src/storage/read-receipt-outbox-store.js";

const pending: StoredReadReceiptEntry = { targetDeliveryId: "delivery-1", contactId: "contact-1", readAt: 1, receiptPending: true };
const settled: StoredReadReceiptEntry = { ...pending, receiptPending: false };

void test("a settled stored Read receipt is monotonic across unordered local saves", () => {
  assert.equal(shouldPersistReadReceipt(undefined, pending), true);
  assert.equal(shouldPersistReadReceipt(pending, settled), true);
  assert.equal(shouldPersistReadReceipt(settled, pending), false);
});
