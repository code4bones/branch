import { useEffect } from "react";

import { loadStoredContacts } from "./contacts-store.js";
import { removeLegacyDemoState } from "./legacy-demo-cleanup.js";
import { loadStoredTimelinePage, type ConversationTimelineEntry } from "./messages-store.js";
import { loadStoredMessageRequests } from "./message-requests-store.js";
import { loadStoredReadState } from "./read-state-store.js";
import { loadStoredReadReceiptPolicy } from "./receipt-policy-store.js";
import { loadStoredContactDiscoveries } from "./contact-discovery-store.js";
import { loadStoredContactDiscoveryPolicy } from "./contact-discovery-policy-store.js";
import { loadStoredContactFolders } from "./contact-folders-store.js";
import { loadStoredOutbox } from "./message-outbox-store.js";
import { loadStoredReadReceiptOutbox } from "./read-receipt-outbox-store.js";
import { clearStoredLastOpenedChat, loadStoredLastOpenedChat } from "./last-opened-chat-store.js";
import type { MessageSummary } from "../state/slices/conversations-slice.js";
import { useAppStoreApi } from "../state/StoreProvider.js";

// Runs once on app start: hydrate contacts/messages/read-state from
// IndexedDB before RequireIdentity lets the chat UI through (see
// conversationsLoaded). Old demo-only records are removed narrowly before
// loading; real local conversations are never altered by this bootstrap.
export function useConversationsBootstrap(): void {
  const storeApi = useAppStoreApi();

  useEffect(() => {
    void (async () => {
      await removeLegacyDemoState();
      const [contacts, readState, messageRequests, sendReadReceipts, contactDiscoveries, allowContactDiscovery, lastOpenedChatId, contactFolderState, outbox, readReceiptOutbox] = await Promise.all([
        loadStoredContacts(),
        loadStoredReadState(),
        loadStoredMessageRequests(),
        loadStoredReadReceiptPolicy(),
        loadStoredContactDiscoveries(),
        loadStoredContactDiscoveryPolicy(),
        loadStoredLastOpenedChat(),
        loadStoredContactFolders(),
        loadStoredOutbox(),
        loadStoredReadReceiptOutbox()
      ]);
      const selectedContactId = lastOpenedChatId !== null && contacts.some((contact) => contact.contactId === lastOpenedChatId)
        ? lastOpenedChatId
        : null;
      if (lastOpenedChatId !== null && selectedContactId === null) {
        void clearStoredLastOpenedChat();
      }
      // A sidebar needs only one compact local preview per contact. History
      // itself is loaded by cursor after a conversation is selected.
      const messagePreviews: Record<string, readonly MessageSummary[]> = {};
      for (const contact of contacts) {
        const page = await loadStoredTimelinePage(contact.contactId, null, 1);
        const preview = sidebarPreview(page.entries[0]);
        if (preview !== null) messagePreviews[contact.contactId] = [preview];
      }

      storeApi.setState({
        contacts,
        selectedContactId,
        messagesByContactId: messagePreviews,
        lastReadAtByContactId: readState,
        incomingMessageRequests: messageRequests,
        contactDiscoveries,
        sendReadReceipts,
        allowContactDiscovery
      });
      // Folder metadata is a separate device-local UI projection. Hydration
      // binds assignments only to the contacts loaded from this same origin.
      storeApi.getState().hydrateContactFolders(contactFolderState.folders, contactFolderState.assignments);
      storeApi.getState().hydrateOutbox(outbox);
      storeApi.getState().hydrateReadReceiptOutbox(readReceiptOutbox);

      storeApi.getState().setConversationsLoaded();
    })().catch(() => {
      // IndexedDB unavailable (e.g. private browsing): keep the empty local
      // session state and still unblock the UI.
      storeApi.getState().setConversationsLoaded();
    });
  }, [storeApi]);
}

function sidebarPreview(entry: ConversationTimelineEntry | undefined): MessageSummary | null {
  if (entry === undefined) return null;
  if (entry.kind === "text") return entry.message;
  return {
    messageId: entry.image.messageId,
    contactId: entry.image.contactId,
    direction: entry.image.direction,
    body: entry.image.caption === undefined || entry.image.caption === "" ? "Photo" : entry.image.caption,
    sentAt: entry.image.sentAt,
    deliveryState: entry.image.direction === "incoming" ? "received" : "relayed",
    applicationMessageId: entry.image.messageId,
    ...(entry.image.replyToMessageId === undefined ? {} : { replyToMessageId: entry.image.replyToMessageId })
  };
}
