import { createContext, useContext, useRef, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import { defaultBranchWrapper, ribbonProfileLabel } from "./defaults.js";
import { githubDiscoveryDefaultQuery, type GitHubDiscoveryResult } from "./github-discovery.js";
import type { GitHubDropInFile } from "./github-dropin.js";
import type { TransformLabProgress, TransformLabResult } from "./transform-lab.js";
import { defaultBootstrapRelayEndpointUri } from "../protocol/v0/bootstrap-beacon.js";
import type { LoadedBrowserImage } from "../visual/canvas-image.js";

export type AdminTab = "ribbon" | "github";
export type RibbonTab = "encode" | "decode";
export type GitHubTab = "generate" | "check";
export type StatusClass = "status-good" | "status-warn" | "status-bad";

export interface RibbonFormState {
  readonly wrapper: string;
  readonly outputWidth: string;
  readonly outputHeight: string;
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
  readonly canvas: string;
  readonly ecc: string;
}

export interface GitHubState {
  readonly mode: "demo" | "live";
  readonly records: string;
  readonly relayEndpointUri: string;
  readonly sourceCommit: string;
  readonly files: readonly GitHubDropInFile[];
  readonly selectedFile: number;
  readonly badgeSnippet: string;
  readonly discoveryQuery: string;
  readonly discoveryIncludeForks: boolean;
  readonly discoveryIncludeLegacyFallback: boolean;
  readonly discoveryPerPage: string;
  readonly discoveryPage: string;
  readonly discoveryRunning: boolean;
  readonly discoveryResults: readonly GitHubDiscoveryResult[];
  readonly status: string;
  readonly statusClass: StatusClass;
  readonly discoveryStatus: string;
  readonly discoveryStatusClass: StatusClass;
}

export interface TransformLabState {
  readonly selectedPresetId: string;
  readonly running: boolean;
  readonly status: string;
  readonly statusClass: StatusClass;
  readonly progress: TransformLabProgress | null;
  readonly results: readonly TransformLabResult[];
  readonly reportJson: string;
}

export interface AdminState {
  readonly activeTab: AdminTab;
  readonly ribbonTab: RibbonTab;
  readonly githubTab: GitHubTab;
  readonly ribbon: RibbonFormState;
  readonly cover: LoadedCoverState | null;
  readonly ribbonPngUrl: string;
  readonly decodedWrapper: string;
  readonly diagnostics: DiagnosticsState;
  readonly transformLab: TransformLabState;
  readonly github: GitHubState;
}

export interface AdminActions {
  readonly setActiveTab: (tab: AdminTab) => void;
  readonly setRibbonTab: (tab: RibbonTab) => void;
  readonly setGitHubTab: (tab: GitHubTab) => void;
  readonly setRibbonField: <K extends keyof RibbonFormState>(field: K, value: RibbonFormState[K]) => void;
  readonly setCover: (cover: LoadedCoverState | null) => void;
  readonly setRibbonPngUrl: (url: string) => void;
  readonly setDecodedWrapper: (wrapper: string) => void;
  readonly setDiagnostics: (diagnostics: DiagnosticsState) => void;
  readonly setTransformLabSelectedPreset: (presetId: string) => void;
  readonly setTransformLabRunning: (running: boolean) => void;
  readonly setTransformLabProgress: (progress: TransformLabProgress | null) => void;
  readonly setTransformLabResults: (results: readonly TransformLabResult[], reportJson: string) => void;
  readonly setTransformLabStatus: (status: string, statusClass: StatusClass) => void;
  readonly setGitHubRecords: (records: string) => void;
  readonly setGitHubRelayEndpointUri: (relayEndpointUri: string) => void;
  readonly setGitHubMode: (mode: GitHubState["mode"]) => void;
  readonly setGitHubSourceCommit: (sourceCommit: string) => void;
  readonly setGitHubFiles: (files: readonly GitHubDropInFile[]) => void;
  readonly setGitHubBadgeSnippet: (badgeSnippet: string) => void;
  readonly setSelectedGitHubFile: (index: number) => void;
  readonly setGitHubStatus: (status: string, statusClass: StatusClass) => void;
  readonly setGitHubDiscoveryQuery: (query: string) => void;
  readonly setGitHubDiscoveryIncludeForks: (includeForks: boolean) => void;
  readonly setGitHubDiscoveryIncludeLegacyFallback: (includeLegacyFallback: boolean) => void;
  readonly setGitHubDiscoveryPerPage: (perPage: string) => void;
  readonly setGitHubDiscoveryPage: (page: string) => void;
  readonly setGitHubDiscoveryRunning: (running: boolean) => void;
  readonly setGitHubDiscoveryResults: (results: readonly GitHubDiscoveryResult[]) => void;
  readonly setGitHubDiscoveryStatus: (status: string, statusClass: StatusClass) => void;
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
    mode: "block",
    payloadLength: "-",
    canvas: "640x640",
    ecc: "block-repeat",
    ...patch
  };
}

