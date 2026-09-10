import assert from "node:assert/strict";
import { test } from "node:test";

import { deliveryStatePresentation } from "../src/app/MessageLog.js";

void test("outgoing delivery marks distinguish sent, delivered, and read", () => {
  assert.deepEqual(deliveryStatePresentation("relayed"), { label: "Sent", mark: "single-check" });
  assert.deepEqual(deliveryStatePresentation("delivered"), { label: "Delivered to recipient", mark: "double-check" });
  assert.deepEqual(deliveryStatePresentation("read"), { label: "Read by recipient", mark: "double-check" });
});
