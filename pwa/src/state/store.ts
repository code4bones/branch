import { createStore, type StoreApi } from "zustand/vanilla";

import { createConnectionSlice, type ConnectionSlice } from "./slices/connection-slice.js";
import { createContactPresenceSlice, type ContactPresenceSlice } from "./slices/contact-presence-slice.js";
import { createContactTypingSlice, type ContactTypingSlice } from "./slices/contact-typing-slice.js";
import { createContactsSlice, type ContactsSlice } from "./slices/contacts-slice.js";
import { createConversationsSlice, type ConversationsSlice } from "./slices/conversations-slice.js";
import { createHydrationSlice, type HydrationSlice } from "./slices/hydration-slice.js";
import { createInboundAttachmentOffersSlice, type InboundAttachmentOffersSlice } from "./slices/inbound-attachment-offers-slice.js";
import { createIdentitySlice, type IdentitySlice } from "./slices/identity-slice.js";
import { createMessageRequestsSlice, type MessageRequestsSlice } from "./slices/message-requests-slice.js";
import { createReadStateSlice, type ReadStateSlice } from "./slices/read-state-slice.js";
import { createReceiptPolicySlice, type ReceiptPolicySlice } from "./slices/receipt-policy-slice.js";
import { createTransportSlice, type TransportSlice } from "./slices/transport-slice.js";
import { createUiSlice, type UiSlice } from "./slices/ui-slice.js";

// Combined store shape follows zustand's slices pattern: each domain owns one
// slice file and is composed here, so adding a new domain never means
// growing one monolithic reducer.
export type AppStore = UiSlice &
  IdentitySlice &
  ContactsSlice &
  ContactPresenceSlice &
  ContactTypingSlice &
  ConversationsSlice &
  InboundAttachmentOffersSlice &
  MessageRequestsSlice &
  ReadStateSlice &
  ReceiptPolicySlice &
  ConnectionSlice &
  TransportSlice &
  HydrationSlice;

export type AppStoreApi = StoreApi<AppStore>;

export function createAppStore(): AppStoreApi {
  return createStore<AppStore>()((...creator) => ({
    ...createUiSlice(...creator),
    ...createIdentitySlice(...creator),
    ...createContactsSlice(...creator),
    ...createContactPresenceSlice(...creator),
    ...createContactTypingSlice(...creator),
    ...createConversationsSlice(...creator),
    ...createInboundAttachmentOffersSlice(...creator),
    ...createMessageRequestsSlice(...creator),
    ...createReadStateSlice(...creator),
    ...createReceiptPolicySlice(...creator),
    ...createConnectionSlice(...creator),
    ...createTransportSlice(...creator),
    ...createHydrationSlice(...creator)
  }));
}
