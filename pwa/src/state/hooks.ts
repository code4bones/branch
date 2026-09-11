import type { VerifiedRelayRouteMaterial } from "@code4bones/branch-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppStore } from "./StoreProvider.js";
import { useAppStoreApi } from "./StoreProvider.js";
import { downloadVerifiedCompletedAttachment, type CompletedAttachmentDownloadResult } from "../app/transient-attachment-presentation.js";
import type { LocalImageMessageProjection } from "../app/image-message.js";
import { loadStoredImageMessageBlob } from "../storage/image-media-store.js";
import type { ImageMessageProjection } from "./slices/image-message-projections-slice.js";
import {
  conversationTimelinePageEntries,
  initialConversationTimelineEntries,
  loadStoredTimelineEntryByApplicationMessageId,
  loadStoredTimelineEntriesAfter,
  loadStoredTimelinePage,
  maxConversationTimelineEntries,
  type ConversationTimelineEntry
} from "../storage/messages-store.js";
import type { RouteStatus } from "./slices/connection-slice.js";
import type { ContactSummary } from "./slices/contacts-slice.js";
import type { ContactFolder } from "./contact-folders-model.js";
import type { ContactDiscoveryAvailability, ContactDiscoveryRow } from "./slices/contact-discovery-slice.js";
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

export interface ContactFoldersControls {
  readonly folders: readonly ContactFolder[];
  readonly folderIdByContactId: Readonly<Record<string, string>>;
  readonly create: (name: string) => string | null;
  readonly rename: (folderId: string, name: string) => boolean;
  readonly remove: (folderId: string) => void;
  readonly assign: (contactId: string, folderId: string | null) => boolean;
}

// Folder IDs are generated only in this UI adapter. The state model remains
// deterministic and contains no browser-global dependency.
export function useContactFolders(): ContactFoldersControls {
  const folders = useAppStore((state) => state.contactFolders);
  const folderIdByContactId = useAppStore((state) => state.contactFolderIdByContactId);
  const createContactFolder = useAppStore((state) => state.createContactFolder);
  const renameContactFolder = useAppStore((state) => state.renameContactFolder);
  const deleteContactFolder = useAppStore((state) => state.deleteContactFolder);
  const assignContactFolder = useAppStore((state) => state.assignContactFolder);
  return {
    folders,
    folderIdByContactId,
    create: (name) => {
      const folderId = crypto.randomUUID();
      return createContactFolder(folderId, name) ? folderId : null;
    },
    rename: renameContactFolder,
    remove: deleteContactFolder,
    assign: assignContactFolder
  };
}

export interface ContactDiscoveryControls {
  readonly rows: readonly ContactDiscoveryRow[];
  readonly availability: ContactDiscoveryAvailability;
  readonly search: (branchId: string, now?: number) => boolean;
  readonly retry: (branchId: string, now?: number) => void;
  readonly remove: (branchId: string) => void;
}

export interface ContactDiscoveryPolicyControls {
  readonly allowContactDiscovery: boolean;
  readonly setAllowContactDiscovery: (enabled: boolean) => void;
}

export function useContactDiscoveryPolicy(): ContactDiscoveryPolicyControls {
  const allowContactDiscovery = useAppStore((state) => state.allowContactDiscovery);
  const setAllowContactDiscovery = useAppStore((state) => state.setAllowContactDiscovery);
  return { allowContactDiscovery, setAllowContactDiscovery };
}

export function useContactDiscoveries(): ContactDiscoveryControls {
  const rows = useAppStore((state) => state.contactDiscoveries);
  const availability = useAppStore((state) => state.contactDiscoveryAvailability);
  const upsert = useAppStore((state) => state.upsertContactDiscovery);
  const retryContactDiscovery = useAppStore((state) => state.retryContactDiscovery);
  const remove = useAppStore((state) => state.deleteContactDiscovery);
  return {
    rows,
    availability,
    search: (branchId, now = Date.now()) => upsert(branchId, now),
    retry: (branchId, now = Date.now()) => { retryContactDiscovery(branchId, now); },
    remove
  };
}

