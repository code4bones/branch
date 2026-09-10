import type { RelayRouteMaterial } from "@code4bones/branch-core";
import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";

export type RouteStatus = "idle" | "searching" | "found" | "failed";

export interface ConnectionSlice {
  readonly routeStatus: RouteStatus;
  // Bounded list of validated candidate routes. The primary chat session
  // tries them locally in order until one accepts attachment.
  readonly discoveredRoutes: readonly RelayRouteMaterial[];
  readonly routeSource: string;
  readonly discoveryMessage: string;
  readonly setRouteSearching: () => void;
  readonly setRouteFound: (routes: readonly RelayRouteMaterial[], source: string) => void;
  readonly setRouteFailed: (message: string) => void;
  readonly resetRoute: () => void;
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
  setRouteSearching: () => { set({ routeStatus: "searching", discoveredRoutes: [], routeSource: "", discoveryMessage: "Searching for a relay…" }); },
  setRouteFound: (routes, source) =>
    { set({
      routeStatus: "found",
      discoveredRoutes: routes,
      routeSource: source,
      discoveryMessage: `Found ${String(routes.length)} relay route${routes.length === 1 ? "" : "s"} via ${source}`
    }); },
  setRouteFailed: (message) => { set({ routeStatus: "failed", discoveredRoutes: [], routeSource: "", discoveryMessage: message }); },
  resetRoute: () => { set({ routeStatus: "idle", discoveredRoutes: [], routeSource: "", discoveryMessage: "" }); }
});
