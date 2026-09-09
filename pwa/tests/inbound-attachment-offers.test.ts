import assert from "node:assert/strict";
import { test } from "node:test";

import { createAppStore } from "../src/state/store.js";
import { maxInboundAttachmentOffers, type VerifiedInboundAttachmentOffer } from "../src/state/slices/inbound-attachment-offers-slice.js";

function offer(peerId: string, transferId: string, callbacks: Pick<VerifiedInboundAttachmentOffer, "onAccept" | "onReject">): VerifiedInboundAttachmentOffer {
  return {
    peerId,
    transferId,
    fileName: "verified-report.pdf",
    mediaType: "application/pdf",
    byteCount: 1_536,
    expiresAt: 2_000,
    receivedAt: 1_000,
    ...callbacks
  };
}

void test("shows only a bounded volatile projection after the adapter stages a verified offer", () => {
  const store = createAppStore();
  const staged = store.getState().stageVerifiedInboundAttachmentOffer(offer("peer-a", "transfer-a", {
    onAccept: () => Promise.resolve(),
    onReject: () => Promise.resolve()
  }));

  assert.equal(staged, true);
  assert.deepEqual(store.getState().inboundAttachmentOffersByPeerId["peer-a"], {
    peerId: "peer-a",
    transferId: "transfer-a",
    fileName: "verified-report.pdf",
    mediaType: "application/pdf",
    byteCount: 1_536,
    expiresAt: 2_000,
    receivedAt: 1_000,
    responseState: "pending",
    responseError: null
  });
  assert.equal(store.getState().stageVerifiedInboundAttachmentOffer(offer("peer-a", "transfer-b", {
    onAccept: () => Promise.resolve(),
    onReject: () => Promise.resolve()
  })), false);
});

void test("runs only the explicit chosen decision and removes a successfully decided offer", async () => {
  const store = createAppStore();
  const decisions: string[] = [];
  store.getState().stageVerifiedInboundAttachmentOffer(offer("peer-a", "transfer-a", {
    onAccept: () => { decisions.push("accept"); return Promise.resolve(); },
    onReject: () => { decisions.push("reject"); return Promise.resolve(); }
  }));

  assert.equal(await store.getState().respondToInboundAttachmentOffer("peer-a", "accept"), "sent");
  assert.deepEqual(decisions, ["accept"]);
  assert.equal(store.getState().inboundAttachmentOffersByPeerId["peer-a"], undefined);
  assert.equal(await store.getState().respondToInboundAttachmentOffer("peer-a", "reject"), "not_found");
});

void test("keeps an offer pending when its user-chosen live decision cannot be sent", async () => {
  const store = createAppStore();
  store.getState().stageVerifiedInboundAttachmentOffer(offer("peer-a", "transfer-a", {
    onAccept: () => Promise.reject(new Error("live transit unavailable")),
    onReject: () => Promise.resolve()
  }));

  assert.equal(await store.getState().respondToInboundAttachmentOffer("peer-a", "accept"), "failed");
  assert.equal(store.getState().inboundAttachmentOffersByPeerId["peer-a"]?.responseState, "pending");
  assert.match(store.getState().inboundAttachmentOffersByPeerId["peer-a"]?.responseError ?? "", /Could not send/);
});

void test("enforces the UI offer bound without retaining file bytes", () => {
  const store = createAppStore();
  for (let index = 0; index < maxInboundAttachmentOffers; index += 1) {
    assert.equal(store.getState().stageVerifiedInboundAttachmentOffer(offer(`peer-${String(index)}`, `transfer-${String(index)}`, {
      onAccept: () => Promise.resolve(),
      onReject: () => Promise.resolve()
    })), true);
  }
  assert.equal(store.getState().stageVerifiedInboundAttachmentOffer(offer("peer-overflow", "transfer-overflow", {
    onAccept: () => Promise.resolve(),
    onReject: () => Promise.resolve()
  })), false);
  assert.equal(Object.keys(store.getState().inboundAttachmentOffersByPeerId).length, maxInboundAttachmentOffers);
  assert.equal(JSON.stringify(store.getState().inboundAttachmentOffersByPeerId).includes("onAccept"), false);
});