const unknownContactPresence: ContactPresence = { status: "unknown", evidence: null, updatedAt: 0, lastProbeAt: null, pendingPingId: null };

export interface ContactPresenceControls {
  readonly presence: ContactPresence;
}

export function useContactPresence(contactId: string): ContactPresenceControls {
  const presence = useAppStore((state) => state.contactPresenceById[contactId] ?? unknownContactPresence);
  return { presence };
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
  readonly retryUnavailableMessage: (contactId: string, previousMessageId: string, replacement: MessageSummary) => boolean;
  readonly setMessageDeliveryState: (contactId: string, messageId: string, deliveryState: MessageDeliveryState) => void;
  readonly deleteMessagesLocally: (contactId: string, messageIds: readonly string[]) => readonly MessageSummary[];
}

export function useConversation(contactId: string | null): ConversationControls {
  const messages = useAppStore((state) => (contactId === null ? emptyMessages : state.messagesByContactId[contactId] ?? emptyMessages));
  const appendMessage = useAppStore((state) => state.appendMessage);
  const retryUnavailableMessage = useAppStore((state) => state.retryUnavailableMessage);
  const setMessageDeliveryState = useAppStore((state) => state.setMessageDeliveryState);
  const deleteMessagesLocally = useAppStore((state) => state.deleteMessagesLocally);
  return { messages, appendMessage, retryUnavailableMessage, setMessageDeliveryState, deleteMessagesLocally };
}

export interface ConversationTimelineControls {
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  readonly loadOlder: () => Promise<void>;
  readonly loadReplyTarget: (messageId: string) => Promise<void>;
  readonly loadLatest: () => Promise<void>;
}

/**
 * Owns the selected chat's bounded device-local history window. Cursor reads
 * are strictly IndexedDB work: they never ask a peer, carrier, or relay for
 * older messages.
 */
