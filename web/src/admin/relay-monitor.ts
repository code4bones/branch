export type RelayReadiness = "ready" | "degraded" | "not_ready";

export interface RelayMonitorSnapshot {
  readonly service_name: string;
  readonly service_version: string;
  readonly readiness: RelayReadiness;
  readonly protocol_versions: readonly string[];
  readonly capabilities: readonly string[];
  readonly sessions_active: number;
  readonly routes_active: number;
  readonly presence_active: number;
  readonly queue_depth: number;
  readonly exporter_available: boolean;
}

export interface RelayMonitorObservation {
  readonly relay_id: string;
  readonly public_endpoint: string;
  readonly reported_at: string;
  readonly last_seen_at: string;
  readonly expires_at: string;
  readonly stale: boolean;
  readonly snapshot: RelayMonitorSnapshot;
  readonly bootstrap_beacon?: RelayMonitorBootstrapBeacon;
  readonly federation?: readonly RelayMonitorFederationLink[];
  readonly federation_carrier?: RelayMonitorFederationCarrier;
}

export interface RelayMonitorBootstrapBeacon {
  readonly wrapper: string;
  readonly expires_at: number;
}

export interface RelayMonitorFederationLink {
  readonly peer_relay_id?: string;
  readonly peer_endpoint: string;
  readonly state: "configured" | "reachable" | "unreachable";
  readonly last_lookup_at?: string;
  readonly last_reason?: string;
  readonly lookup_count: number;
  readonly bridge_count: number;
  readonly fresh_until?: string;
}

export interface RelayMonitorFederationCarrier {
  readonly carrier: string;
  readonly state: "ready" | "unavailable";
  readonly last_lookup_at: string;
  readonly last_reason?: string;
  readonly candidate_count: number;
  readonly fresh_until: string;
}

export interface FetchRelayMonitorOptions {
  readonly adminBaseUrl: string;
  readonly adminToken: string;
  readonly fetcher?: typeof fetch;
}

const maxRelayObservations = 64;
const maxTextLength = 512;

export async function fetchRelayMonitorObservations(options: FetchRelayMonitorOptions): Promise<readonly RelayMonitorObservation[]> {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const response = await fetcher(makeRelayMonitorUrl(options.adminBaseUrl), {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    headers: authorizationHeaders(options.adminToken)
  });
  if (!response.ok) {
    throw new Error(`relay monitor failed (${String(response.status)})`);
  }
  const decoded: unknown = await response.json();
  if (!isRelayMonitorObservationArray(decoded)) {
    throw new Error("relay monitor response rejected");
  }
  return decoded;
}

export function makeRelayMonitorUrl(adminBaseUrl: string): string {
  const base = adminBaseUrl.trim() || "/node-admin";
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const url = new URL(`${base.replace(/\/+$/, "")}/relay-monitor/reports`, origin);
  return base.startsWith("/") ? url.pathname : url.toString();
}

function authorizationHeaders(adminToken: string): Headers {
  const headers = new Headers();
  const token = adminToken.trim();
  if (token !== "") {
    headers.set("authorization", `Bearer ${token}`);
  }
  return headers;
}

function isRelayMonitorObservationArray(value: unknown): value is readonly RelayMonitorObservation[] {
  return Array.isArray(value) &&
    value.length <= maxRelayObservations &&
    value.every(isRelayMonitorObservation);
}

function isRelayMonitorObservation(value: unknown): value is RelayMonitorObservation {
  return isRecord(value) &&
    isSafeText(value["relay_id"], 1, 64) &&
    isSafeText(value["public_endpoint"], 1, maxTextLength) &&
    isISOTime(value["reported_at"]) &&
    isISOTime(value["last_seen_at"]) &&
    isISOTime(value["expires_at"]) &&
    typeof value["stale"] === "boolean" &&
    isRelayMonitorSnapshot(value["snapshot"]) &&
    (value["bootstrap_beacon"] === undefined || isRelayMonitorBootstrapBeacon(value["bootstrap_beacon"])) &&
    (value["federation"] === undefined || isRelayMonitorFederationArray(value["federation"])) &&
    (value["federation_carrier"] === undefined || isRelayMonitorFederationCarrier(value["federation_carrier"]));
}

function isRelayMonitorBootstrapBeacon(value: unknown): value is RelayMonitorBootstrapBeacon {
  return isRecord(value) &&
    isSafeText(value["wrapper"], 9, 8192) &&
    value["wrapper"].startsWith("BRANCH0.") &&
    typeof value["expires_at"] === "number" &&
    Number.isSafeInteger(value["expires_at"]) &&
    value["expires_at"] > 0;
}

function isRelayMonitorFederationArray(value: unknown): value is readonly RelayMonitorFederationLink[] {
  return Array.isArray(value) &&
    value.length <= 16 &&
    value.every(isRelayMonitorFederationLink);
}

function isRelayMonitorFederationLink(value: unknown): value is RelayMonitorFederationLink {
  return isRecord(value) &&
    (value["peer_relay_id"] === undefined || isSafeText(value["peer_relay_id"], 1, 64)) &&
    isSafeText(value["peer_endpoint"], 1, maxTextLength) &&
    isFederationState(value["state"]) &&
    (value["last_lookup_at"] === undefined || isISOTime(value["last_lookup_at"])) &&
    (value["last_reason"] === undefined || isSafeText(value["last_reason"], 1, 96)) &&
    isSafeCounter(value["lookup_count"]) &&
    isSafeCounter(value["bridge_count"]) &&
    (value["fresh_until"] === undefined || isISOTime(value["fresh_until"]));
}

function isRelayMonitorFederationCarrier(value: unknown): value is RelayMonitorFederationCarrier {
  return isRecord(value) &&
    isSafeText(value["carrier"], 1, 96) &&
    (value["state"] === "ready" || value["state"] === "unavailable") &&
    isISOTime(value["last_lookup_at"]) &&
    (value["last_reason"] === undefined || isSafeText(value["last_reason"], 1, 96)) &&
    isSafeCounter(value["candidate_count"]) &&
    value["candidate_count"] <= 16 &&
    isISOTime(value["fresh_until"]);
}

function isFederationState(value: unknown): value is RelayMonitorFederationLink["state"] {
  return value === "configured" || value === "reachable" || value === "unreachable";
}

function isRelayMonitorSnapshot(value: unknown): value is RelayMonitorSnapshot {
  return isRecord(value) &&
    isSafeText(value["service_name"], 1, 96) &&
    isSafeText(value["service_version"], 1, 96) &&
    isReadiness(value["readiness"]) &&
    isSafeTextArray(value["protocol_versions"], 16, 96) &&
    isSafeTextArray(value["capabilities"], 16, 96) &&
    isSafeCounter(value["sessions_active"]) &&
    isSafeCounter(value["routes_active"]) &&
    isSafeCounter(value["presence_active"]) &&
    isSafeCounter(value["queue_depth"]) &&
    typeof value["exporter_available"] === "boolean";
}

function isReadiness(value: unknown): value is RelayReadiness {
  return value === "ready" || value === "degraded" || value === "not_ready";
}

function isSafeTextArray(value: unknown, maxItems: number, maxLength: number): value is readonly string[] {
  return Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => isSafeText(item, 1, maxLength));
}

function isSafeText(value: unknown, minLength: number, maxLength: number): value is string {
  return typeof value === "string" && value.length >= minLength && value.length <= maxLength && value.trim() === value;
}

function isISOTime(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function isSafeCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
