import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";

export type AttachStatus = "idle" | "attaching" | "attached" | "error";
export interface TransportTraceEntry {
  readonly at: number;
  readonly detail: string;
}

// This is intentionally tab-local diagnostic state, not a session log. Keep
// enough room for several diagnostic windows amid ordinary heartbeats, but
// still bound it so a long-lived attachment cannot grow without limit.
const maxTransportTraceEntries = 192;

export interface TransportSlice {
  readonly attachStatus: AttachStatus;
  readonly attachMessage: string;
  /**
   * This tab's currently authenticated relay endpoint, for local developer
   * presentation only. It is deliberately neither trace data nor persisted
   * application state, and never represents a contact's relay placement.
   */
  readonly attachedRelayEndpoint: string | null;
  readonly transportTrace: readonly TransportTraceEntry[];
  readonly setAttachStatus: (status: AttachStatus, message: string) => void;
  readonly setAttachedRelayEndpoint: (endpoint: string | null) => void;
  readonly recordTransportTrace: (detail: string) => void;
}

// UI-facing transport status only. The live SameRelayTransportClient instance
// and delivery-tracking map live in src/connectivity/relay-session.ts, a
// plain module singleton — not the Zustand store (see docs/ENGINEERING.md:
// Zustand holds presentation state, not canonical protocol state).
export const createTransportSlice: StateCreator<AppStore, [], [], TransportSlice> = (set) => ({
  attachStatus: "idle",
  attachMessage: "",
  attachedRelayEndpoint: null,
  transportTrace: [],
  setAttachStatus: (attachStatus, attachMessage) => { set({ attachStatus, attachMessage }); },
  setAttachedRelayEndpoint: (attachedRelayEndpoint) => { set({ attachedRelayEndpoint }); },
  recordTransportTrace: (detail) => {
    const boundedDetail = detail.replaceAll(/[\r\n\t]+/gu, " ").slice(0, 180);
    set((state) => ({
      transportTrace: [...state.transportTrace, { at: Date.now(), detail: boundedDetail }].slice(-maxTransportTraceEntries)
    }));
  }
});
