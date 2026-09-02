import { createContext, useContext, useRef, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import { defaultBranchWrapper, ribbonProfileLabel } from "./defaults.js";
import { githubDiscoveryDefaultQuery, type GitHubDiscoveryResult } from "./github-discovery.js";
import type { GitHubDropInFile } from "./github-dropin.js";
import { gitLabDiscoveryDefaultQuery, type GitLabDiscoveryResult } from "./gitlab-discovery.js";
import type { GitLabDropInFile } from "./gitlab-dropin.js";
import type { IdentityContactLookupResponse } from "./identity-lookup.js";
import type { RelayMonitorObservation } from "./relay-monitor.js";
import type { TransformLabProgress, TransformLabResult } from "./transform-lab.js";
import type { CarrierHoppingTraceEvent } from "@code4bones/branch-core/connectivity/carrier-hopping-poc.js";
import { defaultBootstrapRelayEndpointUri } from "@code4bones/branch-core/protocol/v0/bootstrap-beacon.js";
import { developmentProfileMultihash } from "@code4bones/branch-core/protocol/v0/profile.js";
import type { LoadedBrowserImage } from "@code4bones/branch-core/visual/canvas-image.js";

export type AdminTab = "ribbon" | "github" | "gitlab" | "relays" | "client";
export type RibbonTab = "encode" | "decode";
export type GitHubTab = "generate" | "check";
export type GitLabTab = "generate" | "check";
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
  readonly relayAdminBaseUrl: string;
  readonly relayAdminToken: string;
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

export interface GitLabState {
  readonly mode: "demo" | "live";
  readonly records: string;
  readonly relayEndpointUri: string;
  readonly relayAdminBaseUrl: string;
  readonly relayAdminToken: string;
  readonly sourceCommit: string;
  readonly files: readonly GitLabDropInFile[];
  readonly selectedFile: number;
  readonly badgeSnippet: string;
  readonly discoveryQuery: string;
  readonly discoveryPerPage: string;
  readonly discoveryPage: string;
  readonly discoveryRunning: boolean;
  readonly discoveryResults: readonly GitLabDiscoveryResult[];
  readonly status: string;
  readonly statusClass: StatusClass;
  readonly discoveryStatus: string;
  readonly discoveryStatusClass: StatusClass;
}

export interface ClientState {
  readonly routeMode: "discovery" | "manual";
  readonly manualRelayEndpointUri: string;
  readonly manualRelayPublicKey: string;
  readonly manualProfileMultihash: string;
  readonly discoveryRunning: boolean;
  readonly discoveryStatus: string;
  readonly discoveryStatusClass: StatusClass;
  readonly discoveryQuery: string;
  readonly discoveryResults: readonly GitHubDiscoveryResult[];
  readonly rateLimitRemaining: string | null;
  readonly incompleteResults: boolean;
  readonly transportStatus: string;
  readonly transportStatusClass: StatusClass;
  readonly transportRunning: boolean;
  readonly relayEndpointUri: string;
  readonly relaySource: string;
  readonly alicePeerId: string;
  readonly bobPeerId: string;
  readonly relayAckCount: number;
  readonly peerReceiptCount: number;
  readonly pendingCount: number;
  readonly unavailableCount: number;
  readonly transportEvents: readonly string[];
  readonly federationTrace: ClientFederationTraceState;
  readonly identityLookup: IdentityLookupState;
}

export interface IdentityLookupState {
  readonly adminBaseUrl: string;
  readonly adminToken: string;
  readonly branchID: string;
  readonly running: boolean;
  readonly status: string;
  readonly statusClass: StatusClass;
  readonly result: IdentityContactLookupResponse | null;
}

export interface ClientFederationTraceState {
  readonly events: readonly CarrierHoppingTraceEvent[];
  readonly routeSnapshot: readonly string[];
  readonly routeHints: readonly string[];
  readonly activeRoute: string | null;
  readonly migrationRoute: string | null;
  readonly migrated: boolean;
}

export interface RelayMonitorState {
  readonly adminBaseUrl: string;
  readonly adminToken: string;
  readonly running: boolean;
  readonly status: string;
  readonly statusClass: StatusClass;
  readonly observations: readonly RelayMonitorObservation[];
  readonly lastRefreshAt: string | null;
}

export type ClientTransportStatePatch = Partial<Pick<ClientState,
  "transportStatus" |
  "transportStatusClass" |
  "transportRunning" |
  "relayEndpointUri" |
  "relaySource" |
  "alicePeerId" |
  "bobPeerId" |
  "relayAckCount" |
  "peerReceiptCount" |
  "pendingCount" |
  "unavailableCount" |
  "federationTrace"
>>;

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
  readonly gitLabTab: GitLabTab;
  readonly ribbon: RibbonFormState;
  readonly cover: LoadedCoverState | null;
  readonly ribbonPngUrl: string;
  readonly decodedWrapper: string;
  readonly diagnostics: DiagnosticsState;
  readonly transformLab: TransformLabState;
  readonly github: GitHubState;
  readonly gitlab: GitLabState;
  readonly relayMonitor: RelayMonitorState;
  readonly client: ClientState;
}

