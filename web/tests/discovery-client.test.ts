import { test } from "node:test";
import assert from "node:assert/strict";

import {
  discoverClientBootstrapBeacons,
  type BeaconObservation,
  type SearchCarrier,
  type SearchCarrierSearchRequest
} from "../src/discovery/client.js";
import {
  createGitHubSearchCarrier,
  gitHubReportsFromCarrierReports,
  githubDiscoveryDefaultQuery,
  githubDiscoveryFallbackQuery,
  mergeGitHubDiscoveryReports
} from "../src/discovery/github.js";
import { createBootstrapBeaconWrapper } from "../src/protocol/v0/bootstrap-beacon.js";

void test("client discovery runs GitHub canonical locator then legacy fallback", async () => {
  const now = Math.floor(Date.now() / 1000);
  const wrapper = await createBootstrapBeaconWrapper({ now, expiresAt: now + 3600 });
  const queries: string[] = [];
  const fetcher = (input: string): Promise<Response> => {
    if (input.startsWith("https://api.github.com/search/repositories")) {
      const query = new URL(input).searchParams.get("q") ?? "";
      queries.push(query);
      return Promise.resolve(jsonResponse({
        total_count: query.startsWith("branchbootstrapv0") ? 0 : 1,
        incomplete_results: false,
        items: query.startsWith("branchbootstrapv0") ? [] : [repositoryItem("alice/carrier")]
      }));
    }
    return Promise.resolve(recordsResponse(wrapper));
  };

  const discovery = await discoverClientBootstrapBeacons({
    carrier: createGitHubSearchCarrier(fetcher),
    primaryQuery: githubDiscoveryDefaultQuery,
    fallbackQuery: githubDiscoveryFallbackQuery,
    includeFallback: true,
    perPage: 5,
    page: 1
  });
  const report = mergeGitHubDiscoveryReports(gitHubReportsFromCarrierReports(discovery.carrierReports));

  assert.deepEqual(queries, [
    "branchbootstrapv0 in:readme",
    "BRANCH0 branch/connectivity/0 branch-bootstrap-v0 in:readme"
  ]);
  assert.equal(discovery.status, "ok");
  assert.equal(discovery.acceptedCount, 1);
  assert.equal(discovery.rejectedCount, 0);
  assert.equal(discovery.observations[0]?.evidence.carrier, "github");
  assert.equal(report.results[0]?.repository, "alice/carrier");
});

void test("client discovery keeps poisoned GitHub wrappers as rejected observations", async () => {
  const stale = await createBootstrapBeaconWrapper({ now: 1_700_000_000, expiresAt: 1_700_000_001 });
  const fetcher = (input: string): Promise<Response> => {
    if (input.startsWith("https://api.github.com/search/repositories")) {
      return Promise.resolve(jsonResponse({
        total_count: 1,
        incomplete_results: false,
        items: [repositoryItem("alice/poisoned")]
      }));
    }
    return Promise.resolve(recordsResponse(`${stale}\nBRANCH0.not-valid=\n`));
  };

  const discovery = await discoverClientBootstrapBeacons({
    carrier: createGitHubSearchCarrier(fetcher),
    primaryQuery: githubDiscoveryDefaultQuery,
    includeFallback: false,
    perPage: 5,
    page: 1
  });

  assert.equal(discovery.status, "empty");
  assert.equal(discovery.acceptedCount, 0);
  assert.equal(discovery.rejectedCount, 1);
  const firstObservation = discovery.observations[0];
  assert(firstObservation !== undefined);
  assert.equal(firstObservation.validation, "rejected");
  assert.equal(firstObservation.reason, "expired");
});

void test("client discovery returns bounded abort and error reports", async () => {
  const aborted = new AbortController();
  aborted.abort();
  const abortingCarrier: SearchCarrier = {
    id: "test",
    search: () => {
      throw new DOMException("aborted", "AbortError");
    }
  };
  const failingCarrier: SearchCarrier = {
    id: "test",
    search: () => {
      throw new Error("carrier unavailable");
    }
  };

  const abortedReport = await discoverClientBootstrapBeacons({
    carrier: abortingCarrier,
    primaryQuery: githubDiscoveryDefaultQuery,
    includeFallback: true,
    signal: aborted.signal
  });
  const failedReport = await discoverClientBootstrapBeacons({
    carrier: failingCarrier,
    primaryQuery: githubDiscoveryDefaultQuery,
    includeFallback: false
  });

  assert.equal(abortedReport.status, "aborted");
  assert.equal(abortedReport.carrierReports.length, 1);
  assert.equal(abortedReport.observations.length, 0);
  assert.equal(failedReport.status, "failed");
  assert.equal(failedReport.carrierReports[0]?.message, "carrier unavailable");
});

void test("client discovery clamps carrier request bounds and dedupes accepted beacons", async () => {
  const seenRequests: SearchCarrierSearchRequest[] = [];
  const duplicate = acceptedObservation("github:one", "github", "alice/carrier");
  const carrier: SearchCarrier = {
    id: "github",
    search: (request) => {
      seenRequests.push(request);
      return Promise.resolve({
        carrier: "github",
        status: "ok",
        query: request.query,
        message: "duplicates",
        observations: [duplicate, acceptedObservation("github:two", "github", "bob/mirror")],
        evidenceCount: 2,
        raw: null
      });
    }
  };

  const report = await discoverClientBootstrapBeacons({
    carrier,
    primaryQuery: "branchbootstrapv0 in:readme",
    includeFallback: true,
    perPage: 99,
    page: 99
  });

  const firstRequest = seenRequests[0];
  assert(firstRequest !== undefined);
  assert.equal(firstRequest.perPage, 10);
  assert.equal(firstRequest.page, 10);
  assert.equal(report.status, "ok");
  assert.equal(report.observations.length, 1);
});

function acceptedObservation(observationId: string, carrier: string, source: string): BeaconObservation {
  return {
    observationId,
    validation: "accepted",
    reason: "accepted",
    wrapperPreview: "BRANCH0.preview",
    evidence: {
      carrier,
      query: githubDiscoveryDefaultQuery,
      source,
      sourceUrl: `https://github.com/${source}`,
      recordUrl: `https://api.github.com/repos/${source}/contents/.branch/records.br0?ref=main`
    },
    expiresAt: 1_789_000_000,
    relayEndpoint: "wss wss://branch.undoo.ru:443/relay/v0",
    profileMultihash: "uEiDT2miAcWcvbJ3mm4ihtMdng1nP8Y1VY3Gqp_xZrpzvsA",
    senderPublicKey: "sender",
    beaconId: "beacon",
    sequence: 1
  };
}

function repositoryItem(fullName: string): unknown {
  const [owner, name] = fullName.split("/");
  assert(owner !== undefined);
  assert(name !== undefined);
  return {
    full_name: fullName,
    fork: false,
    html_url: `https://github.com/${fullName}`,
    default_branch: "main",
    owner: { login: owner },
    name
  };
}

function recordsResponse(content: string): Response {
  return jsonResponse({
    type: "file",
    encoding: "base64",
    content: Buffer.from(content, "utf8").toString("base64")
  });
}

function jsonResponse(value: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers
    }
  });
}
