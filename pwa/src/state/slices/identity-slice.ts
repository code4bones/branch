import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";

export type IdentityStatus = "unknown" | "missing" | "ready";

export interface LocalIdentitySummary {
  readonly peerId: string;
  readonly relayPublicKey: string;
  readonly hpkePublicKey: string;
  readonly displayName: string | null;
  readonly createdAt: number;
}

export interface IdentitySlice {
  readonly identityStatus: IdentityStatus;
  readonly identity: LocalIdentitySummary | null;
  readonly setIdentity: (identity: LocalIdentitySummary) => void;
  readonly clearIdentity: () => void;
}

// Public identity summary only. The Ed25519 relay-session private key and the
// HPKE payload private key never enter this store — see
// src/identity/identity-keys.ts and docs/ENGINEERING.md's "Zustand holds
// presentation state, not keys" rule.
export const createIdentitySlice: StateCreator<AppStore, [], [], IdentitySlice> = (set) => ({
  identityStatus: "unknown",
  identity: null,
  setIdentity: (identity) => { set({ identity, identityStatus: "ready" }); },
  clearIdentity: () => { set({ identity: null, identityStatus: "missing" }); }
});
