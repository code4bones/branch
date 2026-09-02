import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MultiRouteEchoTestService,
  defaultBetaEchoContact,
  echoRoutesFromBootstrapBeaconWrappers,
  importBetaEchoServiceKeys
} from "../dist/connectivity/echo-service.js";
import { developmentProfileMultihash } from "../dist/protocol/v0/profile.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultKeysPath = resolve(scriptDir, "../../../.runtime/branch-echo.local.json");
const keysPath = process.env.BRANCH_ECHO_KEYS ?? defaultKeysPath;
const heartbeatIntervalMs = Number(process.env.BRANCH_ECHO_HEARTBEAT_INTERVAL_MS ?? "10000");

const keys = await importBetaEchoServiceKeys(JSON.parse(await readFile(keysPath, "utf8")));
const routes = await loadRoutes();
const service = new MultiRouteEchoTestService({
  routes,
  keys,
  heartbeatIntervalMs,
  onEvent: (event) => {
    console.log(JSON.stringify(redactedEvent(event)));
  }
});

process.once("SIGINT", () => {
  service.stop();
  process.exit(0);
});
process.once("SIGTERM", () => {
  service.stop();
  process.exit(0);
});

const report = await service.start();
console.log(JSON.stringify({
  service: defaultBetaEchoContact.id,
  event: "echo.multi_route.started",
  at: new Date().toISOString(),
  started_routes: report.startedRoutes.length,
  failed_routes: report.failedRoutes.length
}));
if (report.startedRoutes.length === 0) {
  throw new Error("echo service has no active routes");
}
await new Promise(() => {});

async function loadRoutes() {
  const explicitRoutes = parseExplicitRoutes(process.env.BRANCH_ECHO_RELAY_ROUTES_JSON);
  const wrappers = [
    ...await wrappersFromMonitor(),
    ...await wrappersFromFile(process.env.BRANCH_ECHO_BOOTSTRAP_WRAPPERS_FILE),
    ...wrappersFromText(process.env.BRANCH_ECHO_BOOTSTRAP_WRAPPERS)
  ];
  const discovered = await echoRoutesFromBootstrapBeaconWrappers(wrappers);
  if (discovered.rejected.length > 0) {
    console.log(JSON.stringify({
      service: defaultBetaEchoContact.id,
      event: "echo.routes.rejected",
      at: new Date().toISOString(),
      count: discovered.rejected.length,
      reasons: countReasons(discovered.rejected.map((item) => item.reason))
    }));
  }
  const routes = [...explicitRoutes, ...discovered.routes];
  if (routes.length > 0) {
    return routes;
  }
  return [singleRouteFromEnv()];
}

async function wrappersFromMonitor() {
  const url = optionalEnv("BRANCH_ECHO_RELAY_MONITOR_URL");
  if (url === null) {
    return [];
  }
  const headers = {};
  const token = optionalEnv("BRANCH_ECHO_RELAY_MONITOR_TOKEN");
  if (token !== null) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, { headers, cache: "no-store" });
  if (!response.ok) {
    throw new Error(`echo relay monitor failed (${String(response.status)})`);
  }
  const decoded = await response.json();
  if (!Array.isArray(decoded)) {
    throw new Error("echo relay monitor response rejected");
  }
  return decoded.flatMap((item) => {
    if (!isRecord(item) || !isRecord(item.bootstrap_beacon) || typeof item.bootstrap_beacon.wrapper !== "string") {
      return [];
    }
    return [{
      wrapper: item.bootstrap_beacon.wrapper,
      source: typeof item.relay_id === "string" ? item.relay_id : "relay-monitor"
    }];
  });
}

async function wrappersFromFile(path) {
  if (path === undefined || path.trim() === "") {
    return [];
  }
  return wrappersFromText(await readFile(path, "utf8"));
}

function wrappersFromText(value) {
  if (value === undefined || value.trim() === "") {
    return [];
  }
  return value.split(/\s+/u).filter((part) => part.startsWith("BRANCH0."));
}

function parseExplicitRoutes(value) {
  if (value === undefined || value.trim() === "") {
    return [];
  }
  const decoded = JSON.parse(value);
  if (!Array.isArray(decoded)) {
    throw new Error("BRANCH_ECHO_RELAY_ROUTES_JSON must be an array");
  }
  return decoded.map((item) => {
    if (!isRecord(item) || typeof item.endpointUri !== "string" || typeof item.relayPublicKey !== "string") {
      throw new Error("BRANCH_ECHO_RELAY_ROUTES_JSON route rejected");
    }
    return {
      endpointUri: item.endpointUri,
      relayPublicKey: item.relayPublicKey,
      profileMultihash: typeof item.profileMultihash === "string" ? item.profileMultihash : developmentProfileMultihash
    };
  });
}

function singleRouteFromEnv() {
  return {
    endpointUri: requiredEnv("BRANCH_ECHO_RELAY_ENDPOINT_URI"),
    relayPublicKey: requiredEnv("BRANCH_ECHO_RELAY_PUBLIC_KEY"),
    profileMultihash: process.env.BRANCH_ECHO_PROFILE_MULTIHASH ?? developmentProfileMultihash
  };
}

function redactedEvent(event) {
  const base = {
    service: defaultBetaEchoContact.id,
    at: new Date().toISOString(),
    event: event.type,
    endpoint_uri: event.endpointUri
  };
  if (event.type === "route_failed") {
    return { ...base, message: event.message };
  }
  if (event.type === "route_started") {
    return { ...base, peer_id: event.peerId };
  }
  return { ...base, child_event: event.event.type };
}

function countReasons(reasons) {
  const counts = {};
  for (const reason of reasons) {
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

function requiredEnv(name) {
  const value = optionalEnv(name);
  if (value === null) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return null;
  }
  return value.trim();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
