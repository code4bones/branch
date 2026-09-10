import type { StateCreator } from "zustand";

import { saveStoredContactDiscoveryPolicy } from "../../storage/contact-discovery-policy-store.js";
import type { AppStore } from "../store.js";

export interface ContactDiscoveryPolicySlice {
  readonly allowContactDiscovery: boolean;
  readonly setAllowContactDiscovery: (enabled: boolean) => void;
}

export const createContactDiscoveryPolicySlice: StateCreator<AppStore, [], [], ContactDiscoveryPolicySlice> = (set) => ({
  // Discoverability is intentionally enabled by default, but the relay learns
  // it only through a live CONTACT_ANNOUNCE on a negotiated extension.
  allowContactDiscovery: true,
  setAllowContactDiscovery: (allowContactDiscovery) => {
    set({ allowContactDiscovery });
    void saveStoredContactDiscoveryPolicy(allowContactDiscovery).catch(() => {});
  }
});
