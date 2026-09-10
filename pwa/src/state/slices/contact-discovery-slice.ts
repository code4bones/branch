import type { StateCreator } from "zustand";
import { deleteStoredContactDiscovery, saveStoredContactDiscovery, type StoredContactDiscovery } from "../../storage/contact-discovery-store.js";
import type { AppStore } from "../store.js";

export const maxContactDiscoveryRows = 32;
export type ContactDiscoveryRow = StoredContactDiscovery;
export type ContactDiscoveryAvailability = "unavailable" | "ready" | "disabled" | "unsupported";
export interface ContactDiscoverySlice {
  readonly contactDiscoveries: readonly ContactDiscoveryRow[];
  readonly contactDiscoveryAvailability: ContactDiscoveryAvailability;
  readonly upsertContactDiscovery: (branchId: string, now: number) => boolean;
  readonly retryContactDiscovery: (branchId: string, now: number) => void;
  readonly checkedContactDiscovery: (branchId: string, now: number) => void;
  readonly resolveContactDiscovery: (branchId: string, candidate: { readonly displayName: string; readonly peerId: string; readonly hpkePublicKey: string }, now: number) => void;
  readonly deleteContactDiscovery: (branchId: string) => void;
  readonly setContactDiscoveryAvailability: (availability: ContactDiscoveryAvailability) => void;
}

export const createContactDiscoverySlice: StateCreator<AppStore, [], [], ContactDiscoverySlice> = (set) => ({
  contactDiscoveries: [],
  contactDiscoveryAvailability: "unavailable",
  upsertContactDiscovery: (branchId, now) => {
    let accepted = false;
    set((state) => {
      const existing = state.contactDiscoveries.find((row) => row.branchId === branchId);
      if (existing !== undefined) {
        const next = { ...existing, retryRequestedAt: now };
        void saveStoredContactDiscovery(next).catch(() => {});
        accepted = true;
        return { contactDiscoveries: state.contactDiscoveries.map((row) => row.branchId === branchId ? next : row) };
      }
      if (state.contactDiscoveries.length >= maxContactDiscoveryRows) return state;
      const next: ContactDiscoveryRow = { branchId, displayName: null, peerId: null, hpkePublicKey: null, lastCheckedAt: null, retryRequestedAt: now };
      void saveStoredContactDiscovery(next).catch(() => {});
      accepted = true;
      return { contactDiscoveries: [...state.contactDiscoveries, next] };
    });
    return accepted;
  },
  retryContactDiscovery: (branchId, now) => { set((state) => ({ contactDiscoveries: state.contactDiscoveries.map((row) => {
    if (row.branchId !== branchId) return row;
    const next = { ...row, retryRequestedAt: now };
    void saveStoredContactDiscovery(next).catch(() => {});
    return next;
  }) })); },
  checkedContactDiscovery: (branchId, now) => { set((state) => ({ contactDiscoveries: state.contactDiscoveries.map((row) => {
    if (row.branchId !== branchId) return row;
    const next = { ...row, lastCheckedAt: now };
    void saveStoredContactDiscovery(next).catch(() => {});
    return next;
  }) })); },
  resolveContactDiscovery: (branchId, candidate, now) => { set((state) => ({ contactDiscoveries: state.contactDiscoveries.map((row) => {
    if (row.branchId !== branchId) return row;
    const next = { ...row, ...candidate, lastCheckedAt: now };
    void saveStoredContactDiscovery(next).catch(() => {});
    return next;
  }) })); },
  deleteContactDiscovery: (branchId) => {
    set((state) => ({ contactDiscoveries: state.contactDiscoveries.filter((row) => row.branchId !== branchId) }));
    void deleteStoredContactDiscovery(branchId).catch(() => {});
  },
  setContactDiscoveryAvailability: (contactDiscoveryAvailability) => { set({ contactDiscoveryAvailability }); }
});