function createAdminStore(): AdminStoreApi {
  return createStore<AdminStore>()((set) => ({
    activeTab: "ribbon",
    ribbonTab: "encode",
    githubTab: "generate",
    ribbon: {
      wrapper: defaultBranchWrapper,
      outputWidth: "1000",
      outputHeight: "1500"
    },
    cover: null,
    ribbonPngUrl: "",
    decodedWrapper: "",
    diagnostics: createDiagnostics("idle", "status-warn"),
    transformLab: {
      selectedPresetId: "jpeg-80",
      running: false,
      status: "idle",
      statusClass: "status-warn",
      progress: null,
      results: [],
      reportJson: ""
    },
    github: {
      mode: "demo",
      records: "",
      relayEndpointUri: defaultBootstrapRelayEndpointUri,
      sourceCommit: "",
      files: [],
      selectedFile: 0,
      badgeSnippet: "",
      discoveryQuery: githubDiscoveryDefaultQuery,
      discoveryIncludeForks: false,
      discoveryIncludeLegacyFallback: true,
      discoveryPerPage: "5",
      discoveryPage: "1",
      discoveryRunning: false,
      discoveryResults: [],
      status: "idle",
      statusClass: "status-warn",
      discoveryStatus: "idle",
      discoveryStatusClass: "status-warn"
    },
    setActiveTab: (tab) => { set({ activeTab: tab }); },
    setRibbonTab: (tab) => { set({ ribbonTab: tab }); },
    setGitHubTab: (tab) => { set({ githubTab: tab }); },
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
    setTransformLabSelectedPreset: (selectedPresetId) =>
      { set((state) => ({
        transformLab: {
          ...state.transformLab,
          selectedPresetId
        }
      })); },
    setTransformLabRunning: (running) =>
      { set((state) => ({
        transformLab: {
          ...state.transformLab,
          running
        }
      })); },
    setTransformLabProgress: (progress) =>
      { set((state) => ({
        transformLab: {
          ...state.transformLab,
          progress
        }
      })); },
    setTransformLabResults: (results, reportJson) =>
      { set((state) => ({
        transformLab: {
          ...state.transformLab,
          results,
          reportJson
        }
      })); },
    setTransformLabStatus: (status, statusClass) =>
      { set((state) => ({
        transformLab: {
          ...state.transformLab,
          status,
          statusClass
        }
      })); },
    setGitHubRecords: (records) =>
      { set((state) => ({
        github: {
          ...state.github,
          records
        }
      })); },
    setGitHubRelayEndpointUri: (relayEndpointUri) =>
      { set((state) => ({
        github: {
          ...state.github,
          relayEndpointUri
        }
      })); },
    setGitHubMode: (mode) =>
      { set((state) => ({
        github: {
          ...state.github,
          mode
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
    setGitHubBadgeSnippet: (badgeSnippet) =>
      { set((state) => ({
        github: {
          ...state.github,
          badgeSnippet
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
      })); },
    setGitHubDiscoveryQuery: (discoveryQuery) =>
      { set((state) => ({
        github: {
          ...state.github,
          discoveryQuery
        }
      })); },
    setGitHubDiscoveryIncludeForks: (discoveryIncludeForks) =>
      { set((state) => ({
        github: {
          ...state.github,
          discoveryIncludeForks
        }
      })); },
    setGitHubDiscoveryIncludeLegacyFallback: (discoveryIncludeLegacyFallback) =>
      { set((state) => ({
        github: {
          ...state.github,
          discoveryIncludeLegacyFallback
        }
      })); },
    setGitHubDiscoveryPerPage: (discoveryPerPage) =>
      { set((state) => ({
        github: {
          ...state.github,
          discoveryPerPage
        }
      })); },
    setGitHubDiscoveryPage: (discoveryPage) =>
      { set((state) => ({
        github: {
          ...state.github,
          discoveryPage
        }
      })); },
    setGitHubDiscoveryRunning: (discoveryRunning) =>
      { set((state) => ({
        github: {
          ...state.github,
          discoveryRunning
        }
      })); },
    setGitHubDiscoveryResults: (discoveryResults) =>
      { set((state) => ({
        github: {
          ...state.github,
          discoveryResults
        }
      })); },
    setGitHubDiscoveryStatus: (discoveryStatus, discoveryStatusClass) =>
      { set((state) => ({
        github: {
          ...state.github,
          discoveryStatus,
          discoveryStatusClass
        }
      })); }
  }));
}
