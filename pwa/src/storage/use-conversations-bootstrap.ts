import { useEffect } from "react";

import { loadStoredContacts, saveStoredContact } from "./contacts-store.js";
import { loadStoredMessages, saveStoredMessage } from "./messages-store.js";
import { loadStoredMessageRequests } from "./message-requests-store.js";
import { loadStoredReadState } from "./read-state-store.js";
import { loadStoredReadReceiptPolicy } from "./receipt-policy-store.js";
import { loadStoredContactDiscoveries } from "./contact-discovery-store.js";
import { loadStoredContactDiscoveryPolicy } from "./contact-discovery-policy-store.js";
import { demoContacts, demoMessages } from "../state/demo-seed.js";
import { groupMessagesByContactId } from "../state/slices/conversations-slice.js";
import { useAppStoreApi } from "../state/StoreProvider.js";

// Runs once on app start: hydrate contacts/messages/read-state from
// IndexedDB. The store already boots with the demo seed in memory (so there
// is never a blank flash on first paint); on a genuine first run this
// persists that seed once so it survives a reload, and on every later run it
// overwrites the in-memory demo seed with the real persisted data before
// RequireIdentity lets the chat UI through (see conversationsLoaded).
export function useConversationsBootstrap(): void {
  const storeApi = useAppStoreApi();

  useEffect(() => {
    void (async () => {
      const [contacts, messages, readState, messageRequests, sendReadReceipts, contactDiscoveries, allowContactDiscovery] = await Promise.all([
        loadStoredContacts(),
        loadStoredMessages(),
        loadStoredReadState(),
        loadStoredMessageRequests(),
        loadStoredReadReceiptPolicy(),
        loadStoredContactDiscoveries(),
        loadStoredContactDiscoveryPolicy()
      ]);

      if (contacts.length === 0 && messages.length === 0) {
        await Promise.all([
          ...demoContacts.map((contact) => saveStoredContact(contact)),
          ...demoMessages.map((message) => saveStoredMessage(message))
        ]);
      } else {
        storeApi.setState({
          contacts,
          messagesByContactId: groupMessagesByContactId(messages),
          lastReadAtByContactId: readState,
          incomingMessageRequests: messageRequests,
          contactDiscoveries
        });
      }

      // The first-run seed branch above still needs to hydrate the explicit
      // local policy (which defaults false when no stored value exists).
      storeApi.setState({ sendReadReceipts, contactDiscoveries, allowContactDiscovery });

      storeApi.getState().setConversationsLoaded();
    })().catch(() => {
      // IndexedDB unavailable (e.g. private browsing): keep the in-memory
      // demo seed for this session and still unblock the UI.
      storeApi.getState().setConversationsLoaded();
    });
  }, [storeApi]);
}
