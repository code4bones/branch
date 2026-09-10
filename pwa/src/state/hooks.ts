import type { RelayRouteMaterial } from "@code4bones/branch-core";
import { useEffect } from "react";

import { useAppStore } from "./StoreProvider.js";
import { useAppStoreApi } from "./StoreProvider.js";
import { downloadVerifiedCompletedAttachment, type CompletedAttachmentDownloadResult } from "../app/transient-attachment-presentation.js";
import { ECHO_CONTACT_ID } from "../app/paths.js";
import type { RouteStatus } from "./slices/connection-slice.js";
import type { ContactSummary } from "./slices/contacts-slice.js";
import type { ContactPresence } from "./slices/contact-presence-slice.js";
import type { MessageDeliveryState, MessageSummary } from "./slices/conversations-slice.js";
import type { IncomingMessageRequest } from "./slices/message-requests-slice.js";
import type { IdentityStatus, LocalIdentitySummary } from "./slices/identity-slice.js";
import type { InboundAttachmentOffer, InboundAttachmentOfferDecision, InboundAttachmentOfferResponse } from "./slices/inbound-attachment-offers-slice.js";
import type { CompletedAttachment } from "./slices/completed-attachments-slice.js";
import type { AttachStatus } from "./slices/transport-slice.js";
import type { TransportTraceEntry } from "./slices/transport-slice.js";
import type { ThemeMode } from "./slices/ui-slice.js";

// Domain hooks are the only way page/feature components should reach the
// store. Each hook exposes exactly the state and actions one concern needs,
// so a component never has to receive that data or its setters as props
// from an ancestor (no prop-drilling) and never has to know the store's
// internal shape.

export function useConversationsLoaded(): boolean {
  return useAppStore((state) => state.conversationsLoaded);
}

export interface ThemeControls {
  readonly mode: ThemeMode;
  readonly setMode: (mode: ThemeMode) => void;
}

export function useThemeControls(): ThemeControls {
  const mode = useAppStore((state) => state.themeMode);
  const setMode = useAppStore((state) => state.setThemeMode);
  return { mode, setMode };
}

export interface IdentityControls {
  readonly status: IdentityStatus;
  readonly identity: LocalIdentitySummary | null;
  readonly setIdentity: (identity: LocalIdentitySummary) => void;
  readonly clearIdentity: () => void;
}

export function useIdentity(): IdentityControls {
  const status = useAppStore((state) => state.identityStatus);
  const identity = useAppStore((state) => state.identity);
  const setIdentity = useAppStore((state) => state.setIdentity);
  const clearIdentity = useAppStore((state) => state.clearIdentity);
  return { status, identity, setIdentity, clearIdentity };
}

export interface ContactsControls {
  readonly contacts: readonly ContactSummary[];
  readonly selectedContactId: string | null;
  readonly upsertContact: (contact: ContactSummary) => void;
  readonly forgetContact: (contactId: string) => void;
  readonly selectContact: (contactId: string | null) => void;
}

export function useContacts(): ContactsControls {
  const contacts = useAppStore((state) => state.contacts);
  const selectedContactId = useAppStore((state) => state.selectedContactId);
  const upsertContact = useAppStore((state) => state.upsertContact);
  const forgetContact = useAppStore((state) => state.forgetContact);
  const selectContact = useAppStore((state) => state.selectContact);
  return { contacts, selectedContactId, upsertContact, forgetContact, selectContact };
}

const unknownContactPresence: ContactPresence = { status: "unknown", updatedAt: 0, pendingPingId: null };

export interface ContactPresenceControls {
  readonly presence: ContactPresence;
  readonly beginContactPresencePing: (contactId: string, pingId: string) => void;
  readonly expireContactPresencePing: (contactId: string, pingId: string) => void;
  readonly expireContactPresence: (contactId: string, updatedAt: number) => void;
}

export function useContactPresence(contactId: string): ContactPresenceControls {
  const presence = useAppStore((state) => state.contactPresenceById[contactId] ?? unknownContactPresence);
  const beginContactPresencePing = useAppStore((state) => state.beginContactPresencePing);
  const expireContactPresencePing = useAppStore((state) => state.expireContactPresencePing);
  const expireContactPresence = useAppStore((state) => state.expireContactPresence);
  return { presence, beginContactPresencePing, expireContactPresencePing, expireContactPresence };
}

