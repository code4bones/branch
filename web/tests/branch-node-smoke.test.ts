import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { runCarrierHoppingPoC } from "@code4bones/branch-core/connectivity/carrier-hopping-poc.js";
import { runDiscoveredCarrierHopPoC } from "@code4bones/branch-core/discovery/carrier-hop-client.js";
import { createGitLabSearchCarrier, gitLabDiscoveryDefaultQuery } from "@code4bones/branch-core/discovery/gitlab.js";
import type { BrowserRelaySocket, BrowserRelaySocketFactory, RelayRouteMaterial } from "@code4bones/branch-core/connectivity/same-relay.js";
import type { BeaconObservation, SearchCarrier } from "@code4bones/branch-core/discovery/client.js";
import { developmentProfileMultihash } from "@code4bones/branch-core/protocol/v0/profile.js";

const repoRoot = resolve(process.cwd(), "..");
const adminToken = "branch-smoke-token";
const startupTimeoutMs = 20_000;

void test("carrier-hopping PoC runner works against two local branch-node relay adapters", async (t) => {
  const relayA = await startBranchNode("a");
  const relayB = await startBranchNode("b");
  t.after(async () => {
    await Promise.all([relayA.stop(), relayB.stop()]);
  });

  const routeA = makeRoute("wss://relay-a.local:443/relay/v0", relayA.publicKey);
  const routeB = makeRoute("wss://relay-b.local:443/relay/v0", relayB.publicKey);
  const socketFactory = mappedSocketFactory(new Map([
    [routeA.endpointUri, `ws://${relayA.publicAddr}/relay/v0`],
    [routeB.endpointUri, `ws://${relayB.publicAddr}/relay/v0`]
  ]));

  const report = await runCarrierHoppingPoC({
    routes: [routeA, routeB],
    socketFactory,
    stepTimeoutMs: 5_000
  });

  assert.equal(report.status, "ok", JSON.stringify(report, null, 2));
  assert.equal(report.migrated, true);
  assert.equal(report.pendingCount, 0);
  assert.equal(report.unavailableCount, 1);
  assert(report.events.some((event) => event.includes("carrier.disabled delivery continued")));
  assert(report.events.some((event) => event.includes("route.migration.completed")));

  await Promise.all([waitForEmptyRelay(relayA), waitForEmptyRelay(relayB)]);
});

void test("discovered carrier-hop runner works against two local branch-node relay adapters", async (t) => {
  const relayA = await startBranchNode("discovered-a");
  const relayB = await startBranchNode("discovered-b");
  t.after(async () => {
    await Promise.all([relayA.stop(), relayB.stop()]);
  });

  const routeA = makeRoute("wss://relay-a.local:443/relay/v0", relayA.publicKey);
  const routeB = makeRoute("wss://relay-b.local:443/relay/v0", relayB.publicKey);
  let searchCount = 0;
  const carrier: SearchCarrier = {
    id: "local-fixture",
    search: (request) => {
      searchCount += 1;
      return Promise.resolve({
        carrier: "local-fixture",
        status: "ok",
        query: request.query,
        message: "local accepted branch-node routes",
        observations: [
          acceptedObservation("local-fixture:a", "gitlab/alice/local-a", routeA),
          acceptedObservation("local-fixture:b", "gitlab/bob/local-b", routeB)
        ],
        evidenceCount: 2,
        raw: null
      });
    }
  };

  const report = await runDiscoveredCarrierHopPoC({
    carrier,
    primaryQuery: "branchbootstrapv0",
    includeFallback: false,
    socketFactory: mappedSocketFactory(new Map([
      [routeA.endpointUri, `ws://${relayA.publicAddr}/relay/v0`],
      [routeB.endpointUri, `ws://${relayB.publicAddr}/relay/v0`]
    ])),
    stepTimeoutMs: 5_000
  });

  assert.equal(searchCount, 1);
  assert.equal(report.discovery.acceptedCount, 2);
  assert.equal(report.routeSnapshot.length, 2);
  const firstGenericRoute = report.routeSnapshot[0];
  const secondGenericRoute = report.routeSnapshot[1];
  assert(firstGenericRoute !== undefined);
  assert(secondGenericRoute !== undefined);
  assert(!("source" in firstGenericRoute));
  assert(!("source" in secondGenericRoute));
  assert.equal(report.transport.status, "ok", JSON.stringify(report, null, 2));
  assert.equal(report.transport.migrated, true);
  assert.equal(report.transport.pendingCount, 0);
  assert.equal(report.transport.unavailableCount, 1);
  assert(report.transport.events.some((event) => event.includes("carrier.disabled delivery continued")));
  assert(report.transport.events.some((event) => event.includes("route.migration.completed")));

  await Promise.all([waitForEmptyRelay(relayA), waitForEmptyRelay(relayB)]);
});

