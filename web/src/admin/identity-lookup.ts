import { parseBranchID } from "@code4bones/branch-core/protocol/v0/identity-contact.js";

export interface IdentityContactLookupResponse {
  readonly branch_id: string;
  readonly accepted: boolean;
  readonly observation?: IdentityContactLookupObservation;
  readonly trace: readonly IdentityContactLookupTrace[];
}

export interface IdentityContactLookupObservation {
  readonly branch_id: string;
  readonly sequence: number;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly last_observed_at: number;
  readonly source: string;
  readonly wrapper_preview: string;
  readonly wrapper_bytes: number;
  readonly protocol_versions: readonly string[];
  readonly profile_multihashes: readonly string[];
  readonly route_hints: readonly IdentityContactRouteHint[];
}

export interface IdentityContactRouteHint {
  readonly transport: "wss";
  readonly uri: string;
  readonly relay_public_key: string;
  readonly profile_multihash: string;
  readonly priority: number;
}

export interface IdentityContactLookupTrace {
  readonly source: string;
  readonly step: string;
  readonly accepted: boolean;
  readonly reason: string;
  readonly candidate?: number;
}

export interface FetchIdentityContactLookupOptions {
  readonly adminBaseUrl: string;
  readonly adminToken: string;
  readonly branchID: string;
  readonly fetcher?: typeof fetch;
}

const maxTraceItems = 32;
const maxRouteHints = 8;
const maxTextLength = 512;

export async function fetchIdentityContactLookup(options: FetchIdentityContactLookupOptions): Promise<IdentityContactLookupResponse> {
  parseBranchID(options.branchID.trim());
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const response = await fetcher(makeIdentityContactLookupUrl(options.adminBaseUrl, options.branchID), {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    headers: authorizationHeaders(options.adminToken)
  });
  if (!response.ok) {
    throw new Error(`identity lookup failed (${String(response.status)})`);
  }
  const decoded: unknown = await response.json();
  if (!isIdentityContactLookupResponse(decoded)) {
    throw new Error("identity lookup response rejected");
  }
  return decoded;
}

export function makeIdentityContactLookupUrl(adminBaseUrl: string, branchID: string): string {
  const base = adminBaseUrl.trim() || "/node-admin";
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const url = new URL(`${base.replace(/\/+$/, "")}/identity/lookup`, origin);
  url.searchParams.set("branch_id", branchID.trim());
  return base.startsWith("/") ? `${url.pathname}${url.search}` : url.toString();
}

function authorizationHeaders(adminToken: string): Headers {
  const headers = new Headers();
  const token = adminToken.trim();
  if (token !== "") {
    headers.set("authorization", `Bearer ${token}`);
  }
  return headers;
}

function isIdentityContactLookupResponse(value: unknown): value is IdentityContactLookupResponse {
  return isRecord(value) &&
    isBranchID(value["branch_id"]) &&
    typeof value["accepted"] === "boolean" &&
    (value["observation"] === undefined || isIdentityContactLookupObservation(value["observation"])) &&
    isIdentityContactLookupTraceArray(value["trace"]) &&
    (value["accepted"] ? value["observation"] !== undefined : true);
}

function isIdentityContactLookupObservation(value: unknown): value is IdentityContactLookupObservation {
  return isRecord(value) &&
    isBranchID(value["branch_id"]) &&
    isSafeCounter(value["sequence"]) &&
    isUnixSeconds(value["issued_at"]) &&
    isUnixSeconds(value["expires_at"]) &&
    isUnixSeconds(value["last_observed_at"]) &&
    isSafeText(value["source"], 0, maxTextLength) &&
    isSafeText(value["wrapper_preview"], 1, 96) &&
    value["wrapper_preview"].startsWith("BRANCH0.") &&
    isSafeCounter(value["wrapper_bytes"]) &&
    isSafeTextArray(value["protocol_versions"], 8, 96) &&
    isSafeTextArray(value["profile_multihashes"], 8, 128) &&
    isIdentityContactRouteHintArray(value["route_hints"]);
}

function isIdentityContactLookupTraceArray(value: unknown): value is readonly IdentityContactLookupTrace[] {
  return Array.isArray(value) &&
    value.length <= maxTraceItems &&
    value.every(isIdentityContactLookupTrace);
}

function isIdentityContactLookupTrace(value: unknown): value is IdentityContactLookupTrace {
  return isRecord(value) &&
    isSafeText(value["source"], 1, 96) &&
    isSafeText(value["step"], 1, 64) &&
    typeof value["accepted"] === "boolean" &&
    isSafeText(value["reason"], 1, 96) &&
    (value["candidate"] === undefined || isSafeCounter(value["candidate"]));
}

function isIdentityContactRouteHintArray(value: unknown): value is readonly IdentityContactRouteHint[] {
  return Array.isArray(value) &&
    value.length <= maxRouteHints &&
    value.every(isIdentityContactRouteHint);
}

function isIdentityContactRouteHint(value: unknown): value is IdentityContactRouteHint {
  return isRecord(value) &&
    value["transport"] === "wss" &&
    isSafeText(value["uri"], 1, maxTextLength) &&
    isSafeText(value["relay_public_key"], 1, 96) &&
    isSafeText(value["profile_multihash"], 1, 128) &&
    isSafeCounter(value["priority"]);
}

function isBranchID(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    parseBranchID(value);
    return true;
  } catch {
    return false;
  }
}

function isSafeTextArray(value: unknown, maxItems: number, maxLength: number): value is readonly string[] {
  return Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => isSafeText(item, 1, maxLength));
}

function isSafeText(value: unknown, minLength: number, maxLength: number): value is string {
  return typeof value === "string" && value.length >= minLength && value.length <= maxLength && value.trim() === value;
}

function isUnixSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
