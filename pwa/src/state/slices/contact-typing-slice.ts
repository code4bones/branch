import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";

const maxTypingContacts = 64;

export interface ContactTypingSlice {
  readonly typingExpiresAtByContactId: Readonly<Record<string, number>>;
  readonly setContactTyping: (contactId: string, expiresAt: number) => void;
  readonly expireContactTyping: (contactId: string, expiresAt: number) => void;
  readonly clearContactTyping: (contactId: string) => void;
  readonly clearAllContactTyping: () => void;
}

// Typing is an explicitly volatile projection of a verified E2EE control.
export const createContactTypingSlice: StateCreator<AppStore, [], [], ContactTypingSlice> = (set) => ({
  typingExpiresAtByContactId: {},
  setContactTyping: (contactId, expiresAt) => {
    set((state) => ({ typingExpiresAtByContactId: bounded({ ...state.typingExpiresAtByContactId, [contactId]: expiresAt }) }));
  },
  expireContactTyping: (contactId, expiresAt) => {
    set((state) => {
      if (state.typingExpiresAtByContactId[contactId] !== expiresAt) {
        return state;
      }
      const { [contactId]: removed, ...typingExpiresAtByContactId } = state.typingExpiresAtByContactId;
      void removed;
      return { typingExpiresAtByContactId };
    });
  },
  clearContactTyping: (contactId) => {
    set((state) => {
      const { [contactId]: removed, ...typingExpiresAtByContactId } = state.typingExpiresAtByContactId;
      void removed;
      return { typingExpiresAtByContactId };
    });
  },
  clearAllContactTyping: () => { set({ typingExpiresAtByContactId: {} }); }
});

function bounded(entries: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  const pairs = Object.entries(entries);
  if (pairs.length <= maxTypingContacts) {
    return entries;
  }
  const oldest = pairs.reduce((selected, candidate) => candidate[1] < selected[1] ? candidate : selected);
  const { [oldest[0]]: removed, ...rest } = entries;
  void removed;
  return rest;
}