export interface AdminActions {
  readonly setActiveTab: (tab: AdminTab) => void;
  readonly setRibbonTab: (tab: RibbonTab) => void;
  readonly setGitHubTab: (tab: GitHubTab) => void;
  readonly setGitLabTab: (tab: GitLabTab) => void;
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
  readonly setGitHubRelayAdminBaseUrl: (relayAdminBaseUrl: string) => void;
  readonly setGitHubRelayAdminToken: (relayAdminToken: string) => void;
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
  readonly setGitLabRecords: (records: string) => void;
  readonly setGitLabRelayEndpointUri: (relayEndpointUri: string) => void;
  readonly setGitLabRelayAdminBaseUrl: (relayAdminBaseUrl: string) => void;
  readonly setGitLabRelayAdminToken: (relayAdminToken: string) => void;
  readonly setGitLabMode: (mode: GitLabState["mode"]) => void;
  readonly setGitLabSourceCommit: (sourceCommit: string) => void;
  readonly setGitLabFiles: (files: readonly GitLabDropInFile[]) => void;
  readonly setGitLabBadgeSnippet: (badgeSnippet: string) => void;
  readonly setSelectedGitLabFile: (index: number) => void;
  readonly setGitLabStatus: (status: string, statusClass: StatusClass) => void;
  readonly setGitLabDiscoveryQuery: (query: string) => void;
  readonly setGitLabDiscoveryPerPage: (perPage: string) => void;
  readonly setGitLabDiscoveryPage: (page: string) => void;
  readonly setGitLabDiscoveryRunning: (running: boolean) => void;
  readonly setGitLabDiscoveryResults: (results: readonly GitLabDiscoveryResult[]) => void;
  readonly setGitLabDiscoveryStatus: (status: string, statusClass: StatusClass) => void;
  readonly setRelayMonitorAdminBaseUrl: (adminBaseUrl: string) => void;
  readonly setRelayMonitorAdminToken: (adminToken: string) => void;
  readonly setRelayMonitorRunning: (running: boolean) => void;
  readonly setRelayMonitorObservations: (observations: readonly RelayMonitorObservation[], lastRefreshAt: string) => void;
  readonly setRelayMonitorStatus: (status: string, statusClass: StatusClass) => void;
  readonly setClientDiscoveryRunning: (running: boolean) => void;
  readonly setClientDiscoveryResults: (
    results: readonly GitHubDiscoveryResult[],
    rateLimitRemaining: string | null,
    incompleteResults: boolean
  ) => void;
  readonly setClientDiscoveryStatus: (status: string, statusClass: StatusClass) => void;
  readonly setClientRouteMode: (routeMode: ClientState["routeMode"]) => void;
  readonly setClientManualRouteField: <K extends "manualRelayEndpointUri" | "manualRelayPublicKey" | "manualProfileMultihash">(
    field: K,
    value: ClientState[K]
  ) => void;
  readonly setClientTransportState: (patch: ClientTransportStatePatch) => void;
  readonly setClientIdentityLookupField: <K extends "adminBaseUrl" | "adminToken" | "branchID">(
    field: K,
    value: IdentityLookupState[K]
  ) => void;
  readonly setClientIdentityLookupRunning: (running: boolean) => void;
  readonly setClientIdentityLookupResult: (result: IdentityContactLookupResponse | null) => void;
  readonly setClientIdentityLookupStatus: (status: string, statusClass: StatusClass) => void;
  readonly appendClientTransportEvent: (event: string) => void;
  readonly resetClientTransport: () => void;
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
    gitLabTab: "generate",
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
      relayAdminBaseUrl: "/node-admin",
      relayAdminToken: "",
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
    gitlab: {
      mode: "demo",
      records: "",
      relayEndpointUri: defaultBootstrapRelayEndpointUri,
      relayAdminBaseUrl: "/node-admin",
      relayAdminToken: "",
      sourceCommit: "",
      files: [],
      selectedFile: 0,
      badgeSnippet: "",
      discoveryQuery: gitLabDiscoveryDefaultQuery,
      discoveryPerPage: "5",
      discoveryPage: "1",
      discoveryRunning: false,
      discoveryResults: [],
      status: "idle",
      statusClass: "status-warn",
      discoveryStatus: "idle",
      discoveryStatusClass: "status-warn"
    },
    relayMonitor: {
      adminBaseUrl: "/node-admin",
      adminToken: "",
      running: false,
      status: "idle",
      statusClass: "status-warn",
      observations: [],
      lastRefreshAt: null
    },
    client: {
      routeMode: "discovery",
      manualRelayEndpointUri: defaultBootstrapRelayEndpointUri,
      manualRelayPublicKey: "",
      manualProfileMultihash: developmentProfileMultihash,
      discoveryRunning: false,
      discoveryStatus: "idle",
      discoveryStatusClass: "status-warn",
      discoveryQuery: githubDiscoveryDefaultQuery,
      discoveryResults: [],
      rateLimitRemaining: null,
      incompleteResults: false,
      transportStatus: "idle",
      transportStatusClass: "status-warn",
      transportRunning: false,
      relayEndpointUri: "",
      relaySource: "",
      alicePeerId: "",
      bobPeerId: "",
      relayAckCount: 0,
      peerReceiptCount: 0,
      pendingCount: 0,
      unavailableCount: 0,
      transportEvents: [],
      federationTrace: {
        events: [],
        routeSnapshot: [],
        routeHints: [],
        activeRoute: null,
        migrationRoute: null,
        migrated: false
      },
      identityLookup: {
        adminBaseUrl: "/node-admin",
        adminToken: "",
        branchID: "",
        running: false,
        status: "idle",
        statusClass: "status-warn",
        result: null
      }
    },
    setActiveTab: (tab) => { set({ activeTab: tab }); },
    setRibbonTab: (tab) => { set({ ribbonTab: tab }); },
    setGitHubTab: (tab) => { set({ githubTab: tab }); },
    setGitLabTab: (tab) => { set({ gitLabTab: tab }); },
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
    setGitHubRelayAdminBaseUrl: (relayAdminBaseUrl) =>
      { set((state) => ({
        github: {
          ...state.github,
          relayAdminBaseUrl
        }
      })); },
    setGitHubRelayAdminToken: (relayAdminToken) =>
      { set((state) => ({
        github: {
          ...state.github,
          relayAdminToken
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
      })); },
    setGitLabRecords: (records) =>
      { set((state) => ({
        gitlab: {
          ...state.gitlab,
          records
        }
      })); },
    setGitLabRelayEndpointUri: (relayEndpointUri) =>
      { set((state) => ({
        gitlab: {
          ...state.gitlab,
          relayEndpointUri
        }
      })); },
    setGitLabRelayAdminBaseUrl: (relayAdminBaseUrl) =>
      { set((state) => ({
        gitlab: {
          ...state.gitlab,
          relayAdminBaseUrl
        }
      })); },
    setGitLabRelayAdminToken: (relayAdminToken) =>
      { set((state) => ({
        gitlab: {
          ...state.gitlab,
          relayAdminToken
        }
      })); },
    setGitLabMode: (mode) =>
      { set((state) => ({
        gitlab: {
          ...state.gitlab,
          mode
        }
      })); },
    setGitLabSourceCommit: (sourceCommit) =>
      { set((state) => ({
        gitlab: {
          ...state.gitlab,
          sourceCommit
        }
      })); },
    setGitLabFiles: (files) =>
      { set((state) => ({
        gitlab: {
          ...state.gitlab,
          files,
          selectedFile: 0
        }
      })); },
    setGitLabBadgeSnippet: (badgeSnippet) =>
      { set((state) => ({
        gitlab: {
          ...state.gitlab,
          badgeSnippet
        }
      })); },
    setSelectedGitLabFile: (index) =>
      { set((state) => ({
        gitlab: {
          ...state.gitlab,
          selectedFile: index
        }
      })); },
    setGitLabStatus: (status, statusClass) =>
      { set((state) => ({
        gitlab: {
          ...state.gitlab,
          status,
          statusClass
        }
      })); },
    setGitLabDiscoveryQuery: (discoveryQuery) =>
      { set((state) => ({
        gitlab: {
          ...state.gitlab,
          discoveryQuery
        }
      })); },
    setGitLabDiscoveryPerPage: (discoveryPerPage) =>
      { set((state) => ({
        gitlab: {
          ...state.gitlab,
          discoveryPerPage
        }
      })); },
    setGitLabDiscoveryPage: (discoveryPage) =>
      { set((state) => ({
        gitlab: {
          ...state.gitlab,
          discoveryPage
        }
      })); },
    setGitLabDiscoveryRunning: (discoveryRunning) =>
      { set((state) => ({
        gitlab: {
          ...state.gitlab,
          discoveryRunning
        }
      })); },
    setGitLabDiscoveryResults: (discoveryResults) =>
      { set((state) => ({
        gitlab: {
          ...state.gitlab,
          discoveryResults
        }
      })); },
    setGitLabDiscoveryStatus: (discoveryStatus, discoveryStatusClass) =>
      { set((state) => ({
        gitlab: {
          ...state.gitlab,
          discoveryStatus,
          discoveryStatusClass
        }
      })); },
    setRelayMonitorAdminBaseUrl: (adminBaseUrl) =>
      { set((state) => ({
        relayMonitor: {
          ...state.relayMonitor,
          adminBaseUrl
        }
      })); },
    setRelayMonitorAdminToken: (adminToken) =>
      { set((state) => ({
        relayMonitor: {
          ...state.relayMonitor,
          adminToken
        }
      })); },
    setRelayMonitorRunning: (running) =>
      { set((state) => ({
        relayMonitor: {
          ...state.relayMonitor,
          running
        }
      })); },
    setRelayMonitorObservations: (observations, lastRefreshAt) =>
      { set((state) => ({
        relayMonitor: {
          ...state.relayMonitor,
          observations,
          lastRefreshAt
        }
      })); },
    setRelayMonitorStatus: (status, statusClass) =>
      { set((state) => ({
        relayMonitor: {
          ...state.relayMonitor,
          status,
          statusClass
        }
      })); },
    setClientDiscoveryRunning: (discoveryRunning) =>
      { set((state) => ({
        client: {
          ...state.client,
          discoveryRunning
        }
      })); },
    setClientDiscoveryResults: (discoveryResults, rateLimitRemaining, incompleteResults) =>
      { set((state) => ({
        client: {
          ...state.client,
          discoveryResults,
          rateLimitRemaining,
          incompleteResults
        }
      })); },
    setClientDiscoveryStatus: (discoveryStatus, discoveryStatusClass) =>
      { set((state) => ({
        client: {
          ...state.client,
          discoveryStatus,
          discoveryStatusClass
        }
      })); },
    setClientRouteMode: (routeMode) =>
      { set((state) => ({
        client: {
          ...state.client,
          routeMode
        }
      })); },
    setClientManualRouteField: (field, value) =>
      { set((state) => ({
        client: {
          ...state.client,
          [field]: value
        }
      })); },
    setClientTransportState: (patch) =>
      { set((state) => ({
        client: {
          ...state.client,
          ...patch
        }
      })); },
    setClientIdentityLookupField: (field, value) =>
      { set((state) => ({
        client: {
          ...state.client,
          identityLookup: {
            ...state.client.identityLookup,
            [field]: value
          }
        }
      })); },
    setClientIdentityLookupRunning: (running) =>
      { set((state) => ({
        client: {
          ...state.client,
          identityLookup: {
            ...state.client.identityLookup,
            running
          }
        }
      })); },
    setClientIdentityLookupResult: (result) =>
      { set((state) => ({
        client: {
          ...state.client,
          identityLookup: {
            ...state.client.identityLookup,
            result
          }
        }
      })); },
    setClientIdentityLookupStatus: (status, statusClass) =>
      { set((state) => ({
        client: {
          ...state.client,
          identityLookup: {
            ...state.client.identityLookup,
            status,
            statusClass
          }
        }
      })); },
    appendClientTransportEvent: (event) =>
      { set((state) => ({
        client: {
          ...state.client,
          transportEvents: [event, ...state.client.transportEvents].slice(0, 12)
        }
      })); },
    resetClientTransport: () =>
      { set((state) => ({
        client: {
          ...state.client,
          transportStatus: "idle",
          transportStatusClass: "status-warn",
          transportRunning: false,
          relayEndpointUri: "",
          relaySource: "",
          alicePeerId: "",
          bobPeerId: "",
          relayAckCount: 0,
          peerReceiptCount: 0,
          pendingCount: 0,
          unavailableCount: 0,
          transportEvents: [],
          federationTrace: {
            events: [],
            routeSnapshot: [],
            routeHints: [],
            activeRoute: null,
            migrationRoute: null,
            migrated: false
          },
          identityLookup: state.client.identityLookup
        }
      })); }
  }));
}