void test("GitLab-discovered carrier-hop runner uses relay-owned branch-node beacons", async (t) => {
  const relayA = await startBranchNode("gitlab-a");
  const relayB = await startBranchNode("gitlab-b");
  t.after(async () => {
    await Promise.all([relayA.stop(), relayB.stop()]);
  });

  const routeA = makeRoute("wss://relay-a.local:443/relay/v0", relayA.publicKey);
  const routeB = makeRoute("wss://relay-b.local:443/relay/v0", relayB.publicKey);
  const [wrapperA, wrapperB] = await Promise.all([
    fetchRelayOwnedWrapper(relayA, routeA.endpointUri),
    fetchRelayOwnedWrapper(relayB, routeB.endpointUri)
  ]);
  const fetcher = makeGitLabFixtureFetcher(new Map([
    ["alice/carrier-a", wrapperA],
    ["bob/carrier-b", wrapperB],
    ["mallory/poison", corruptWrapper(wrapperA)]
  ]));

  const report = await runDiscoveredCarrierHopPoC({
    carrier: createGitLabSearchCarrier(fetcher),
    primaryQuery: gitLabDiscoveryDefaultQuery,
    fallbackQuery: null,
    includeFallback: false,
    includeForks: false,
    socketFactory: mappedSocketFactory(new Map([
      [routeA.endpointUri, `ws://${relayA.publicAddr}/relay/v0`],
      [routeB.endpointUri, `ws://${relayB.publicAddr}/relay/v0`]
    ])),
    stepTimeoutMs: 5_000
  });

  assert.equal(report.discovery.acceptedCount, 2);
  assert.equal(report.discovery.rejectedCount, 1);
  assert.equal(report.routeSnapshot.length, 2);
  assert.deepEqual(report.routeSnapshot.map((route) => route.relayPublicKey), [relayA.publicKey, relayB.publicKey]);
  const firstGitLabRoute = report.routeSnapshot[0];
  assert(firstGitLabRoute !== undefined);
  assert(!("source" in firstGitLabRoute));
  assert.equal(report.transport.status, "ok", JSON.stringify(report, null, 2));
  assert.equal(report.transport.migrated, true);
  assert.equal(report.transport.pendingCount, 0);
  assert.equal(report.transport.unavailableCount, 1);
  assert(report.transport.events.some((event) => event.includes("carrier.disabled delivery continued")));
  assert(report.transport.events.some((event) => event.includes("route.migration.completed")));

  await Promise.all([waitForEmptyRelay(relayA), waitForEmptyRelay(relayB)]);
});

interface StartedBranchNode {
  readonly publicAddr: string;
  readonly adminURL: string;
  readonly identityPath: string;
  readonly publicKey: string;
  readonly stop: () => Promise<void>;
  readonly output: () => string;
}

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

