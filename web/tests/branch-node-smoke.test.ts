import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { runCarrierHoppingPoC } from "../src/connectivity/carrier-hopping-poc.js";
import type { BrowserRelaySocket, BrowserRelaySocketFactory, RelayRouteMaterial } from "../src/connectivity/same-relay.js";
import { developmentProfileMultihash } from "../src/protocol/v0/profile.js";

const repoRoot = resolve(process.cwd(), "..");
const adminToken = "branch-smoke-token";
const startupTimeoutMs = 20_000;

void test("carrier-hopping PoC runner works against two local branch-node relay adapters", async (t) => {
  const relayA = await startBranchNode("a");
  const relayB = await startBranchNode("b");
  t.after(async () => {
    await Promise.all([relayA.stop(), relayB.stop()]);
  });

  const routeA = makeRoute("local relay A", "wss://relay-a.local/relay/v0", relayA.publicKey);
  const routeB = makeRoute("local relay B", "wss://relay-b.local/relay/v0", relayB.publicKey);
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

function makeRoute(source: string, endpointUri: string, relayPublicKey: string): RelayRouteMaterial {
  return {
    endpointUri,
    relayPublicKey,
    profileMultihash: developmentProfileMultihash,
    source
  };
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
