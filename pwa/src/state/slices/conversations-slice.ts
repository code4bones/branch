import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";
import { deleteStoredMessagesForContact, deleteStoredMessagesLocally, maxConversationTimelineEntries, replaceStoredMessageForRetry, saveStoredMessage } from "../../storage/messages-store.js";
import { deleteStoredImageMessages, deleteStoredImageMessagesForContact } from "../../storage/image-media-store.js";
import { deleteStoredMessageDeliveryTargetsForContact } from "../../storage/message-delivery-target-store.js";
import { deleteStoredOutboxForContact } from "../../storage/message-outbox-store.js";
import { deleteStoredReadReceiptsForContact } from "../../storage/read-receipt-outbox-store.js";
import { deleteStoredReadState } from "../../storage/read-state-store.js";

// `received` remains an inbound/local compatibility value. Remote user-facing
// outcomes for an outgoing message are explicit: a relay may say Relayed, but
// only a signed endpoint control may establish Delivered or Read.
export type MessageDeliveryState = "pending" | "relayed" | "delivered" | "read" | "received" | "unavailable";
export type MessageDirection = "outgoing" | "incoming" | "service";

export interface MessageSummary {
  readonly messageId: string;
  readonly contactId: string;
  // `service` is local, user-visible state about a verified endpoint action.
  // It is never an application payload or a relay acknowledgement.
  readonly direction: MessageDirection;
  readonly body: string;
  readonly sentAt: number;
  readonly deliveryState: MessageDeliveryState;
  readonly applicationMessageId?: string;
  readonly replyToMessageId?: string;
}

export interface ConversationsSlice {
  readonly messagesByContactId: Readonly<Record<string, readonly MessageSummary[]>>;
  readonly appendMessage: (message: MessageSummary) => void;
  /** Replaces the selected chat's bounded device-local render projection. */
  readonly replaceConversationWindow: (contactId: string, messages: readonly MessageSummary[]) => void;
  // A retry is a new E2EE/live delivery attempt, never a replay of the old ID.
  readonly retryUnavailableMessage: (contactId: string, previousMessageId: string, replacement: MessageSummary) => boolean;
  readonly setMessageDeliveryState: (contactId: string, messageId: string, deliveryState: MessageDeliveryState) => void;
  // UI-initiated device-local removal. It has no transport/control side effect.
  readonly deleteMessagesLocally: (contactId: string, messageIds: readonly string[]) => readonly MessageSummary[];
  // Debug-only local test cleanup. It preserves the contact, identity, and
  // relay attachment while clearing this chat's visible history and work.
  readonly clearLocalConversation: (contactId: string) => void;
}

