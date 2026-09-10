import assert from "node:assert/strict";
import { test } from "node:test";

import { attachmentSendAdmission, installAttachmentSendBridge, notifyAttachmentSendProgress, offerSelectedAttachment, subscribeAttachmentSendProgress } from "../src/app/attachment-send-bridge.js";
import {
  clearTransientCompletedAttachment,
  downloadVerifiedCompletedAttachment,
  inboundAttachmentCompletionHandler,
  stageVerifiedCompletedAttachment,
  type AttachmentDownloadEnvironment,
  type InboundAttachmentCompletion
} from "../src/app/transient-attachment-presentation.js";
import { createAppStore } from "../src/state/store.js";

function completed(peerId = "peer-a", transferId = "transfer-a", expiresAt = Date.now() + 60_000): InboundAttachmentCompletion {
  return {
    peerId,
    transferId,
    fileName: "verified-report.pdf",
    mediaType: "application/pdf",
    byteCount: 3,
    expiresAt
  };
}

void test("stages only bounded verified completion metadata and copies volatile bytes", () => {
  const store = createAppStore();
  const attachment = completed();
  const source = new Uint8Array([1, 2, 3]);

  assert.equal(stageVerifiedCompletedAttachment(store, attachment, source), true);
  source.fill(9);
  assert.deepEqual(store.getState().completedAttachmentsByPeerId["peer-a"], {
    ...attachment,
    completedAt: store.getState().completedAttachmentsByPeerId["peer-a"]?.completedAt
  });
  assert.equal(JSON.stringify(store.getState().completedAttachmentsByPeerId).includes("Uint8Array"), false);
  assert.equal(stageVerifiedCompletedAttachment(store, { ...attachment, byteCount: 4 }, new Uint8Array([1, 2, 3])), false);
  clearTransientCompletedAttachment(store, "peer-a");
});

void test("completion handler accepts only controller-shaped verified offers and replacement clears the old handle", () => {
  const store = createAppStore();
  const handler = inboundAttachmentCompletionHandler(store);
  handler.complete({ peerId: "peer-a", manifest: completed("peer-a", "transfer-a") }, new Uint8Array([1, 2, 3]));
  handler.complete({ peerId: "peer-a", manifest: completed("peer-a", "transfer-b") }, new Uint8Array([4, 5, 6]));

  assert.equal(store.getState().completedAttachmentsByPeerId["peer-a"]?.transferId, "transfer-b");
  handler.clear("peer-a");
  assert.equal(store.getState().completedAttachmentsByPeerId["peer-a"], undefined);
});

void test("explicit download creates, clicks, removes and immediately revokes the object URL", () => {
  const store = createAppStore();
  stageVerifiedCompletedAttachment(store, completed(), new Uint8Array([1, 2, 3]));
  const calls: string[] = [];
  const anchor = {
    href: "",
    download: "",
    style: { display: "" },
    click: () => { calls.push("click"); },
    remove: () => { calls.push("remove"); }
  } as unknown as HTMLAnchorElement;
  const environment: AttachmentDownloadEnvironment = {
    document: {
      body: { append: () => { calls.push("append"); } },
      createElement: () => anchor
    },
    url: {
      createObjectURL: () => { calls.push("create"); return "blob:verified"; },
      revokeObjectURL: (url) => { calls.push(`revoke:${url}`); }
    }
  };

  assert.equal(downloadVerifiedCompletedAttachment(store, "peer-a", environment), "downloaded");
  assert.deepEqual(calls, ["create", "append", "click", "remove", "revoke:blob:verified"]);
  assert.equal(anchor.download, "verified-report.pdf");
  assert.equal(store.getState().completedAttachmentsByPeerId["peer-a"], undefined);
  assert.equal(downloadVerifiedCompletedAttachment(store, "peer-a", environment), "not_found");
});

void test("download revokes its object URL even when the browser click fails", () => {
  const store = createAppStore();
  stageVerifiedCompletedAttachment(store, { ...completed(), fileName: "../unsafe\nname" }, new Uint8Array([1, 2, 3]));
  const calls: string[] = [];
  const anchor = {
    href: "",
    download: "",
    style: { display: "" },
    click: () => { calls.push("click"); throw new Error("blocked"); },
    remove: () => { calls.push("remove"); }
  } as unknown as HTMLAnchorElement;
  const environment: AttachmentDownloadEnvironment = {
    document: { body: { append: () => { calls.push("append"); } }, createElement: () => anchor },
    url: { createObjectURL: () => "blob:verified", revokeObjectURL: () => { calls.push("revoke"); } }
  };

  assert.throws(() => { downloadVerifiedCompletedAttachment(store, "peer-a", environment); }, /blocked/);
  assert.equal(anchor.download.includes("/"), false);
  assert.equal(anchor.download.includes("\n"), false);
  assert.deepEqual(calls, ["append", "click", "remove", "revoke"]);
  clearTransientCompletedAttachment(store, "peer-a");
});

void test("contact removal clears the hidden handle through the state lifecycle bridge", () => {
  const store = createAppStore();
  store.getState().upsertContact({
    contactId: "contact-a",
    displayName: "A",
    peerId: "peer-a",
    hpkePublicKey: "test-key",
    lastRouteHint: null
  });
  stageVerifiedCompletedAttachment(store, completed(), new Uint8Array([1, 2, 3]));
  store.getState().forgetContact("contact-a");

  assert.equal(store.getState().completedAttachmentsByPeerId["peer-a"], undefined);
  assert.equal(downloadVerifiedCompletedAttachment(store, "peer-a", null), "not_found");
});

void test("sender bridge requires current admission and passes the selected File straight to the controller", async () => {
  const store = createAppStore();
  let offered: File | null = null;
  const cleanup = installAttachmentSendBridge(store, {
    canSelect: () => ({ status: "ready" }),
    offer: (_peerId, file) => {
      offered = file;
      return Promise.resolve({ status: "offered", transferId: "transfer-a" });
    }
  });
  const selected = { name: "report.pdf", size: 3 } as File;

  assert.deepEqual(attachmentSendAdmission(store, "peer-a"), { status: "ready" });
  assert.deepEqual(await offerSelectedAttachment(store, "peer-a", selected), { status: "offered", transferId: "transfer-a" });
  assert.equal(offered, selected);
  cleanup();
  assert.deepEqual(attachmentSendAdmission(store, "peer-a"), { status: "unavailable" });
});

void test("sender progress bridge is volatile and removes an unsubscribed observer", () => {
  const store = createAppStore();
  const observed: string[] = [];
  const unsubscribe = subscribeAttachmentSendProgress(store, (event) => { observed.push(`${event.event}:${event.reason}`); });
  notifyAttachmentSendProgress(store, { event: "attachment.transfer.accepted", peerId: "peer-a", direction: "outbound", reason: "accepted" });
  unsubscribe();
  notifyAttachmentSendProgress(store, { event: "attachment.transfer.ended", peerId: "peer-a", direction: "outbound", reason: "accepted" });

  assert.deepEqual(observed, ["attachment.transfer.accepted:accepted"]);
});
