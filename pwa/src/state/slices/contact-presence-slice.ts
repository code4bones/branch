import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";

const maxContactPresenceEntries = 64;

export type ContactPresenceStatus = "unknown" | "checking" | "available";
export type ContactPresenceEvidence = "encrypted_pong" | "encrypted_live_traffic" | null;

export interface ContactPresence {
  readonly status: ContactPresenceStatus;
  // `available` requires one of these endpoint-authenticated local proofs.
  // A relay ACK is deliberately never evidence of peer presence.
  readonly evidence: ContactPresenceEvidence;
  readonly updatedAt: number;
  // This is only a local scheduling timestamp. It is never a presence claim,
  // stored contact field, relay input, or message metadata.
  readonly lastProbeAt: number | null;
  readonly pendingPingId: string | null;
}

export interface ContactPresenceSlice {
  readonly contactPresenceById: Readonly<Record<string, ContactPresence>>;
  readonly beginContactPresencePing: (contactId: string, pingId: string, now?: number) => void;
  readonly acceptContactPresencePong: (contactId: string, pingId: string, now?: number) => void;
  readonly confirmContactPresenceFromLiveTraffic: (contactId: string, now?: number) => void;
  readonly expireContactPresencePing: (contactId: string, pingId: string) => void;
  readonly expireContactPresence: (contactId: string, updatedAt: number) => void;
}

// Presence is intentionally an in-memory UI projection of an encrypted pong.
// It is never persisted with contacts or messages and is bounded even if a
// user cycles through many contacts in one long-running tab.
export const createContactPresenceSlice: StateCreator<AppStore, [], [], ContactPresenceSlice> = (set) => ({
  contactPresenceById: {},
  beginContactPresencePing: (contactId, pingId, now = Date.now()) => {
    set((state) => {
      const current = state.contactPresenceById[contactId];
      const isStillAvailable = current?.status === "available";
      return {
        contactPresenceById: boundedPresenceMap({
          ...state.contactPresenceById,
          // A fresh probe cannot revoke an already verified presence claim.
          // That claim remains usable until its own TTL expires; the pong only
          // refreshes it, while a missed pong simply clears this probe.
          [contactId]: {
            status: isStillAvailable ? "available" : "checking",
            evidence: isStillAvailable ? current.evidence : null,
            updatedAt: isStillAvailable ? current.updatedAt : now,
            lastProbeAt: now,
            pendingPingId: pingId
          }
        })
      };
    });
  },
  acceptContactPresencePong: (contactId, pingId, now = Date.now()) => {
    set((state) => {
      const current = state.contactPresenceById[contactId];
      if (current?.pendingPingId !== pingId) {
        return state;
      }
      return {
        contactPresenceById: {
          ...state.contactPresenceById,
          [contactId]: { ...current, status: "available", evidence: "encrypted_pong", updatedAt: now, pendingPingId: null }
        }
      };
    });
  },
  confirmContactPresenceFromLiveTraffic: (contactId, now = Date.now()) => {
    set((state) => {
      const current = state.contactPresenceById[contactId];
      return {
        contactPresenceById: boundedPresenceMap({
          ...state.contactPresenceById,
          [contactId]: {
            status: "available",
            evidence: "encrypted_live_traffic",
            updatedAt: now,
            lastProbeAt: current?.lastProbeAt ?? null,
            pendingPingId: null
          }
        })
      };
    });
  },
  expireContactPresencePing: (contactId, pingId) => {
    set((state) => {
      const current = state.contactPresenceById[contactId];
      if (current?.pendingPingId !== pingId) {
        return state;
      }
      return {
        contactPresenceById: {
          ...state.contactPresenceById,
          [contactId]: current.status === "checking"
            ? { ...current, status: "unknown", evidence: null, updatedAt: Date.now(), pendingPingId: null }
            : { ...current, pendingPingId: null }
        }
      };
    });
  },
  expireContactPresence: (contactId, updatedAt) => {
    set((state) => {
      const current = state.contactPresenceById[contactId];
      if (current === undefined || current.updatedAt !== updatedAt) {
        return state;
      }
      return {
        contactPresenceById: {
          ...state.contactPresenceById,
          [contactId]: { ...current, status: "unknown", evidence: null, updatedAt: Date.now(), pendingPingId: null }
        }
      };
    });
  }
});

function boundedPresenceMap(entries: Readonly<Record<string, ContactPresence>>): Readonly<Record<string, ContactPresence>> {
  const pairs = Object.entries(entries);
  if (pairs.length <= maxContactPresenceEntries) {
    return entries;
  }
  const oldest = pairs.reduce((selected, candidate) => candidate[1].updatedAt < selected[1].updatedAt ? candidate : selected);
  const { [oldest[0]]: removed, ...bounded } = entries;
  void removed;
  return bounded;
}
