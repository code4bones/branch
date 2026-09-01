import { defaultBootstrapProfileMultihashes } from "../protocol/v0/bootstrap-beacon.js";
import { protocolID } from "../protocol/v0/envelope.js";

export interface RelayBootstrapBeaconResponse {
  readonly wrapper: string;
  readonly relay_public_key: string;
  readonly protocol: typeof protocolID;
  readonly profile_multihash: typeof defaultBootstrapProfileMultihashes[number];
  readonly expires_at: number;
  readonly relay_endpoints: readonly {
    readonly transport: "wss";
    readonly uri: string;
    readonly priority: number;
  }[];
}

export interface FetchRelayBootstrapBeaconOptions {
  readonly adminBaseUrl: string;
  readonly adminToken: string;
  readonly endpointUri: string;
  readonly fetcher?: typeof fetch;
}

export async function fetchRelayBootstrapBeacon(options: FetchRelayBootstrapBeaconOptions): Promise<RelayBootstrapBeaconResponse> {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const url = makeRelayBootstrapBeaconUrl(options.adminBaseUrl, options.endpointUri);
  const response = await fetcher(url, {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    headers: authorizationHeaders(options.adminToken)
  });
  if (!response.ok) {
    throw new Error(`relay bootstrap beacon failed (${String(response.status)})`);
  }
  const decoded: unknown = await response.json();
  if (!isRelayBootstrapBeaconResponse(decoded)) {
    throw new Error("relay bootstrap beacon response rejected");
  }
  return decoded;
}

export function makeRelayBootstrapBeaconUrl(adminBaseUrl: string, endpointUri: string): string {
  const base = adminBaseUrl.trim() || "/node-admin";
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const url = new URL(`${base.replace(/\/+$/, "")}/bootstrap/beacon`, origin);
  url.searchParams.set("endpoint", endpointUri.trim());
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

function isRelayBootstrapBeaconResponse(value: unknown): value is RelayBootstrapBeaconResponse {
  return isRecord(value) &&
    typeof value["wrapper"] === "string" &&
    value["wrapper"].startsWith("BRANCH0.") &&
    typeof value["relay_public_key"] === "string" &&
    value["protocol"] === protocolID &&
    defaultBootstrapProfileMultihashes.includes(value["profile_multihash"] as typeof defaultBootstrapProfileMultihashes[number]) &&
    typeof value["expires_at"] === "number" &&
    Number.isSafeInteger(value["expires_at"]) &&
    Array.isArray(value["relay_endpoints"]) &&
    value["relay_endpoints"].length > 0 &&
    value["relay_endpoints"].every(isRelayEndpoint);
}

function isRelayEndpoint(value: unknown): value is RelayBootstrapBeaconResponse["relay_endpoints"][number] {
  return isRecord(value) &&
    value["transport"] === "wss" &&
    typeof value["uri"] === "string" &&
    typeof value["priority"] === "number" &&
    Number.isSafeInteger(value["priority"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
