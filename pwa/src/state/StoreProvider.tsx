import { createContext, useContext, useRef, type ReactNode } from "react";
import { useStore } from "zustand";

import { createAppStore, type AppStore, type AppStoreApi } from "./store.js";

const AppStoreContext = createContext<AppStoreApi | null>(null);

export function AppStoreProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const storeRef = useRef<AppStoreApi | null>(null);
  storeRef.current ??= createAppStore();
  return <AppStoreContext.Provider value={storeRef.current}>{children}</AppStoreContext.Provider>;
}

// Low-level escape hatch. Prefer the domain hooks in ./hooks.ts from
// components; reach for this directly only when adding a new domain hook.
export function useAppStore<T>(selector: (state: AppStore) => T): T {
  const store = useContext(AppStoreContext);
  if (store === null) {
    throw new Error("app store provider missing");
  }
  return useStore(store, selector);
}

// Raw vanilla store handle for imperative code (event handlers, connectivity
// glue) that needs a fresh state.getState() read without subscribing a
// component to re-render on every change.
export function useAppStoreApi(): AppStoreApi {
  const store = useContext(AppStoreContext);
  if (store === null) {
    throw new Error("app store provider missing");
  }
  return store;
}