export interface ContactTypingControls {
  readonly expiresAt: number | null;
  readonly expireContactTyping: (contactId: string, expiresAt: number) => void;
}

export function useContactTyping(contactId: string): ContactTypingControls {
  const expiresAt = useAppStore((state) => state.typingExpiresAtByContactId[contactId] ?? null);
  const expireContactTyping = useAppStore((state) => state.expireContactTyping);
  return { expiresAt, expireContactTyping };
}

export interface ConversationControls {
  readonly messages: readonly MessageSummary[];
  readonly appendMessage: (message: MessageSummary) => void;
  readonly setMessageDeliveryState: (contactId: string, messageId: string, deliveryState: MessageDeliveryState) => void;
}

export function useConversation(contactId: string | null): ConversationControls {
  const messages = useAppStore((state) => (contactId === null ? emptyMessages : state.messagesByContactId[contactId] ?? emptyMessages));
  const appendMessage = useAppStore((state) => state.appendMessage);
  const setMessageDeliveryState = useAppStore((state) => state.setMessageDeliveryState);
  return { messages, appendMessage, setMessageDeliveryState };
}

export interface ReceiptPolicyControls {
  readonly sendReadReceipts: boolean;
  readonly setSendReadReceipts: (enabled: boolean) => void;
}

// This preference is deliberately local and opt-in. Receipt-control adapters
// may read it, but changing it never sends a network message by itself.
export function useReceiptPolicy(): ReceiptPolicyControls {
  const sendReadReceipts = useAppStore((state) => state.sendReadReceipts);
  const setSendReadReceipts = useAppStore((state) => state.setSendReadReceipts);
  return { sendReadReceipts, setSendReadReceipts };
}

export interface InboundAttachmentOfferControls {
  readonly offer: InboundAttachmentOffer | null;
  readonly respond: (decision: InboundAttachmentOfferDecision) => Promise<InboundAttachmentOfferResponse>;
}

// This view is empty until the connectivity adapter stages an already verified
// manifest. It contains no storage or transport dependency of its own.
export function useInboundAttachmentOffer(peerId: string | null): InboundAttachmentOfferControls {
  const offer = useAppStore((state) => (peerId === null ? null : state.inboundAttachmentOffersByPeerId[peerId] ?? null));
  const respondToInboundAttachmentOffer = useAppStore((state) => state.respondToInboundAttachmentOffer);
  return {
    offer,
    respond: async (decision) => peerId === null ? "not_found" : respondToInboundAttachmentOffer(peerId, decision)
  };
}

export interface CompletedAttachmentControls {
  readonly attachment: CompletedAttachment | null;
  readonly download: () => CompletedAttachmentDownloadResult;
}

// The selector exposes metadata only. `download` enters the separate volatile
// handle registry during an explicit click; it never reads Blob/File state.
export function useCompletedAttachment(peerId: string | null): CompletedAttachmentControls {
  const storeApi = useAppStoreApi();
  const attachment = useAppStore((state) => (peerId === null ? null : state.completedAttachmentsByPeerId[peerId] ?? null));
  return {
    attachment,
    download: () => peerId === null ? "not_found" : downloadVerifiedCompletedAttachment(storeApi, peerId)
  };
}

export interface IncomingMessageRequestControls {
  readonly requests: readonly IncomingMessageRequest[];
  readonly acceptMessageRequest: (requestId: string) => string | null;
  readonly dismissMessageRequest: (requestId: string) => void;
}

export function useIncomingMessageRequests(): IncomingMessageRequestControls {
  const requests = useAppStore((state) => state.incomingMessageRequests);
  const acceptMessageRequest = useAppStore((state) => state.acceptMessageRequest);
  const dismissMessageRequest = useAppStore((state) => state.dismissMessageRequest);
  return { requests, acceptMessageRequest, dismissMessageRequest };
}

