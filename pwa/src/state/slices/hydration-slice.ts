import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";

export interface HydrationSlice {
  readonly conversationsLoaded: boolean;
  readonly setConversationsLoaded: () => void;
}

// Flips once on app start after IndexedDB-backed contacts/messages/read-state
// are hydrated (see src/storage/use-conversations-bootstrap.ts). RequireIdentity
// waits for this so a returning user doesn't see a flash of demo content
// before their real data replaces it.
export const createHydrationSlice: StateCreator<AppStore, [], [], HydrationSlice> = (set) => ({
  conversationsLoaded: false,
  setConversationsLoaded: () => { set({ conversationsLoaded: true }); }
});
