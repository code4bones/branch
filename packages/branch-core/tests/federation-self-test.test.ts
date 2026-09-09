import assert from "node:assert/strict";
import test from "node:test";

import { runFederationSelfTest } from "../src/connectivity/federation-self-test.js";
import { developmentProfileMultihash } from "../src/protocol/v0/profile.js";

const relayKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

test("federation self-test rejects one route before opening a socket", async () => {
  const report = await runFederationSelfTest({
    routes: [{
      endpointUri: "wss://relay01.example.test/relay/v0",
      relayPublicKey: relayKey,
      profileMultihash: developmentProfileMultihash
    }]
  });

  assert.deepEqual(report, {
    status: "failed",
    reason: "insufficient_distinct_routes",
    attempts: []
  });
});

test("federation self-test does not treat duplicate endpoints as distinct relays", async () => {
  const route = {
    endpointUri: "wss://relay01.example.test/relay/v0",
    relayPublicKey: relayKey,
    profileMultihash: developmentProfileMultihash
  };
  const report = await runFederationSelfTest({ routes: [route, { ...route }] });

  assert.equal(report.status, "failed");
  assert.equal(report.reason, "insufficient_distinct_routes");
  assert.deepEqual(report.attempts, []);
});
