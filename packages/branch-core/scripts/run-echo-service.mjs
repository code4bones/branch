import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EchoTestService,
  defaultBetaEchoContact,
  importBetaEchoServiceKeys
} from "../dist/connectivity/echo-service.js";
import { developmentProfileMultihash } from "../dist/protocol/v0/profile.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultKeysPath = resolve(scriptDir, "../../../.runtime/branch-echo.local.json");
const keysPath = process.env.BRANCH_ECHO_KEYS ?? defaultKeysPath;
const endpointUri = requiredEnv("BRANCH_ECHO_RELAY_ENDPOINT_URI");
const relayPublicKey = requiredEnv("BRANCH_ECHO_RELAY_PUBLIC_KEY");
const profileMultihash = process.env.BRANCH_ECHO_PROFILE_MULTIHASH ?? developmentProfileMultihash;
const heartbeatIntervalMs = Number(process.env.BRANCH_ECHO_HEARTBEAT_INTERVAL_MS ?? "10000");

const keys = await importBetaEchoServiceKeys(JSON.parse(await readFile(keysPath, "utf8")));
const service = new EchoTestService({
  route: {
    endpointUri,
    relayPublicKey,
    profileMultihash
  },
  keys,
  heartbeatIntervalMs,
  onEvent: (event) => {
    console.log(JSON.stringify({ ...event, service: defaultBetaEchoContact.id, at: new Date().toISOString() }));
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

await service.start();
await new Promise(() => {});

function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}
