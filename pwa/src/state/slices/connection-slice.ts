import type { VerifiedRelayRouteMaterial } from "@code4bones/branch-core";
import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";
import { relayRouteKey } from "../../connectivity/relay-route-selection.js";

export type RouteStatus = "idle" | "searching" | "found" | "failed";

export interface ConnectionSlice {
  readonly routeStatus: RouteStatus;
  // Bounded list of validated candidate routes. The primary chat session
  // tries them locally in order until one accepts attachment.
  readonly discoveredRoutes: readonly VerifiedRelayRouteMaterial[];
  readonly routeSource: string;
  readonly discoveryMessage: string;
  /** A tab-local relay test pin; null retains deterministic automatic order. */
  readonly selectedRelayKey: string | null;
  readonly setRouteSearching: () => void;
  readonly setRouteFound: (routes: readonly VerifiedRelayRouteMaterial[], source: string) => void;
  readonly setRouteFailed: (message: string) => void;
  readonly resetRoute: () => void;
  readonly setSelectedRelayKey: (relayKey: string | null) => void;
}

// Deliberately not persisted: discovered routes are a live-session claim, not
// canonical state. Every fresh app start re-searches per docs/ARCHITECTURE.md
// ("resume as a fresh local reconciliation ... revalidate unexpired carrier
// observations, probe relay liveness").
export const createConnectionSlice: StateCreator<AppStore, [], [], ConnectionSlice> = (set) => ({
  routeStatus: "idle",
  discoveredRoutes: [],
  routeSource: "",
  discoveryMessage: "",
  selectedRelayKey: null,
  setRouteSearching: () => { set({ routeStatus: "searching", discoveredRoutes: [], routeSource: "", discoveryMessage: "Searching for a relay…", selectedRelayKey: null }); },
  setRouteFound: (routes, source) =>
    { set((state) => ({
      routeStatus: "found",
      discoveredRoutes: routes,
      routeSource: source,
      discoveryMessage: `Found ${String(routes.length)} relay route${routes.length === 1 ? "" : "s"} via ${source}`,
      selectedRelayKey: state.selectedRelayKey !== null && routes.some((route) => relayRouteKey(route) === state.selectedRelayKey)
        ? state.selectedRelayKey
        : null
    })); },
  setRouteFailed: (message) => { set({ routeStatus: "failed", discoveredRoutes: [], routeSource: "", discoveryMessage: message, selectedRelayKey: null }); },
  resetRoute: () => { set({ routeStatus: "idle", discoveredRoutes: [], routeSource: "", discoveryMessage: "", selectedRelayKey: null }); },
  setSelectedRelayKey: (selectedRelayKey) => { set((state) => ({
    selectedRelayKey: selectedRelayKey !== null && state.discoveredRoutes.some((route) => relayRouteKey(route) === selectedRelayKey)
      ? selectedRelayKey
      : null
  })); }
});