export const createConversationsSlice: StateCreator<AppStore, [], [], ConversationsSlice> = (set, get) => ({
  messagesByContactId: {},
  appendMessage: (message) => {
    set((state) => ({
      messagesByContactId: {
        ...state.messagesByContactId,
        [message.contactId]: orderConversationMessages([
          ...(state.messagesByContactId[message.contactId] ?? []).filter((existing) => existing.messageId !== message.messageId),
          message
        ]).slice(-maxConversationTimelineEntries)
      }
    }));
    persistMessageInOrder(message);
  },
  replaceConversationWindow: (contactId, messages) => {
    const bounded = orderConversationMessages(messages)
      .filter((message) => message.contactId === contactId)
      .slice(-maxConversationTimelineEntries);
    set((state) => ({
      messagesByContactId: { ...state.messagesByContactId, [contactId]: bounded }
    }));
  },
  retryUnavailableMessage: (contactId, previousMessageId, replacement) => {
    if (
      replacement.messageId === previousMessageId ||
      replacement.contactId !== contactId ||
      replacement.direction !== "outgoing" ||
      replacement.deliveryState !== "pending"
    ) {
      return false;
    }
    const outcome = { replaced: false };
    set((state) => {
      const existing = state.messagesByContactId[contactId];
      if (existing === undefined) {
        return state;
      }
      const next = existing.map((message) => {
        if (message.messageId !== previousMessageId || message.direction !== "outgoing" || message.deliveryState !== "unavailable") {
          return message;
        }
        outcome.replaced = true;
        return replacement;
      });
      return outcome.replaced
        ? { messagesByContactId: { ...state.messagesByContactId, [contactId]: orderConversationMessages(next) } }
        : state;
    });
    if (outcome.replaced) {
      persistRetriedMessageInOrder(previousMessageId, replacement);
    }
    return outcome.replaced;
  },
  setMessageDeliveryState: (contactId, messageId, deliveryState) => {
    const transition: { message: MessageSummary | null } = { message: null };
    set((state) => {
      const existing = state.messagesByContactId[contactId];
      if (existing === undefined) {
        return state;
      }
      const next = existing.map((message) => {
        if (message.messageId !== messageId || message.direction !== "outgoing" || !canAdvanceDeliveryState(message.deliveryState, deliveryState)) {
          return message;
        }
        transition.message = { ...message, deliveryState };
        return transition.message;
      });
      if (transition.message === null) {
        return state;
      }
      return {
        messagesByContactId: {
          ...state.messagesByContactId,
          [contactId]: next
        }
      };
    });
    if (transition.message !== null) {
      persistMessageInOrder(transition.message);
    }
  },
  deleteMessagesLocally: (contactId, messageIds) => {
    const wanted = new Set(messageIds.filter((messageId) => messageId !== "").slice(0, maxLocalMessageActionCount));
    if (wanted.size === 0) return [];
    const deleted = get().messagesByContactId[contactId]?.filter((message) => wanted.has(message.messageId)) ?? [];
    if (deleted.length === 0) return [];
    const deletedIds = deleted.map((message) => message.messageId);
    set((state) => ({
      messagesByContactId: {
        ...state.messagesByContactId,
        [contactId]: state.messagesByContactId[contactId]?.filter((message) => !wanted.has(message.messageId)) ?? []
      },
      // Remove any not-yet-sent plaintext from the in-memory foreground outbox
      // immediately. An envelope already handed to live transit is not recalled.
      outbox: state.outbox.filter((entry) => !wanted.has(entry.messageId))
    }));
    // Images use the same device-local delete boundary as their message
    // projection. No transport control, relay request, or remote deletion is
    // emitted by this cleanup.
    get().removeImageMessageProjections(deletedIds);
    persistMessageDeletionInOrder(deletedIds);
    void deleteStoredImageMessages(deletedIds).catch(() => {
      // The visible projection is already gone. A later explicit clear/contact
      // removal can retry local byte cleanup when IndexedDB was unavailable.
    });
    return deleted;
  },
  clearLocalConversation: (contactId) => {
    // Do not reuse contact removal: a test reset must leave the user-owned
    // contact card and all live relay attachment state intact.
    get().clearImageMessageProjectionsForContact(contactId);
    set((state) => {
      const { [contactId]: removedMessages, ...messagesByContactId } = state.messagesByContactId;
      const { [contactId]: removedReadState, ...lastReadAtByContactId } = state.lastReadAtByContactId;
      const { [contactId]: removedTyping, ...typingExpiresAtByContactId } = state.typingExpiresAtByContactId;
      void removedMessages;
      void removedReadState;
      void removedTyping;
      return {
        messagesByContactId,
        outbox: state.outbox.filter((entry) => entry.contactId !== contactId),
        readReceiptOutbox: state.readReceiptOutbox.filter((entry) => entry.contactId !== contactId),
        lastReadAtByContactId,
        typingExpiresAtByContactId
      };
    });
    void Promise.all([
      deleteStoredMessagesForContact(contactId),
      deleteStoredReadState(contactId),
      deleteStoredOutboxForContact(contactId),
      deleteStoredReadReceiptsForContact(contactId),
      deleteStoredMessageDeliveryTargetsForContact(contactId),
      deleteStoredImageMessagesForContact(contactId)
    ]).catch(() => {
      // The current tab has already reset its local projection. No reset
      // action emits transport traffic or retries storage failures.
    });
  }
});

function canAdvanceDeliveryState(current: MessageDeliveryState, next: MessageDeliveryState): boolean {
  switch (current) {
    case "pending":
      return next === "relayed" || next === "unavailable";
    case "relayed":
    case "unavailable":
      // Unavailable is only a local live-transport outcome. A later valid,
      // authenticated endpoint receipt is stronger evidence and may supersede
      // it; a relay ACK itself may never alter a receipt state.
      return next === "delivered";
    case "delivered":
      return next === "read";
    case "read":
    case "received":
      return false;
  }
}

const maxPendingMessagePersists = 128;
const maxLocalMessageActionCount = 128;
const messagePersistenceChains = new Map<string, Promise<void>>();