async function startBranchNode(label: string): Promise<StartedBranchNode> {
  const directory = await mkdtemp(join(tmpdir(), `branch-node-${label}-`));
  const publicAddr = `127.0.0.1:${String(await reservePort())}`;
  const adminAddr = `127.0.0.1:${String(await reservePort())}`;
  const identityPath = join(directory, "node-identity.json");
  const child = spawn("go", [
    "run",
    "./cmd/branch-node",
    "-listen",
    publicAddr,
    "-admin-listen",
    adminAddr,
    "-identity",
    identityPath,
    "-admin-token",
    adminToken
  ], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let exit: ProcessExit | null = null;
  child.stdout.on("data", (chunk: Buffer) => {
    output = boundedAppend(output, chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output = boundedAppend(output, chunk.toString("utf8"));
  });
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });

  const adminURL = `http://${adminAddr}`;
  try {
    await waitFor(async () => {
      if (exit !== null) {
        throw new Error(`branch-node ${label} exited: ${formatExit(exit)}\n${output}`);
      }
      const response = await fetch(`${adminURL}/readyz`, {
        headers: { authorization: `Bearer ${adminToken}` }
      });
      return response.ok;
    }, startupTimeoutMs);
    return {
      publicAddr,
      adminURL,
      identityPath,
      publicKey: await readIdentityPublicKey(identityPath),
      stop: async () => {
        await stopProcess(child);
        await rm(directory, { recursive: true, force: true });
      },
      output: () => output
    };
  } catch (error) {
    await stopProcess(child);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function makeRoute(endpointUri: string, relayPublicKey: string): RelayRouteMaterial {
  return {
    endpointUri,
    relayPublicKey,
    profileMultihash: developmentProfileMultihash
  };
}

async function fetchRelayOwnedWrapper(node: StartedBranchNode, endpointUri: string): Promise<string> {
  const url = new URL(`${node.adminURL}/bootstrap/beacon`);
  url.searchParams.set("endpoint", endpointUri);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${adminToken}` }
  });
  if (!response.ok) {
    throw new Error(`bootstrap beacon failed ${String(response.status)}\n${node.output()}`);
  }
  const decoded: unknown = await response.json();
  if (!isRelayBootstrapResponse(decoded)) {
    throw new Error("bootstrap beacon response rejected");
  }
  assert.equal(decoded.relay_public_key, node.publicKey);
  assert.equal(decoded.relay_endpoints[0]?.uri, endpointUri);
  return decoded.wrapper;
}

function makeGitLabFixtureFetcher(records: ReadonlyMap<string, string>): (input: string, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    if (init?.credentials !== undefined) {
      assert.equal(init.credentials, "omit");
    }
    const url = new URL(input);
    if (url.origin === "https://gitlab.com" && url.pathname === "/api/v4/projects") {
      return Promise.resolve(jsonResponse([...records.keys()].map((repository, index) => ({
        id: index + 1,
        path_with_namespace: repository,
        name_with_namespace: repository.replace("/", " / "),
        web_url: `https://gitlab.com/${repository}`,
        default_branch: "main"
      }))));
    }
    const repository = decodeGitLabRepositoryPath(url.pathname);
    const wrapper = records.get(repository);
    if (wrapper === undefined) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return Promise.resolve(new Response(`${wrapper}\n`, {
      status: 200,
      headers: { "content-type": "text/plain" }
    }));
  };
}

