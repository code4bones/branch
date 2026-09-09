import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";

export type ThemeMode = "dark" | "light";

export interface UiSlice {
  readonly themeMode: ThemeMode;
  readonly navCollapsed: boolean;
  readonly setThemeMode: (mode: ThemeMode) => void;
  readonly toggleNavCollapsed: () => void;
}

export const createUiSlice: StateCreator<AppStore, [], [], UiSlice> = (set) => ({
  themeMode: "dark",
  navCollapsed: false,
  setThemeMode: (themeMode) => { set({ themeMode }); },
  toggleNavCollapsed: () => { set((state) => ({ navCollapsed: !state.navCollapsed })); }
});
