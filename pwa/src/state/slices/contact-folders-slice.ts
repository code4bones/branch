import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";
import {
  deleteStoredContactFolder,
  deleteStoredContactFolderAssignment,
  saveStoredContactFolder,
  saveStoredContactFolderAssignment
} from "../../storage/contact-folders-store.js";
import {
  maxContactFolders,
  normalizeContactFolderName,
  type ContactFolder,
  type ContactFolderAssignment
} from "../contact-folders-model.js";

export interface ContactFoldersSlice {
  readonly contactFolders: readonly ContactFolder[];
  readonly contactFolderIdByContactId: Readonly<Record<string, string>>;
  readonly hydrateContactFolders: (folders: readonly ContactFolder[], assignments: readonly ContactFolderAssignment[]) => void;
  readonly createContactFolder: (folderId: string, name: string, createdAt?: number) => boolean;
  readonly renameContactFolder: (folderId: string, name: string) => boolean;
  readonly deleteContactFolder: (folderId: string) => void;
  readonly assignContactFolder: (contactId: string, folderId: string | null) => boolean;
  readonly clearContactFolderAssignment: (contactId: string) => void;
}

export const createContactFoldersSlice: StateCreator<AppStore, [], [], ContactFoldersSlice> = (set, get) => ({
  contactFolders: [],
  contactFolderIdByContactId: {},
  hydrateContactFolders: (folders, assignments) => {
    const acceptedFolders = folders
      .filter((folder, index, all) => index === all.findIndex((candidate) => candidate.folderId === folder.folderId))
      .slice(0, maxContactFolders);
    const validFolderIds = new Set(acceptedFolders.map((folder) => folder.folderId));
    const knownContactIds = new Set(get().contacts.map((contact) => contact.contactId));
    const contactFolderIdByContactId: Record<string, string> = {};
    for (const assignment of assignments) {
      if (knownContactIds.has(assignment.contactId) && validFolderIds.has(assignment.folderId)) {
        contactFolderIdByContactId[assignment.contactId] = assignment.folderId;
      }
    }
    set({ contactFolders: acceptedFolders, contactFolderIdByContactId });
  },
  createContactFolder: (folderId, name, createdAt = Date.now()) => {
    const normalizedName = normalizeContactFolderName(name);
    if (
      normalizedName === null
      || get().contactFolders.length >= maxContactFolders
      || get().contactFolders.some((folder) => folder.folderId === folderId || folder.name === normalizedName)
    ) return false;
    const folder: ContactFolder = { folderId, name: normalizedName, createdAt };
    set((state) => ({ contactFolders: [...state.contactFolders, folder] }));
    void saveStoredContactFolder(folder).catch(() => {
      // Folder organization remains usable for this session when IndexedDB is unavailable.
    });
    return true;
  },
  renameContactFolder: (folderId, name) => {
    const normalizedName = normalizeContactFolderName(name);
    if (normalizedName === null || get().contactFolders.some((folder) => folder.folderId !== folderId && folder.name === normalizedName)) return false;
    const current = get().contactFolders.find((folder) => folder.folderId === folderId);
    if (current === undefined) return false;
    const renamed: ContactFolder = { ...current, name: normalizedName };
    set((state) => ({ contactFolders: state.contactFolders.map((folder) => folder.folderId === folderId ? renamed : folder) }));
    void saveStoredContactFolder(renamed).catch(() => {
      // Best-effort local persistence only.
    });
    return true;
  },
  deleteContactFolder: (folderId) => {
    set((state) => ({
      contactFolders: state.contactFolders.filter((folder) => folder.folderId !== folderId),
      contactFolderIdByContactId: Object.fromEntries(Object.entries(state.contactFolderIdByContactId).filter(([, assignedFolderId]) => assignedFolderId !== folderId))
    }));
    void deleteStoredContactFolder(folderId).catch(() => {
      // Best-effort local persistence only.
    });
  },
  assignContactFolder: (contactId, folderId) => {
    if (!get().contacts.some((contact) => contact.contactId === contactId)) return false;
    if (folderId !== null && !get().contactFolders.some((folder) => folder.folderId === folderId)) return false;
    set((state) => {
      if (folderId === null) {
        const { [contactId]: removed, ...remaining } = state.contactFolderIdByContactId;
        void removed;
        return { contactFolderIdByContactId: remaining };
      }
      return { contactFolderIdByContactId: { ...state.contactFolderIdByContactId, [contactId]: folderId } };
    });
    if (folderId === null) {
      void deleteStoredContactFolderAssignment(contactId).catch(() => {});
    } else {
      void saveStoredContactFolderAssignment({ contactId, folderId }).catch(() => {});
    }
    return true;
  },
  clearContactFolderAssignment: (contactId) => {
    const wasAssigned = get().contactFolderIdByContactId[contactId] !== undefined;
    if (!wasAssigned) return;
    set((state) => {
      const { [contactId]: removed, ...remaining } = state.contactFolderIdByContactId;
      void removed;
      return { contactFolderIdByContactId: remaining };
    });
    void deleteStoredContactFolderAssignment(contactId).catch(() => {});
  }
});