function decodeGitLabRepositoryPath(pathname: string): string {
  const match = pathname.match(/^\/api\/v4\/projects\/([^/]+)\/repository\/files\//);
  if (match === null || match[1] === undefined) {
    throw new Error(`unexpected GitLab fixture URL ${pathname}`);
  }
  return decodeURIComponent(match[1]);
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function corruptWrapper(wrapper: string): string {
  const replacement = wrapper.endsWith("A") ? "B" : "A";
  return `${wrapper.slice(0, -1)}${replacement}`;
}

interface RelayBootstrapResponse {
  readonly wrapper: string;
  readonly relay_public_key: string;
  readonly relay_endpoints: readonly { readonly uri: string }[];
}

function isRelayBootstrapResponse(value: unknown): value is RelayBootstrapResponse {
  return isRecord(value) &&
    typeof value["wrapper"] === "string" &&
    value["wrapper"].startsWith("BRANCH0.") &&
    typeof value["relay_public_key"] === "string" &&
    Array.isArray(value["relay_endpoints"]);
}

function mappedSocketFactory(urls: ReadonlyMap<string, string>): BrowserRelaySocketFactory {
  return (url) => {
    const mapped = urls.get(url);
    if (mapped === undefined) {
      throw new Error(`missing local relay mapping for ${url}`);
    }
    return new WebSocket(mapped) as BrowserRelaySocket;
  };
}

function acceptedObservation(observationId: string, source: string, route: RelayRouteMaterial): BeaconObservation {
  return {
    observationId,
    validation: "accepted",
    reason: "accepted",
    wrapperPreview: "BRANCH0.preview",
    evidence: {
      carrier: "local-fixture",
      query: "branchbootstrapv0",
      source,
      sourceUrl: `https://example.test/${source}`,
      recordUrl: `https://example.test/${source}/.branch/records.br0`
    },
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    relayEndpoint: `wss ${route.endpointUri}`,
    profileMultihash: route.profileMultihash,
    senderPublicKey: route.relayPublicKey,
    beaconId: route.relayPublicKey,
    sequence: 1
  };
}

async function waitForEmptyRelay(node: StartedBranchNode): Promise<void> {
  await waitFor(async () => {
    const snapshot = await readAdminSnapshot(node);
    return snapshot.sessions_active === 0 &&
      snapshot.routes_active === 0 &&
      snapshot.presence_active === 0 &&
      snapshot.queue_depth === 0;
  }, 5_000);
}

async function readAdminSnapshot(node: StartedBranchNode): Promise<AdminSnapshot> {
  const response = await fetch(`${node.adminURL}/readyz`, {
    headers: { authorization: `Bearer ${adminToken}` }
  });
  if (!response.ok) {
    throw new Error(`admin snapshot failed ${String(response.status)}\n${node.output()}`);
  }
  const decoded: unknown = await response.json();
  if (!isAdminSnapshot(decoded)) {
    throw new Error("admin snapshot rejected");
  }
  return decoded;
}

interface AdminSnapshot {
  readonly sessions_active: number;
  readonly routes_active: number;
  readonly presence_active: number;
  readonly queue_depth: number;
}

function isAdminSnapshot(value: unknown): value is AdminSnapshot {
  return isRecord(value) &&
    typeof value["sessions_active"] === "number" &&
    typeof value["routes_active"] === "number" &&
    typeof value["presence_active"] === "number" &&
    typeof value["queue_depth"] === "number";
}

async function readIdentityPublicKey(path: string): Promise<string> {
  const decoded: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(decoded) || typeof decoded["public_key"] !== "string") {
    throw new Error("node identity public key missing");
  }
  return decoded["public_key"];
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveOpen, rejectOpen) => {
    server.once("error", rejectOpen);
    server.listen(0, "127.0.0.1", resolveOpen);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("reserved port missing");
  }
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
  });
  return port;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) {
    return;
  }
  const stopped = new Promise<void>((resolveStopped) => {
    child.once("exit", () => {
      resolveStopped();
    });
  });
  killProcessGroup(child.pid, "SIGTERM");
  await Promise.race([
    stopped,
    sleep(5_000).then(() => {
      if (child.pid !== undefined) {
        killProcessGroup(child.pid, "SIGKILL");
      }
    })
  ]);
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ESRCH") {
      throw error;
    }
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let lastError: Error | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await check()) {
        return;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("wait check failed");
    }
    await sleep(100);
  }
  throw lastError ?? new Error("condition timed out");
}

function formatExit(exit: ProcessExit): string {
  return `code=${String(exit.code)} signal=${String(exit.signal)}`;
}

function boundedAppend(current: string, next: string): string {
  return `${current}${next}`.slice(-8_192);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
