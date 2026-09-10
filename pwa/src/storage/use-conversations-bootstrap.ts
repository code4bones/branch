import { useEffect } from "react";

import { loadStoredContacts } from "./contacts-store.js";
import { removeLegacyDemoState } from "./legacy-demo-cleanup.js";
import { loadStoredMessages } from "./messages-store.js";
import { loadStoredMessageRequests } from "./message-requests-store.js";
import { loadStoredReadState } from "./read-state-store.js";
import { loadStoredReadReceiptPolicy } from "./receipt-policy-store.js";
import { loadStoredContactDiscoveries } from "./contact-discovery-store.js";
import { loadStoredContactDiscoveryPolicy } from "./contact-discovery-policy-store.js";
import { groupMessagesByContactId } from "../state/slices/conversations-slice.js";
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
      const [contacts, messages, readState, messageRequests, sendReadReceipts, contactDiscoveries, allowContactDiscovery] = await Promise.all([
        loadStoredContacts(),
        loadStoredMessages(),
        loadStoredReadState(),
        loadStoredMessageRequests(),
        loadStoredReadReceiptPolicy(),
        loadStoredContactDiscoveries(),
        loadStoredContactDiscoveryPolicy()
      ]);

      storeApi.setState({
        contacts,
        messagesByContactId: groupMessagesByContactId(messages),
        lastReadAtByContactId: readState,
        incomingMessageRequests: messageRequests,
        contactDiscoveries,
        sendReadReceipts,
        allowContactDiscovery
      });

      storeApi.getState().setConversationsLoaded();
    })().catch(() => {
      // IndexedDB unavailable (e.g. private browsing): keep the empty local
      // session state and still unblock the UI.
      storeApi.getState().setConversationsLoaded();
    });
  }, [storeApi]);
}
