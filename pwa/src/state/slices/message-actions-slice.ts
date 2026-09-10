import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";

export interface MessageActionsSlice {
  readonly messageActionContactId: string | null;
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

const maxSelectedMessages = 128;

// This is deliberately presentation state only. It is not persisted,
// exported, serialized into diagnostics, or visible to a connectivity adapter.
export const createMessageActionsSlice: StateCreator<AppStore, [], [], MessageActionsSlice> = (set) => ({
  messageActionContactId: null,
  menuMessageId: null,
  selectedMessageIds: [],
  forwardSourceMessageIds: [],
  openMessageMenu: (contactId, messageId) => {
    set({ messageActionContactId: contactId, menuMessageId: messageId });
  },
  closeMessageMenu: () => { set({ menuMessageId: null }); },
  toggleMessageSelection: (contactId, messageId) => {
    set((state) => {
      const current = state.messageActionContactId === contactId ? state.selectedMessageIds : [];
      const selected = current.includes(messageId)
        ? current.filter((candidate) => candidate !== messageId)
        : current.length >= maxSelectedMessages ? current : [...current, messageId];
      return {
        messageActionContactId: contactId,
        menuMessageId: null,
        selectedMessageIds: selected,
        forwardSourceMessageIds: state.messageActionContactId === contactId ? state.forwardSourceMessageIds : []
      };
    });
  },
  clearMessageSelection: () => {
    set({ messageActionContactId: null, menuMessageId: null, selectedMessageIds: [] });
  },
  setForwardSources: (contactId, messageIds) => {
    set({
      messageActionContactId: contactId,
      menuMessageId: null,
      forwardSourceMessageIds: uniqueMessageIds(messageIds)
    });
  },
  clearForwardSources: () => { set({ forwardSourceMessageIds: [] }); }
});

function uniqueMessageIds(messageIds: readonly string[]): readonly string[] {
  return [...new Set(messageIds.filter((messageId) => messageId !== ""))].slice(0, maxSelectedMessages);
}
