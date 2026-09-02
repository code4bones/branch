import { test } from "node:test";
import assert from "node:assert/strict";

import {
  discoverClientBootstrapBeacons,
  type BeaconObservation,
  type SearchCarrier,
  type SearchCarrierSearchRequest
} from "@code4bones/branch-core/discovery/client.js";
import { discoverClientIdentityContacts } from "@code4bones/branch-core/discovery/identity-contact.js";
import {
  createGitHubIdentityContactSearchCarrier,
  createGitHubSearchCarrier,
  gitHubReportsFromCarrierReports,
  githubDiscoveryDefaultQuery,
  githubDiscoveryFallbackQuery,
  mergeGitHubDiscoveryReports
} from "@code4bones/branch-core/discovery/github.js";
import {
  createGitLabSearchCarrier,
  gitLabDiscoveryDefaultQuery,
  gitLabReportsFromCarrierReports,
  mergeGitLabDiscoveryReports
} from "@code4bones/branch-core/discovery/gitlab.js";
import { createBootstrapBeaconWrapper } from "@code4bones/branch-core/protocol/v0/bootstrap-beacon.js";
import { createIdentityContactWrapper, validateBranchTextIdentityContact } from "@code4bones/branch-core/protocol/v0/identity-contact.js";

void test("client discovery runs GitHub canonical locator then legacy fallback", async () => {
  const now = Math.floor(Date.now() / 1000);
  const wrapper = await createBootstrapBeaconWrapper({ now, expiresAt: now + 3600 });
  const queries: string[] = [];
  const fetcher = (input: string): Promise<Response> => {
    if (input.startsWith("https://api.github.com/search/repositories")) {
      const query = new URL(input).searchParams.get("q") ?? "";
      queries.push(query);
      return Promise.resolve(jsonResponse({
        total_count: query.startsWith("topic:branchbootstrapv0") ? 0 : 1,
        incomplete_results: false,
        items: query.startsWith("topic:branchbootstrapv0") ? [] : [repositoryItem("alice/carrier")]
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
    "topic:branchbootstrapv0",
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

void test("client discovery runs GitLab project locator without credentials", async () => {
  const now = Math.floor(Date.now() / 1000);
  const wrapper = await createBootstrapBeaconWrapper({ now, expiresAt: now + 3600 });
  const fetched: string[] = [];
  const fetchInits: RequestInit[] = [];
  const fetcher = (input: string, init?: RequestInit): Promise<Response> => {
    fetched.push(input);
    if (init !== undefined) {
      fetchInits.push(init);
    }
    if (input.startsWith("https://gitlab.com/api/v4/projects?")) {
      return Promise.resolve(jsonResponse([{
        id: 6,
        path_with_namespace: "alice/carrier",
        name_with_namespace: "Alice / Carrier",
        web_url: "https://gitlab.com/alice/carrier",
        default_branch: "main"
      }]));
    }
    return Promise.resolve(new Response(`${wrapper}\n`, {
      status: 200,
      headers: { "content-type": "text/plain" }
    }));
  };

  const discovery = await discoverClientBootstrapBeacons({
    carrier: createGitLabSearchCarrier(fetcher),
    primaryQuery: gitLabDiscoveryDefaultQuery,
    fallbackQuery: null,
    includeFallback: false,
    perPage: 5,
    page: 1
  });
  const report = mergeGitLabDiscoveryReports(gitLabReportsFromCarrierReports(discovery.carrierReports));

  assert.equal(discovery.status, "ok");
  assert.equal(discovery.acceptedCount, 1);
  assert.equal(discovery.observations[0]?.evidence.carrier, "gitlab");
  assert.equal(report.results[0]?.repository, "alice/carrier");
  assert.match(fetched[0] ?? "", /topic%5B%5D=branchbootstrapv0/);
  assert(fetchInits.every((init) => init.credentials === "omit"));
  assert(fetched.every((input) => !input.includes("PRIVATE-TOKEN") && !input.includes("oauth")));
});

void test("client discovery passes GitLab fork policy and reports failed content reads", async () => {
  const fetched: string[] = [];
  const fetcher = (input: string): Promise<Response> => {
    fetched.push(input);
    if (input.startsWith("https://gitlab.com/api/v4/projects?")) {
      return Promise.resolve(jsonResponse([
        {
          id: 31,
          path_with_namespace: "alice/base-carrier",
          name_with_namespace: "Alice / Base Carrier",
          web_url: "https://gitlab.com/alice/base-carrier",
          default_branch: "main",
          forked_from_project: null
        },
        {
          id: 32,
          path_with_namespace: "bob/fork-carrier",
          name_with_namespace: "Bob / Fork Carrier",
          web_url: "https://gitlab.com/bob/fork-carrier",
          default_branch: "main",
          forked_from_project: { id: 31 }
        }
      ]));
    }
    return Promise.resolve(new Response("blocked", { status: 500 }));
  };

  const discovery = await discoverClientBootstrapBeacons({
    carrier: createGitLabSearchCarrier(fetcher),
    primaryQuery: gitLabDiscoveryDefaultQuery,
    fallbackQuery: null,
    includeFallback: false,
    includeForks: false,
    perPage: 5,
    page: 1
  });
  const report = mergeGitLabDiscoveryReports(gitLabReportsFromCarrierReports(discovery.carrierReports));

  assert.equal(discovery.status, "failed");
  assert.equal(report.results.length, 1);
  const result = report.results[0];
  assert(result !== undefined);
  assert.equal(result.repository, "alice/base-carrier");
  assert.equal(result.fork, false);
  assert(fetched.some((url) => url.includes("alice%2Fbase-carrier")));
  assert(!fetched.some((url) => url.includes("bob%2Ffork-carrier")));
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
    primaryQuery: "topic:branchbootstrapv0",
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

void test("client identity discovery reads exact BranchID from direct GitHub carrier", async () => {
  const now = Math.floor(Date.now() / 1000);
  const wrapper = await createIdentityContactWrapper({ now, expiresAt: now + 3600 });
  const validation = await validateBranchTextIdentityContact(wrapper, { now });
  assert(validation.accepted && validation.contact !== undefined);
  const branchID = validation.contact.payload.branchId;
  const fetched: string[] = [];
  const fetcher = (input: string): Promise<Response> => {
    fetched.push(input);
    if (input.startsWith("https://api.github.com/search/repositories")) {
      return Promise.resolve(jsonResponse({
        total_count: 1,
        incomplete_results: false,
        items: [repositoryItem("alice/contact-carrier")]
      }));
    }
    return Promise.resolve(recordsResponse(wrapper));
  };

  const discovery = await discoverClientIdentityContacts({
    carrier: createGitHubIdentityContactSearchCarrier(fetcher),
    branchID,
    primaryQuery: githubDiscoveryDefaultQuery,
    fallbackQuery: null,
    includeFallback: false,
    perPage: 5,
    page: 1
  });

  assert.equal(discovery.status, "ok");
  assert.equal(discovery.acceptedCount, 1);
  assert.equal(discovery.observations[0]?.branchID, branchID);
  assert.equal(discovery.observations[0]?.evidence.source, "alice/contact-carrier");
  assert.match(fetched[0] ?? "", /topic%3Abranchbootstrapv0|topic:branchbootstrapv0/);
  assert.match(fetched[1] ?? "", /\.branch%2Frecords\.br0|\.branch\/records\.br0/);
});

void test("client identity discovery keeps non-matching direct carrier records rejected", async () => {
  const now = Math.floor(Date.now() / 1000);
  const wrapper = await createIdentityContactWrapper({ now, expiresAt: now + 3600 });
  const validation = await validateBranchTextIdentityContact(wrapper, { now });
  assert(validation.accepted && validation.contact !== undefined);
  const otherBranchID = "br1.EiAAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw";
  const bootstrapWrapper = await createBootstrapBeaconWrapper({ now, expiresAt: now + 3600 });
  const fetcher = (input: string): Promise<Response> => {
    if (input.startsWith("https://api.github.com/search/repositories")) {
      return Promise.resolve(jsonResponse({
        total_count: 1,
        incomplete_results: false,
        items: [repositoryItem("alice/wrong-contact")]
      }));
    }
    return Promise.resolve(recordsResponse(`${wrapper}\n${bootstrapWrapper}\n`));
  };

  const discovery = await discoverClientIdentityContacts({
    carrier: createGitHubIdentityContactSearchCarrier(fetcher),
    branchID: otherBranchID,
    primaryQuery: githubDiscoveryDefaultQuery,
    includeFallback: false,
    perPage: 5,
    page: 1
  });

  assert.equal(discovery.status, "empty");
  assert.equal(discovery.acceptedCount, 0);
  assert.equal(discovery.rejectedCount, 2);
  assert(discovery.observations.some((observation) => observation.reason === "branch_id_mismatch"));
  assert(discovery.observations.some((observation) => observation.reason === "unsupported_event_type"));
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
    profileMultihash: "uEiCaVLmVxHgth49YdSwXKM201oM4W6PHc61z_1rz-J_xVw",
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
