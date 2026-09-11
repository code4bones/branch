import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { composeOutgoingText } from "../src/app/message-composition.js";
import { createAppStore } from "../src/state/store.js";

void test("message selection is local, bounded, and resets when another chat is selected", () => {
  const store = createAppStore();
  store.getState().toggleMessageSelection("contact-a", "message-1");
  store.getState().toggleMessageSelection("contact-a", "message-2");
  assert.deepEqual(store.getState().selectedMessageIds, ["message-1", "message-2"]);

  store.getState().toggleMessageSelection("contact-b", "message-3");
  assert.deepEqual(store.getState().selectedMessageIds, ["message-3"]);
  assert.equal(store.getState().messageActionContactId, "contact-b");
  store.getState().clearMessageSelection();
  assert.deepEqual(store.getState().selectedMessageIds, []);
  assert.equal(store.getState().messageActionContactId, null);
});

void test("local deletion removes rendered messages and unsent local outbox work without transport", () => {
  const store = createAppStore();
  store.getState().appendMessage({ messageId: "message-1", contactId: "contact-1", direction: "outgoing", body: "one", sentAt: 1, deliveryState: "pending" });
  store.getState().appendMessage({ messageId: "message-2", contactId: "contact-1", direction: "incoming", body: "two", sentAt: 2, deliveryState: "received" });
  store.getState().queueMessage({ messageId: "message-1", applicationMessageId: "app-1", contactId: "contact-1", createdAt: 1, nextAttemptAt: 1, attempts: 0, lastDeliveryId: null, deliveredAt: null });

  const deleted = store.getState().deleteMessagesLocally("contact-1", ["message-1"]);
  assert.deepEqual(deleted.map((message) => message.messageId), ["message-1"]);
  assert.deepEqual(store.getState().messagesByContactId["contact-1"]?.map((message) => message.messageId), ["message-2"]);
  assert.deepEqual(store.getState().outbox, []);
});

void test("a forward composes only visible text with fresh local and application identities", () => {
  const ids = ["new-local-message", "new-application-message"];
  const forwarded = composeOutgoingText({
    contactId: "destination-contact",
    body: "visible text only",
    createdAt: 123,
    createId: () => ids.shift() ?? ""
  });

  assert.deepEqual(forwarded, {
    message: {
      messageId: "new-local-message",
      contactId: "destination-contact",
      direction: "outgoing",
      body: "visible text only",
      sentAt: 123,
      deliveryState: "pending",
      applicationMessageId: "new-application-message"
    },
    applicationMessageId: "new-application-message"
  });
});

void test("desktop uses right-click while touch long-press and selection clicks stay local", async () => {
  const messageLog = await readFile(resolve(process.cwd(), "src/app/MessageLog.tsx"), "utf8");
  const chatPage = await readFile(resolve(process.cwd(), "src/pages/ChatPage.tsx"), "utf8");
  const styles = await readFile(resolve(process.cwd(), "public/pwa.css"), "utf8");

  assert.match(messageLog, /trigger=\{hasMessageActions \? \["contextMenu"\] : \[\]\}/);
  assert.match(messageLog, /key: "reply", label: "Reply"/);
  assert.match(messageLog, /onReply\?: \(applicationMessageId: string\) => void;/);
  assert.match(messageLog, /className=\{`pwa-chat-image-trigger is-\$\{entry\.image\.direction\}`\}/);
  assert.match(messageLog, /classList\.add\("is-reply-target"\)/);
  assert.match(chatPage, /onReplyMessage=\{\(applicationMessageId\) => \{ setReplyToMessageId\(applicationMessageId\);/);
  assert.doesNotMatch(messageLog, /key: "forward"|key: "delete"|onForward|onDelete/);
  assert.match(messageLog, /onPointerDown=\{onPointerDown\}/);
  assert.match(messageLog, /longPressDurationMs = 550/);
  assert.match(messageLog, /if \(selectionActive\) onToggleSelection\?\.\(\);/);
  assert.doesNotMatch(messageLog, /EllipsisOutlined|Message actions/);
  assert.match(chatPage, /pwa-chat-bulk-actions pwa-chat-bulk-actions-bottom/);
  assert.match(chatPage, /bulkActionsMeasureRef/);
  assert.match(chatPage, /ResizeObserver\(updatePlacement\)/);
  assert.match(chatPage, /pwa-chat-bulk-selection-count/);
  assert.match(chatPage, /className="pwa-chat-bulk-item"/);
  assert.match(chatPage, /className="pwa-chat-bulk-action"/);
  assert.match(chatPage, /key="cancel">\n {6}<Button className="pwa-chat-bulk-action" onClick=\{cancelMessageSelection\}[^>]*>Cancel<\/Button>/);
  assert.match(chatPage, /bulkActionItems\(\)\.slice\(0, topBulkActionCount\)/);
  assert.match(chatPage, /bulkActionItems\(\)\.slice\(topBulkActionCount\)/);
  assert.match(styles, /\.pwa-chat-message\.is-selected \{\n {2}background: #21698f;/);
  assert.doesNotMatch(styles, /\.pwa-chat-message\.is-outgoing\.is-selected|\.pwa-chat-message\.is-service\.is-selected/);
  assert.doesNotMatch(styles, /\.pwa-chat-message\.is-selected \{[^}]+(?:outline|box-shadow):/);
  assert.match(styles, /\.pwa-chat-bulk-actions-measure \{[\s\S]*visibility: hidden;/);
  assert.match(styles, /\.pwa-chat-bulk-actions-bottom \{\n {2}margin: 8px 16px 10px;/);
  assert.match(styles, /\.pwa-chat-bulk-item \{[\s\S]*border-radius: 999px;/);
  assert.match(styles, /\.pwa-chat-bulk-action\.ant-btn \{[\s\S]*background: transparent;/);
  assert.match(styles, /\.pwa-chat-bulk-actions \{[\s\S]*margin: 12px 16px 8px;/);
});