// IndexedDB writes are asynchronous. Serializing writes per message prevents
// a delayed Relayed write from overwriting a later Delivered/Read transition
// after a restart. This is local persistence only, with a bounded number of
// in-flight chains and no transport retry semantics.
function persistMessageInOrder(message: MessageSummary): void {
  const previous = messagePersistenceChains.get(message.messageId);
  if (previous === undefined && messagePersistenceChains.size >= maxPendingMessagePersists) {
    return;
  }
  const next = (previous ?? Promise.resolve())
    .catch(() => {
      // Continue after a failed earlier write; the newest state is still the
      // best local snapshot available to this session.
    })
    .then(async () => { await saveStoredMessage(message); });
  messagePersistenceChains.set(message.messageId, next);
  void next.catch(() => {
    // Best-effort persistence (e.g. private browsing blocks IndexedDB).
  }).finally(() => {
    if (messagePersistenceChains.get(message.messageId) === next) {
      messagePersistenceChains.delete(message.messageId);
    }
  });
}

function persistRetriedMessageInOrder(previousMessageId: string, replacement: MessageSummary): void {
  const previous = messagePersistenceChains.get(previousMessageId) ?? Promise.resolve();
  const replacementPrevious = messagePersistenceChains.get(replacement.messageId) ?? Promise.resolve();
  if (
    messagePersistenceChains.get(previousMessageId) === undefined &&
    messagePersistenceChains.get(replacement.messageId) === undefined &&
    messagePersistenceChains.size + 2 > maxPendingMessagePersists
  ) {
    return;
  }
  const next = Promise.all([previous, replacementPrevious])
    .catch(() => {
      // A failed earlier write must not resurrect the superseded message.
    })
    .then(async () => { await replaceStoredMessageForRetry(previousMessageId, replacement); });
  messagePersistenceChains.set(previousMessageId, next);
  messagePersistenceChains.set(replacement.messageId, next);
  void next.catch(() => {
    // Best-effort local persistence; a retry never becomes a transport queue.
  }).finally(() => {
    if (messagePersistenceChains.get(previousMessageId) === next) {
      messagePersistenceChains.delete(previousMessageId);
    }
    if (messagePersistenceChains.get(replacement.messageId) === next) {
      messagePersistenceChains.delete(replacement.messageId);
    }
  });
}

function persistMessageDeletionInOrder(messageIds: readonly string[]): void {
  const uniqueMessageIds = [...new Set(messageIds)].slice(0, maxLocalMessageActionCount);
  const preceding = uniqueMessageIds.map((messageId) => messagePersistenceChains.get(messageId) ?? Promise.resolve());
  const next = Promise.all(preceding)
    .catch(() => {
      // Even after an earlier persistence failure the explicit local deletion
      // is the newest user-owned state and must still be attempted.
    })
    .then(async () => { await deleteStoredMessagesLocally(uniqueMessageIds, Date.now()); });
  for (const messageId of uniqueMessageIds) messagePersistenceChains.set(messageId, next);
  void next.catch(() => {
    // IndexedDB can be unavailable. The current tab still honours the local
    // deletion and never emits network traffic as a result of this action.
  }).finally(() => {
    for (const messageId of uniqueMessageIds) {
      if (messagePersistenceChains.get(messageId) === next) {
        messagePersistenceChains.delete(messageId);
      }
    }
  });
}

export function groupMessagesByContactId(messages: readonly MessageSummary[]): Readonly<Record<string, readonly MessageSummary[]>> {
  const grouped: Record<string, MessageSummary[]> = {};
  for (const message of messages) {
    const bucket = grouped[message.contactId] ?? [];
    bucket.push(message);
    grouped[message.contactId] = bucket;
  }
  return Object.fromEntries(Object.entries(grouped).map(([contactId, bucket]) => [contactId, orderConversationMessages(bucket)]));
}

// IndexedDB does not promise a chronology for getAll(). Keep every UI and
// persistence entry point on the same deterministic timeline; messageId only
// breaks equal local timestamps and never carries protocol meaning.
export function orderConversationMessages(messages: readonly MessageSummary[]): readonly MessageSummary[] {
  return [...messages].sort((left, right) => {
    if (left.sentAt !== right.sentAt) {
      return left.sentAt - right.sentAt;
    }
    return left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0;
  });
}
