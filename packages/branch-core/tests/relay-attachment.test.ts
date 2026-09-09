import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeDraftRelayAttachmentFrameText,
  maxDraftRelayCiphertextBytes
} from "../src/protocol/v0/relay-attachment.js";

test("relay attachment gives ENVELOPE ciphertext its dedicated bounded allowance", () => {
  const frame = {
    type: "ENVELOPE",
    session_id: Buffer.alloc(32, 1).toString("base64url"),
    route_id: Buffer.alloc(16, 2).toString("base64url"),
    origin_route_id: Buffer.alloc(16, 3).toString("base64url"),
    path_epoch: 0,
    stream_id: 0,
    delivery_id: Buffer.alloc(16, 4).toString("base64url"),
    ciphertext: "A".repeat(maxDraftRelayCiphertextBytes),
    ack_requested: true
  };

  assert.equal(decodeDraftRelayAttachmentFrameText(JSON.stringify(frame)).type, "ENVELOPE");
  assert.throws(
    () => decodeDraftRelayAttachmentFrameText(JSON.stringify({
      ...frame,
      ciphertext: "A".repeat(maxDraftRelayCiphertextBytes + 1)
    })),
    /invalid ciphertext/
  );
});
