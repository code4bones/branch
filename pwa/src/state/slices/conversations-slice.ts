import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";
import { demoMessages } from "../demo-seed.js";
import { saveStoredMessage } from "../../storage/messages-store.js";

export type MessageDeliveryState = "pending" | "relayed" | "received" | "unavailable";

export interface MessageSummary {
  readonly messageId: string;
  readonly contactId: string;
  readonly direction: "outgoing" | "incoming";
  readonly body: string;
  readonly sentAt: number;
  readonly deliveryState: MessageDeliveryState;
}

export interface ConversationsSlice {
  readonly messagesByContactId: Readonly<Record<string, readonly MessageSummary[]>>;
  readonly appendMessage: (message: MessageSummary) => void;
  readonly setMessageDeliveryState: (contactId: string, messageId: string, deliveryState: MessageDeliveryState) => void;
}

export const createConversationsSlice: StateCreator<AppStore, [], [], ConversationsSlice> = (set, get) => ({
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
    void saveStoredMessage(message).catch(() => {
      // Best-effort persistence (e.g. private browsing blocks IndexedDB);
      // the message still exists for this session either way.
    });
  },
  setMessageDeliveryState: (contactId, messageId, deliveryState) => {
    set((state) => {
      const existing = state.messagesByContactId[contactId];
      if (existing === undefined) {
        return state;
      }
      return {
        messagesByContactId: {
          ...state.messagesByContactId,
          [contactId]: existing.map((message) => (
            message.messageId === messageId && canAdvanceDeliveryState(message.deliveryState, deliveryState)
              ? { ...message, deliveryState }
              : message
          ))
        }
      };
    });
    // set() is synchronous, so the store already reflects the update above.
    const updated = get().messagesByContactId[contactId]?.find((message) => message.messageId === messageId);
    if (updated !== undefined) {
      void saveStoredMessage(updated).catch(() => {
        // Best-effort persistence; see appendMessage above.
      });
    }
  }
});

function canAdvanceDeliveryState(current: MessageDeliveryState, next: MessageDeliveryState): boolean {
  if (current === next) {
    return false;
  }
  return current === "pending";
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
