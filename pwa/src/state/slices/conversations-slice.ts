import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";
import { demoMessages } from "../demo-seed.js";
import { saveStoredMessage } from "../../storage/messages-store.js";

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
}

export interface ConversationsSlice {
  readonly messagesByContactId: Readonly<Record<string, readonly MessageSummary[]>>;
  readonly appendMessage: (message: MessageSummary) => void;
  readonly setMessageDeliveryState: (contactId: string, messageId: string, deliveryState: MessageDeliveryState) => void;
}

export const createConversationsSlice: StateCreator<AppStore, [], [], ConversationsSlice> = (set) => ({
  messagesByContactId: groupMessagesByContactId(demoMessages),
  appendMessage: (message) => {
    set((state) => ({
      messagesByContactId: {
        ...state.messagesByContactId,
        [message.contactId]: orderConversationMessages([
          ...(state.messagesByContactId[message.contactId] ?? []).filter((existing) => existing.messageId !== message.messageId),
          message
        ])
      }
    }));
    persistMessageInOrder(message);
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