// Marks a conversation read as soon as it's open. A component just calls
// this with the current contactId; it never has to know how read state is
// stored or push it back up to an ancestor.
export function useMarkContactRead(contactId: string | null): void {
  const markContactRead = useAppStore((state) => state.markContactRead);
  useEffect(() => {
    if (contactId !== null) {
      markContactRead(contactId);
    }
  }, [contactId, markContactRead]);
}

export interface ChatListEntry {
  readonly contact: ContactSummary;
  readonly lastMessage: MessageSummary | null;
  readonly unreadCount: number;
}

// Combines contacts, conversations, and read state into the single view
// model the chat list sidebar renders, so that component stays a plain
// presentational list.
export function useChatList(): readonly ChatListEntry[] {
  const contacts = useAppStore((state) => state.contacts);
  const messagesByContactId = useAppStore((state) => state.messagesByContactId);
  const lastReadAtByContactId = useAppStore((state) => state.lastReadAtByContactId);

  return contacts
    .map((contact): ChatListEntry => {
      const messages = messagesByContactId[contact.contactId] ?? emptyMessages;
      const lastMessage = messages.length > 0 ? messages[messages.length - 1] ?? null : null;
      const lastReadAt = lastReadAtByContactId[contact.contactId] ?? 0;
      const unreadCount = messages.filter((message) => message.direction === "incoming" && message.sentAt > lastReadAt).length;
      return { contact, lastMessage, unreadCount };
    })
    .slice()
    .sort((left, right) => (right.lastMessage?.sentAt ?? 0) - (left.lastMessage?.sentAt ?? 0));
}

const emptyMessages: readonly MessageSummary[] = [];

export interface EchoPreview {
  readonly lastMessage: MessageSummary | null;
  readonly unreadCount: number;
}

// Same shape as one useChatList() entry, but for the pinned Echo row, which
// isn't a ContactSummary — it just reads the message log kept under the
// reserved ECHO_CONTACT_ID (see src/app/paths.ts).
export function useEchoPreview(): EchoPreview {
  const messages = useAppStore((state) => state.messagesByContactId[ECHO_CONTACT_ID] ?? emptyMessages);
  const lastReadAt = useAppStore((state) => state.lastReadAtByContactId[ECHO_CONTACT_ID] ?? 0);
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] ?? null : null;
  const unreadCount = messages.filter((message) => message.direction === "incoming" && message.sentAt > lastReadAt).length;
  return { lastMessage, unreadCount };
}

export interface ConnectionControls {
  readonly routeStatus: RouteStatus;
  readonly discoveredRoutes: readonly RelayRouteMaterial[];
  readonly routeSource: string;
  readonly discoveryMessage: string;
  readonly setRouteSearching: () => void;
  readonly setRouteFound: (routes: readonly RelayRouteMaterial[], source: string) => void;
  readonly setRouteFailed: (message: string) => void;
  readonly resetRoute: () => void;
}

export interface TransportControls {
  readonly attachStatus: AttachStatus;
  readonly attachMessage: string;
  readonly transportTrace: readonly TransportTraceEntry[];
}

export function useTransportStatus(): TransportControls {
  const attachStatus = useAppStore((state) => state.attachStatus);
  const attachMessage = useAppStore((state) => state.attachMessage);
  const transportTrace = useAppStore((state) => state.transportTrace);
  return { attachStatus, attachMessage, transportTrace };
}

export function useConnection(): ConnectionControls {
  const routeStatus = useAppStore((state) => state.routeStatus);
  const discoveredRoutes = useAppStore((state) => state.discoveredRoutes);
  const routeSource = useAppStore((state) => state.routeSource);
  const discoveryMessage = useAppStore((state) => state.discoveryMessage);
  const setRouteSearching = useAppStore((state) => state.setRouteSearching);
  const setRouteFound = useAppStore((state) => state.setRouteFound);
  const setRouteFailed = useAppStore((state) => state.setRouteFailed);
  const resetRoute = useAppStore((state) => state.resetRoute);
  return { routeStatus, discoveredRoutes, routeSource, discoveryMessage, setRouteSearching, setRouteFound, setRouteFailed, resetRoute };
}
