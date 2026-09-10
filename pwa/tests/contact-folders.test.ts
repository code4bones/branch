import assert from "node:assert/strict";
import { test } from "node:test";

import { filterChatListByFolder } from "../src/state/contact-folder-filter.js";
import { normalizeContactFolderName } from "../src/state/contact-folders-model.js";
import { createAppStore } from "../src/state/store.js";

const folderOne = "11111111-1111-4111-8111-111111111111";
const folderTwo = "22222222-2222-4222-8222-222222222222";

void test("contact folders validate local display names without changing contact records", () => {
  assert.equal(normalizeContactFolderName("  Friends  "), "Friends");
  assert.equal(normalizeContactFolderName("e\u0301"), "é");
  assert.equal(normalizeContactFolderName(""), null);
  assert.equal(normalizeContactFolderName("x".repeat(49)), null);

  const store = createAppStore();
  store.getState().upsertContact({ contactId: "contact-a", displayName: "Alice", peerId: null, hpkePublicKey: null, lastRouteHint: null });
  assert.equal(store.getState().createContactFolder(folderOne, "Friends", 1), true);
  assert.equal(store.getState().assignContactFolder("contact-a", folderOne), true);

  assert.deepEqual(store.getState().contacts[0], {
    contactId: "contact-a", displayName: "Alice", peerId: null, hpkePublicKey: null, lastRouteHint: null
  });
  assert.equal(store.getState().contactFolderIdByContactId["contact-a"], folderOne);
});

void test("deleting a local folder unassigns contacts but preserves their conversations", () => {
  const store = createAppStore();
  store.getState().upsertContact({ contactId: "contact-a", displayName: "Alice", peerId: null, hpkePublicKey: null, lastRouteHint: null });
  store.getState().appendMessage({ messageId: "message-a", contactId: "contact-a", direction: "incoming", body: "local history", sentAt: 1, deliveryState: "received" });
  store.getState().createContactFolder(folderOne, "Friends", 1);
  store.getState().assignContactFolder("contact-a", folderOne);
  store.getState().deleteContactFolder(folderOne);

  assert.equal(store.getState().contacts.length, 1);
  assert.equal(store.getState().messagesByContactId["contact-a"]?.length, 1);
  assert.equal(store.getState().contactFolderIdByContactId["contact-a"], undefined);
});

void test("All keeps the chronological list while a local folder narrows it", () => {
  const entries = [
    { contact: { contactId: "contact-a", displayName: "Alice", peerId: null, hpkePublicKey: null, lastRouteHint: null }, lastMessage: null, unreadCount: 0 },
    { contact: { contactId: "contact-b", displayName: "Bob", peerId: null, hpkePublicKey: null, lastRouteHint: null }, lastMessage: null, unreadCount: 0 }
  ];
  assert.equal(filterChatListByFolder(entries, null, { "contact-a": folderOne }).length, 2);
  assert.deepEqual(filterChatListByFolder(entries, folderOne, { "contact-a": folderOne }).map((entry) => entry.contact.contactId), ["contact-a"]);
  assert.equal(filterChatListByFolder(entries, folderTwo, { "contact-a": folderOne }).length, 0);
});
