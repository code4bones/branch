import assert from "node:assert/strict";
import { test } from "node:test";

import { clientMonitorEvent } from "../src/app/client-monitor.js";

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
