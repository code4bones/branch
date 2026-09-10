import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";
import { deleteStoredContact, saveStoredContact } from "../../storage/contacts-store.js";
import { deleteStoredMessagesForContact } from "../../storage/messages-store.js";
import { deleteStoredReadState } from "../../storage/read-state-store.js";

export interface ContactSummary {
  readonly contactId: string;
  readonly displayName: string;
  // Only a contact with both values set can actually be reached over a
  // relay (see src/connectivity/seal-and-send.ts).
  readonly peerId: string | null;
  readonly hpkePublicKey: string | null;
  readonly lastRouteHint: string | null;
}

export interface ContactsSlice {
  readonly contacts: readonly ContactSummary[];
  readonly selectedContactId: string | null;
  readonly upsertContact: (contact: ContactSummary) => void;
  readonly forgetContact: (contactId: string) => void;
  readonly selectContact: (contactId: string | null) => void;
}

export const createContactsSlice: StateCreator<AppStore, [], [], ContactsSlice> = (set, get) => ({
  contacts: [],
  selectedContactId: null,
  upsertContact: (contact) => {
    set((state) => ({
      contacts: [...state.contacts.filter((existing) => existing.contactId !== contact.contactId), contact]
    }));
    void saveStoredContact(contact).catch(() => {
      // Best-effort persistence (e.g. private browsing blocks IndexedDB);
      // the contact still exists for this session either way.
    });
  },
  forgetContact: (contactId) => {
    // The completed-file handle is not state, but its owning volatile bridge
    // is bound to this projection's clear action. Contact removal must clear
    // it even when no ChatPage happens to be mounted.
    const peerId = get().contacts.find((existing) => existing.contactId === contactId)?.peerId ?? null;
    if (peerId !== null) {
      get().clearCompletedAttachmentProjection(peerId);
    }
    set((state) => {
      const { [contactId]: removedMessages, ...messagesByContactId } = state.messagesByContactId;
      const { [contactId]: removedReadState, ...lastReadAtByContactId } = state.lastReadAtByContactId;
      const { [contactId]: removedTyping, ...typingExpiresAtByContactId } = state.typingExpiresAtByContactId;
      void removedMessages;
      void removedReadState;
      void removedTyping;
      return {
        contacts: state.contacts.filter((existing) => existing.contactId !== contactId),
        selectedContactId: state.selectedContactId === contactId ? null : state.selectedContactId,
        messagesByContactId,
        lastReadAtByContactId,
        typingExpiresAtByContactId
      };
    });
    void Promise.all([
      deleteStoredContact(contactId),
      deleteStoredMessagesForContact(contactId),
      deleteStoredReadState(contactId)
    ]).catch(() => {
      // Best-effort persistence; the contact and local conversation are
      // already absent from this session even when IndexedDB is unavailable.
    });
  },
  selectContact: (selectedContactId) => { set({ selectedContactId }); }
});
