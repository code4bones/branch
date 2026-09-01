import { createContext, useContext, useRef, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import { defaultBranchWrapper, ribbonProfileLabel } from "./defaults.js";
import type { GitHubDropInFile } from "./github-dropin.js";
import type { LoadedBrowserImage } from "../visual/canvas-image.js";
import type { RibbonPlacement } from "../visual/geometry.js";
import type { RibbonVisualMode } from "../visual/ribbon-render.js";

export type AdminTab = "ribbon" | "github";
export type StatusClass = "status-good" | "status-warn" | "status-bad";

export interface RibbonFormState {
  readonly wrapper: string;
  readonly visualMode: RibbonVisualMode;
  readonly quietZone: string;
  readonly carrierSize: string;
  readonly tintStrength: string;
  readonly outputWidth: string;
  readonly outputHeight: string;
  readonly placement: RibbonPlacement;
}

export interface LoadedCoverState {
  readonly image: LoadedBrowserImage;
  readonly filename: string;
}

export interface DiagnosticsState {
  readonly profile: string;
  readonly status: string;
  readonly statusClass: StatusClass;
  readonly mode: string;
  readonly payloadLength: string;
  readonly sourceSymbolVersion: string;
  readonly moduleCount: string;
  readonly modulePitch: string;
  readonly quietZone: string;
  readonly canvas: string;
  readonly ecc: string;
}

export interface GitHubState {
  readonly records: string;
  readonly sourceCommit: string;
  readonly files: readonly GitHubDropInFile[];
  readonly selectedFile: number;
  readonly status: string;
  readonly statusClass: StatusClass;
}

export interface AdminState {
  readonly activeTab: AdminTab;
  readonly ribbon: RibbonFormState;
  readonly cover: LoadedCoverState | null;
  readonly ribbonPngUrl: string;
  readonly decodedWrapper: string;
  readonly diagnostics: DiagnosticsState;
  readonly github: GitHubState;
}

export interface AdminActions {
  readonly setActiveTab: (tab: AdminTab) => void;
  readonly setRibbonField: <K extends keyof RibbonFormState>(field: K, value: RibbonFormState[K]) => void;
  readonly setCover: (cover: LoadedCoverState | null) => void;
  readonly setRibbonPngUrl: (url: string) => void;
  readonly setDecodedWrapper: (wrapper: string) => void;
  readonly setDiagnostics: (diagnostics: DiagnosticsState) => void;
  readonly setGitHubRecords: (records: string) => void;
  readonly setGitHubSourceCommit: (sourceCommit: string) => void;
  readonly setGitHubFiles: (files: readonly GitHubDropInFile[]) => void;
  readonly setSelectedGitHubFile: (index: number) => void;
  readonly setGitHubStatus: (status: string, statusClass: StatusClass) => void;
}

export type AdminStore = AdminState & AdminActions;

type AdminStoreApi = StoreApi<AdminStore>;

const AdminStoreContext = createContext<AdminStoreApi | null>(null);

export function AdminStoreProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const storeRef = useRef<AdminStoreApi | null>(null);
  storeRef.current ??= createAdminStore();
  return <AdminStoreContext.Provider value={storeRef.current}>{children}</AdminStoreContext.Provider>;
}

export function useAdminStore<T>(selector: (state: AdminStore) => T): T {
  const store = useContext(AdminStoreContext);
  if (store === null) {
    throw new Error("admin store provider missing");
  }
  return useStore(store, selector);
}

export function createDiagnostics(status: string, statusClass: StatusClass, patch: Partial<DiagnosticsState> = {}): DiagnosticsState {
  return {
    profile: ribbonProfileLabel,
    status,
    statusClass,
    mode: "tint",
    payloadLength: "-",
    sourceSymbolVersion: "-",
    moduleCount: "-",
    modulePitch: "-",
    quietZone: "-",
    canvas: "640x640",
    ecc: "H",
    ...patch
  };
}

function createAdminStore(): AdminStoreApi {
  return createStore<AdminStore>()((set) => ({
    activeTab: "ribbon",
    ribbon: {
      wrapper: defaultBranchWrapper,
      visualMode: "tint",
      quietZone: "8",
      carrierSize: "720",
      tintStrength: "0",
      outputWidth: "1000",
      outputHeight: "1500",
      placement: "bottom-right"
    },
    cover: null,
    ribbonPngUrl: "",
    decodedWrapper: "",
    diagnostics: createDiagnostics("idle", "status-warn"),
    github: {
      records: "",
      sourceCommit: "",
      files: [],
      selectedFile: 0,
      status: "idle",
      statusClass: "status-warn"
    },
    setActiveTab: (tab) => { set({ activeTab: tab }); },
    setRibbonField: (field, value) =>
      { set((state) => ({
        ribbon: {
          ...state.ribbon,
          [field]: value
        }
      })); },
    setCover: (cover) => { set({ cover }); },
    setRibbonPngUrl: (url) => { set({ ribbonPngUrl: url }); },
    setDecodedWrapper: (wrapper) => { set({ decodedWrapper: wrapper }); },
    setDiagnostics: (diagnostics) => { set({ diagnostics }); },
    setGitHubRecords: (records) =>
      { set((state) => ({
        github: {
          ...state.github,
          records
        }
      })); },
    setGitHubSourceCommit: (sourceCommit) =>
      { set((state) => ({
        github: {
          ...state.github,
          sourceCommit
        }
      })); },
    setGitHubFiles: (files) =>
      { set((state) => ({
        github: {
          ...state.github,
          files,
          selectedFile: 0
        }
      })); },
    setSelectedGitHubFile: (index) =>
      { set((state) => ({
        github: {
          ...state.github,
          selectedFile: index
        }
      })); },
    setGitHubStatus: (status, statusClass) =>
      { set((state) => ({
        github: {
          ...state.github,
          status,
          statusClass
        }
      })); }
  }));
}
