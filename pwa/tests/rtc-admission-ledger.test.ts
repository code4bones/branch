import assert from "node:assert/strict";
import test from "node:test";

import { RTCAdmissionLedger } from "../src/connectivity/rtc-admission-ledger.js";

void test("RTC admission ledger admits an exact duplicate but rejects conflicting reuse", async () => {
  const ledger = new RTCAdmissionLedger(2);
  const first = { senderPeerId: "peer-a", streamId: 0, deliveryId: "delivery-a", ciphertext: new Uint8Array([1, 2]), expiresAt: 100, now: 1 };
  assert.deepEqual(await ledger.reserve(first), { kind: "first" });
  assert.deepEqual(await ledger.reserve(first), { kind: "duplicate_pending" });
  assert.equal(ledger.admit("peer-a", 0, "delivery-a", 2), true);
  assert.deepEqual(await ledger.reserve({ ...first, now: 3 }), { kind: "duplicate_admitted" });
  assert.deepEqual(await ledger.reserve({ ...first, ciphertext: new Uint8Array([3]), now: 4 }), { kind: "conflict" });
});

void test("RTC admission ledger is bounded and expires with the direct session", async () => {
  const ledger = new RTCAdmissionLedger(1);
  await ledger.reserve({ senderPeerId: "peer-a", streamId: 0, deliveryId: "delivery-a", ciphertext: new Uint8Array([1]), expiresAt: 10, now: 1 });
  await ledger.reserve({ senderPeerId: "peer-a", streamId: 0, deliveryId: "delivery-b", ciphertext: new Uint8Array([2]), expiresAt: 10, now: 2 });
  assert.equal(ledger.size, 1);
  assert.equal(ledger.admit("peer-a", 0, "delivery-b", 10), false);
  assert.equal(ledger.size, 0);
});