export function useConversationTimeline(contactId: string | null): ConversationTimelineControls {
  const storeApi = useAppStoreApi();
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  const activeContactRef = useRef<string | null>(contactId);
  activeContactRef.current = contactId;

  const apply = useCallback((targetContactId: string, entries: readonly ConversationTimelineEntry[], keep: "oldest" | "newest"): void => {
    const deduplicated = new Map<string, ConversationTimelineEntry>();
    for (const entry of entries) deduplicated.set(entry.messageId, entry);
    const ordered = [...deduplicated.values()]
      .sort((left, right) => left.sentAt - right.sentAt || left.messageId.localeCompare(right.messageId));
    const bounded = keep === "oldest"
      ? ordered.slice(0, maxConversationTimelineEntries)
      : ordered.slice(-maxConversationTimelineEntries);
    const messages = bounded.flatMap((entry) => entry.kind === "text" ? [entry.message] : []);
    const images = bounded.flatMap((entry) => entry.kind === "image" ? [entry.image] : []);
    storeApi.getState().replaceConversationWindow(targetContactId, messages);
    storeApi.getState().replaceImageMessageProjectionWindow(targetContactId, images);
  }, [storeApi]);

  const currentEntries = useCallback((targetContactId: string): readonly ConversationTimelineEntry[] => {
    const state = storeApi.getState();
    const messages = state.messagesByContactId[targetContactId] ?? emptyMessages;
    const images = Object.values(state.imageMessageProjectionsById)
      .filter((projection) => projection.contactId === targetContactId);
    return [
      ...messages.map((message): ConversationTimelineEntry => ({ kind: "text", message, messageId: message.messageId, sentAt: message.sentAt })),
      ...images.map((image): ConversationTimelineEntry => ({ kind: "image", image, messageId: image.messageId, sentAt: image.sentAt }))
    ];
  }, [storeApi]);

  const loadLatest = useCallback(async (): Promise<void> => {
    if (contactId === null) return;
    const page = await loadStoredTimelinePage(contactId, null, initialConversationTimelineEntries);
    if (activeContactRef.current !== contactId) return;
    apply(contactId, page.entries, "newest");
    setHasOlder(page.hasOlder);
  }, [apply, contactId]);

  const loadOlder = useCallback(async (): Promise<void> => {
    if (contactId === null || !hasOlder || loadingOlderRef.current) return;
    const current = currentEntries(contactId);
    const oldest = current.slice().sort((left, right) => left.sentAt - right.sentAt || left.messageId.localeCompare(right.messageId))[0];
    if (oldest === undefined) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const page = await loadStoredTimelinePage(contactId, { sentAt: oldest.sentAt, messageId: oldest.messageId }, conversationTimelinePageEntries);
      if (activeContactRef.current !== contactId) return;
      apply(contactId, [...page.entries, ...current], "oldest");
      setHasOlder(page.hasOlder);
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [apply, contactId, currentEntries, hasOlder]);

  const loadReplyTarget = useCallback(async (applicationMessageId: string): Promise<void> => {
    if (contactId === null) return;
    const target = await loadStoredTimelineEntryByApplicationMessageId(applicationMessageId);
    if (target === null) return;
    const targetContactId = target.kind === "image" ? target.image.contactId : target.message.contactId;
    if (targetContactId !== contactId) return;
    const cursor = { sentAt: target.sentAt, messageId: target.messageId };
    const [older, newer] = await Promise.all([
      loadStoredTimelinePage(contactId, cursor, Math.floor((initialConversationTimelineEntries - 1) / 2)),
      loadStoredTimelineEntriesAfter(contactId, cursor, Math.ceil((initialConversationTimelineEntries - 1) / 2))
    ]);
    if (activeContactRef.current !== contactId) return;
    apply(contactId, [...older.entries, target, ...newer], "newest");
    setHasOlder(older.hasOlder);
  }, [apply, contactId]);

  useEffect(() => {
    setHasOlder(false);
    void loadLatest().catch(() => {
      if (activeContactRef.current === contactId) setHasOlder(false);
    });
  }, [contactId, loadLatest]);

  return { hasOlder, loadingOlder, loadOlder, loadReplyTarget, loadLatest };
}

export interface MessageActionsControls {
  readonly menuMessageId: string | null;
  readonly selectedMessageIds: readonly string[];
  readonly forwardSourceMessageIds: readonly string[];
  readonly openMessageMenu: (contactId: string, messageId: string) => void;
  readonly closeMessageMenu: () => void;
  readonly toggleMessageSelection: (contactId: string, messageId: string) => void;
  readonly clearMessageSelection: () => void;
  readonly setForwardSources: (contactId: string, messageIds: readonly string[]) => void;
  readonly clearForwardSources: () => void;
}

export function useMessageActions(): MessageActionsControls {
  const menuMessageId = useAppStore((state) => state.menuMessageId);
  const selectedMessageIds = useAppStore((state) => state.selectedMessageIds);
  const forwardSourceMessageIds = useAppStore((state) => state.forwardSourceMessageIds);
  const openMessageMenu = useAppStore((state) => state.openMessageMenu);
  const closeMessageMenu = useAppStore((state) => state.closeMessageMenu);
  const toggleMessageSelection = useAppStore((state) => state.toggleMessageSelection);
  const clearMessageSelection = useAppStore((state) => state.clearMessageSelection);
  const setForwardSources = useAppStore((state) => state.setForwardSources);
  const clearForwardSources = useAppStore((state) => state.clearForwardSources);
  return { menuMessageId, selectedMessageIds, forwardSourceMessageIds, openMessageMenu, closeMessageMenu, toggleMessageSelection, clearMessageSelection, setForwardSources, clearForwardSources };
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

/**
 * Exposes only verified image metadata. Each visible bubble asks its own local
 * storage boundary for a Blob URL; the hook never opens every Blob in a chat.
 */
export function useLocalImageMessages(contactId: string | null): readonly LocalImageMessageProjection[] {
  const allProjections = useAppStore((state) => state.imageMessageProjectionsById);
  const projections = useMemo(() => localImageProjectionsForContact(allProjections, contactId), [allProjections, contactId]);
  const projectionKey = localImageProjectionMemoKey(projections);

  return useMemo(() => projections.map((projection): LocalImageMessageProjection => ({
    messageId: projection.messageId,
    direction: projection.direction,
    sentAt: projection.sentAt,
    mediaType: projection.mediaType,
    width: projection.width,
    height: projection.height,
    ...(projection.caption === undefined ? {} : { caption: projection.caption }),
    ...(projection.replyToMessageId === undefined ? {} : { replyToMessageId: projection.replyToMessageId }),
    loadObjectUrl: async () => {
      const blob = await loadStoredImageMessageBlob(projection.messageId);
      return blob === null || blob.size !== projection.byteCount ? null : URL.createObjectURL(blob);
    }
  })), [contactId, projectionKey]);
}

/**
 * Captures the selected local image projections only after the caller has
 * chosen one contact. The scalar key lets the mapped projection
 * and its Blob loader survive unrelated image-store updates without treating
 * a genuine active-chat metadata change as unchanged.
 */
export function localImageProjectionMemoKey(projections: readonly ImageMessageProjection[]): string {
  return JSON.stringify(projections.map((projection) => [
    projection.messageId,
    projection.direction,
    projection.sentAt,
    projection.mediaType,
    projection.byteCount,
    projection.width,
    projection.height,
    projection.caption ?? null,
    projection.replyToMessageId ?? null
  ]));
}

/** Selects the bounded local image metadata for exactly one rendered chat. */
export function localImageProjectionsForContact(allProjections: Readonly<Record<string, ImageMessageProjection>>, contactId: string | null): readonly ImageMessageProjection[] {
  if (contactId === null) return [];
  return Object.values(allProjections)
    .filter((projection) => projection.contactId === contactId)
    .sort((left, right) => left.sentAt - right.sentAt || left.messageId.localeCompare(right.messageId));
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

export interface ConnectionControls {
  readonly routeStatus: RouteStatus;
  readonly discoveredRoutes: readonly VerifiedRelayRouteMaterial[];
  readonly routeSource: string;
  readonly discoveryMessage: string;
  readonly selectedRelayKey: string | null;
  readonly setRouteSearching: () => void;
  readonly setRouteFound: (routes: readonly VerifiedRelayRouteMaterial[], source: string) => void;
  readonly setRouteFailed: (message: string) => void;
  readonly resetRoute: () => void;
  readonly setSelectedRelayKey: (relayKey: string | null) => void;
}

export interface TransportControls {
  readonly attachStatus: AttachStatus;
  readonly attachMessage: string;
  readonly attachedRelayEndpoint: string | null;
  readonly transportTrace: readonly TransportTraceEntry[];
}

export function useTransportStatus(): TransportControls {
  const attachStatus = useAppStore((state) => state.attachStatus);
  const attachMessage = useAppStore((state) => state.attachMessage);
  const attachedRelayEndpoint = useAppStore((state) => state.attachedRelayEndpoint);
  const transportTrace = useAppStore((state) => state.transportTrace);
  return { attachStatus, attachMessage, attachedRelayEndpoint, transportTrace };
}

export function useConnection(): ConnectionControls {
  const routeStatus = useAppStore((state) => state.routeStatus);
  const discoveredRoutes = useAppStore((state) => state.discoveredRoutes);
  const routeSource = useAppStore((state) => state.routeSource);
  const discoveryMessage = useAppStore((state) => state.discoveryMessage);
  const selectedRelayKey = useAppStore((state) => state.selectedRelayKey);
  const setRouteSearching = useAppStore((state) => state.setRouteSearching);
  const setRouteFound = useAppStore((state) => state.setRouteFound);
  const setRouteFailed = useAppStore((state) => state.setRouteFailed);
  const resetRoute = useAppStore((state) => state.resetRoute);
  const setSelectedRelayKey = useAppStore((state) => state.setSelectedRelayKey);
  return { routeStatus, discoveredRoutes, routeSource, discoveryMessage, selectedRelayKey, setRouteSearching, setRouteFound, setRouteFailed, resetRoute, setSelectedRelayKey };
}
