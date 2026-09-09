import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";

export type AttachStatus = "idle" | "attaching" | "attached" | "error";
export interface TransportTraceEntry {
  readonly at: number;
  readonly detail: string;
}

const maxTransportTraceEntries = 24;

export interface TransportSlice {
  readonly attachStatus: AttachStatus;
  readonly attachMessage: string;
  readonly transportTrace: readonly TransportTraceEntry[];
  readonly setAttachStatus: (status: AttachStatus, message: string) => void;
  readonly recordTransportTrace: (detail: string) => void;
}

// UI-facing transport status only. The live SameRelayTransportClient instance
// and delivery-tracking map live in src/connectivity/relay-session.ts, a
// plain module singleton — not the Zustand store (see docs/ENGINEERING.md:
// Zustand holds presentation state, not canonical protocol state).
export const createTransportSlice: StateCreator<AppStore, [], [], TransportSlice> = (set) => ({
  attachStatus: "idle",
  attachMessage: "",
  transportTrace: [],
  setAttachStatus: (attachStatus, attachMessage) => { set({ attachStatus, attachMessage }); },
  recordTransportTrace: (detail) => {
    const boundedDetail = detail.replaceAll(/[\r\n\t]+/gu, " ").slice(0, 180);
    set((state) => ({
      transportTrace: [...state.transportTrace, { at: Date.now(), detail: boundedDetail }].slice(-maxTransportTraceEntries)
    }));
  }
});
