import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";
import { saveStoredReadState } from "../../storage/read-state-store.js";

export interface ReadStateSlice {
  readonly lastReadAtByContactId: Readonly<Record<string, number>>;
  readonly markContactRead: (contactId: string) => void;
}

export const createReadStateSlice: StateCreator<AppStore, [], [], ReadStateSlice> = (set) => ({
  lastReadAtByContactId: {},
  markContactRead: (contactId) => {
    const timestamp = Date.now();
    set((state) => ({
      lastReadAtByContactId: {
        ...state.lastReadAtByContactId,
        [contactId]: timestamp
      }
    }));
    void saveStoredReadState(contactId, timestamp).catch(() => {
      // Best-effort persistence; unread badges just recompute from memory.
    });
  }
});
