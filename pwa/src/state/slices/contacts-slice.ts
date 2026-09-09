import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";
import { demoContacts } from "../demo-seed.js";
import { deleteStoredContact, saveStoredContact } from "../../storage/contacts-store.js";
import { deleteStoredMessagesForContact } from "../../storage/messages-store.js";
import { deleteStoredReadState } from "../../storage/read-state-store.js";

export interface ContactSummary {
  readonly contactId: string;
  readonly displayName: string;
  // peerId/hpkePublicKey are null for the demo/placeholder contacts seeded
  // below; only a contact with both set can actually be reached over a
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

export const createContactsSlice: StateCreator<AppStore, [], [], ContactsSlice> = (set) => ({
  contacts: demoContacts,
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
