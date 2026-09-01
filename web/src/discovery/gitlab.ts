import { encodeBase64URL } from "../protocol/v0/base64url.js";
import { validateBranchTextBootstrapBeacon } from "../protocol/v0/bootstrap-beacon.js";
import { extractBranchTextWrappers } from "../protocol/v0/text-carrier.js";
import type { BeaconObservation, SearchCarrier, SearchCarrierSearchReport } from "./client.js";
import { gitLabPrimaryLocatorQuery } from "./publication-profile.js";

export const gitLabDiscoveryDefaultQuery = gitLabPrimaryLocatorQuery;
export const gitLabProjectsEndpoint = "https://gitlab.com/api/v4/projects";
export const maxGitLabDiscoveryQueryBytes = 256;
export const maxGitLabDiscoveryPerPage = 10;
export const maxGitLabDiscoveryPage = 10;
export const maxGitLabRecordBytes = 64 * 1024;
export const maxGitLabSearchItems = 10;
export const maxGitLabWrappersPerRecord = 16;

export type GitLabDiscoveryStatus = "ok" | "empty" | "rate_limited" | "failed";

export interface GitLabDiscoveryRequest {
  readonly query: string;
  readonly perPage: number;
  readonly page: number;
  readonly signal?: AbortSignal;
}

export interface GitLabDiscoveryResult {
  readonly repository: string;
  readonly defaultBranch: string;
  readonly fork: boolean;
  readonly htmlUrl: string;
  readonly recordsUrl: string;
  readonly wrapperCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly firstWrapperPreview: string | null;
  readonly records: readonly GitLabValidatedRecord[];
  readonly status: "candidate" | "no_records" | "error";
  readonly reason: string | null;
}

export interface GitLabValidatedRecord {
  readonly wrapperPreview: string;
  readonly validation: "accepted" | "rejected";
  readonly reason: string;
  readonly expiresAt: number | null;
  readonly relayEndpoint: string | null;
  readonly profileMultihash: string | null;
  readonly senderPublicKey: string | null;
  readonly beaconId: string | null;
  readonly sequence: number | null;
}

export interface GitLabDiscoveryReport {
  readonly status: GitLabDiscoveryStatus;
  readonly query: string;
  readonly searchUrl: string;
  readonly totalCount: number | null;
  readonly incompleteResults: boolean;
  readonly rateLimitRemaining: string | null;
  readonly rateLimitReset: string | null;
  readonly results: readonly GitLabDiscoveryResult[];
  readonly message: string;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

interface GitLabProjectItem {
  readonly id: number;
  readonly path_with_namespace: string;
  readonly name_with_namespace: string;
  readonly web_url: string;
  readonly default_branch?: string | null;
  readonly forked_from_project?: unknown;
}

export async function discoverGitLabDropIns(
  request: GitLabDiscoveryRequest,
  fetcher: Fetcher = globalThis.fetch.bind(globalThis)
): Promise<GitLabDiscoveryReport> {
  const normalized = normalizeDiscoveryRequest(request);
  const searchUrl = makeGitLabProjectsUrl(normalized);
  const searchResponse = await fetcher(searchUrl, makeGitLabRequestInit(normalized.signal));
  const rateLimitRemaining = readHeader(searchResponse.headers, ["ratelimit-remaining", "x-ratelimit-remaining"]);
  const rateLimitReset = readHeader(searchResponse.headers, ["ratelimit-reset", "x-ratelimit-reset"]);
  const totalCount = parseNullableInteger(readHeader(searchResponse.headers, ["x-total"]));

  if (searchResponse.status === 403 || searchResponse.status === 429) {
    return emptyReport("rate_limited", normalized.query, searchUrl, totalCount, rateLimitRemaining, rateLimitReset, `GitLab project search rate limited (${String(searchResponse.status)})`);
  }
  if (!searchResponse.ok) {
    return emptyReport("failed", normalized.query, searchUrl, totalCount, rateLimitRemaining, rateLimitReset, `GitLab project search failed (${String(searchResponse.status)})`);
  }

  const payload = await readJson(searchResponse);
  if (!Array.isArray(payload) || !payload.every(isGitLabProjectItem)) {
    return emptyReport("failed", normalized.query, searchUrl, totalCount, rateLimitRemaining, rateLimitReset, "GitLab project search response rejected");
  }

  const results: GitLabDiscoveryResult[] = [];
  for (const project of payload.slice(0, maxGitLabSearchItems)) {
    results.push(await readProjectRecords(project, normalized.signal, fetcher));
  }
  const accepted = results.reduce((total, result) => total + result.acceptedCount, 0);
  return {
    status: accepted > 0 ? "ok" : "empty",
    query: normalized.query,
    searchUrl,
    totalCount,
    incompleteResults: readHeader(searchResponse.headers, ["x-next-page"]) !== null,
    rateLimitRemaining,
    rateLimitReset,
    results,
    message: `${String(accepted)} accepted records from ${String(results.filter((result) => result.status === "candidate").length)} candidate GitLab projects`
  };
}

export function createGitLabSearchCarrier(fetcher?: Fetcher): SearchCarrier {
  return {
    id: "gitlab",
    search: async (request) => gitLabReportToSearchCarrierReport(
      await discoverGitLabDropIns({
        query: request.query,
        perPage: request.perPage,
        page: request.page,
        ...(request.signal === undefined ? {} : { signal: request.signal })
      }, fetcher),
      "gitlab"
    )
  };
}

export function gitLabReportToSearchCarrierReport(report: GitLabDiscoveryReport, carrier: string): SearchCarrierSearchReport {
  return {
    carrier,
    status: report.status,
    query: report.query,
    message: report.message,
    observations: report.results.flatMap((result) => gitLabResultToObservations(result, carrier, report.query)),
    evidenceCount: report.results.length,
    raw: report
  };
}

export function gitLabReportsFromCarrierReports(reports: readonly SearchCarrierSearchReport[]): readonly GitLabDiscoveryReport[] {
  return reports.map((report) => report.raw).filter(isGitLabDiscoveryReport);
}

export function mergeGitLabDiscoveryReports(reports: readonly GitLabDiscoveryReport[]): GitLabDiscoveryReport {
  if (reports.length === 0) {
    return {
      status: "empty",
      query: "",
      searchUrl: "",
      totalCount: null,
      incompleteResults: false,
      rateLimitRemaining: null,
      rateLimitReset: null,
      results: [],
      message: "0 accepted records from 0 candidate GitLab projects"
    };
  }
  const results = dedupeGitLabResults(reports.flatMap((report) => report.results));
  const accepted = results.reduce((total, result) => total + result.acceptedCount, 0);
  const status = accepted > 0
    ? "ok"
    : reports.some((report) => report.status === "rate_limited")
      ? "rate_limited"
      : reports.some((report) => report.status === "failed")
        ? "failed"
        : "empty";
  return {
    status,
    query: reports.map((report) => report.query).join(" -> "),
    searchUrl: reports.map((report) => report.searchUrl).join("\n"),
    totalCount: sumNullable(reports.map((report) => report.totalCount)),
    incompleteResults: reports.some((report) => report.incompleteResults),
    rateLimitRemaining: reports.find((report) => report.rateLimitRemaining !== null)?.rateLimitRemaining ?? null,
    rateLimitReset: reports.find((report) => report.rateLimitReset !== null)?.rateLimitReset ?? null,
    results,
    message: `${String(accepted)} accepted records from ${String(results.filter((result) => result.status === "candidate").length)} candidate GitLab projects`
  };
}

export function makeGitLabProjectsUrl(request: GitLabDiscoveryRequest): string {
  const normalized = normalizeDiscoveryRequest(request);
  const url = new URL(gitLabProjectsEndpoint);
  url.searchParams.set("visibility", "public");
  url.searchParams.set("topic[]", normalized.query);
  url.searchParams.set("order_by", "last_activity_at");
  url.searchParams.set("sort", "desc");
  url.searchParams.set("per_page", String(normalized.perPage));
  url.searchParams.set("page", String(normalized.page));
  return url.toString();
}

export const gitLabDiscoveryConstraints = [
  "Uses GitLab public Projects API metadata for branchbootstrapv0; GitLab /search is not the unauthenticated baseline.",
  "Reads .branch/records.br0 from each public candidate project through the repository files raw API with ref=HEAD.",
  "GitLab project topics, descriptions, badges, CI, namespace ownership, and search rank are candidate evidence only.",
  "Unauthenticated project and file reads may be delayed, filtered, rate limited, instance-specific, or disabled by project visibility.",
  "Extracted BRANCH0 wrappers remain candidates until protocol-core validation accepts signatures and freshness."
] as const;

function normalizeDiscoveryRequest(request: GitLabDiscoveryRequest): GitLabDiscoveryRequest {
  const query = request.query.trim() || gitLabDiscoveryDefaultQuery;
  if (new TextEncoder().encode(query).byteLength > maxGitLabDiscoveryQueryBytes) {
    throw new Error("GitLab discovery query too large");
  }
  return {
    query,
    perPage: clampInteger(request.perPage, 1, maxGitLabDiscoveryPerPage),
    page: clampInteger(request.page, 1, maxGitLabDiscoveryPage),
    ...(request.signal === undefined ? {} : { signal: request.signal })
  };
}

async function readProjectRecords(
  project: GitLabProjectItem,
  signal: AbortSignal | undefined,
  fetcher: Fetcher
): Promise<GitLabDiscoveryResult> {
  const defaultBranch = project.default_branch ?? "HEAD";
  const recordsUrl = makeGitLabRawFileUrl(project.path_with_namespace, ".branch/records.br0", defaultBranch);
  const base = {
    repository: project.path_with_namespace,
    defaultBranch,
    fork: project.forked_from_project !== undefined,
    htmlUrl: project.web_url,
    recordsUrl
  };
  const response = await fetcher(recordsUrl, makeGitLabRequestInit(signal));
  const rateLimited = response.status === 403 || response.status === 429;

  if (response.status === 404) {
    return emptyResult(base, "no_records", "no .branch/records.br0 on default branch");
  }
  if (rateLimited) {
    return emptyResult(base, "error", `GitLab content rate limited (${String(response.status)})`);
  }
  if (!response.ok) {
    return emptyResult(base, "error", `GitLab content failed (${String(response.status)})`);
  }

  const content = await response.text();
  if (new TextEncoder().encode(content).byteLength > maxGitLabRecordBytes) {
    return emptyResult(base, "error", "records.br0 too large");
  }
  const wrappers = extractBranchTextWrappers(content, maxGitLabWrappersPerRecord);
  const firstWrapper = wrappers[0]?.wrapper ?? null;
  const records = await validateWrappers(wrappers.map((wrapper) => wrapper.wrapper));
  const acceptedCount = records.filter((record) => record.validation === "accepted").length;
  return {
    ...base,
    wrapperCount: wrappers.length,
    acceptedCount,
    rejectedCount: records.length - acceptedCount,
    firstWrapperPreview: firstWrapper === null ? null : previewWrapper(firstWrapper),
    records,
    status: wrappers.length > 0 ? "candidate" : "no_records",
    reason: wrappers.length === 0
      ? "records.br0 has no bounded BRANCH0 wrappers"
      : acceptedCount === 0
        ? "records.br0 has no accepted bootstrap.beacon records"
        : null
  };
}

function makeGitLabRawFileUrl(projectPath: string, filePath: string, ref: string): string {
  const url = new URL(`${gitLabProjectsEndpoint}/${encodeURIComponent(projectPath)}/repository/files/${encodeURIComponent(filePath)}/raw`);
  url.searchParams.set("ref", ref);
  return url.toString();
}

function emptyReport(
  status: GitLabDiscoveryStatus,
  query: string,
  searchUrl: string,
  totalCount: number | null,
  rateLimitRemaining: string | null,
  rateLimitReset: string | null,
  message: string
): GitLabDiscoveryReport {
  return {
    status,
    query,
    searchUrl,
    totalCount,
    incompleteResults: false,
    rateLimitRemaining,
    rateLimitReset,
    results: [],
    message
  };
}

function emptyResult(
  base: Pick<GitLabDiscoveryResult, "repository" | "defaultBranch" | "fork" | "htmlUrl" | "recordsUrl">,
  status: GitLabDiscoveryResult["status"],
  reason: string
): GitLabDiscoveryResult {
  return {
    ...base,
    wrapperCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    firstWrapperPreview: null,
    records: [],
    status,
    reason
  };
}

async function validateWrappers(wrappers: readonly string[]): Promise<readonly GitLabValidatedRecord[]> {
  const records: GitLabValidatedRecord[] = [];
  for (const wrapper of wrappers) {
    const result = await validateBranchTextBootstrapBeacon(wrapper);
    if (!result.accepted || result.beacon === undefined) {
      records.push({
        wrapperPreview: previewWrapper(wrapper),
        validation: "rejected",
        reason: result.reason,
        expiresAt: null,
        relayEndpoint: null,
        profileMultihash: null,
        senderPublicKey: null,
        beaconId: null,
        sequence: null
      });
      continue;
    }
    const endpoint = result.beacon.payload.relayEndpoints[0] ?? null;
    records.push({
      wrapperPreview: previewWrapper(wrapper),
      validation: "accepted",
      reason: result.reason,
      expiresAt: result.beacon.payload.expiresAt,
      relayEndpoint: endpoint === null ? null : `${endpoint.transport} ${endpoint.uri}`,
      profileMultihash: result.beacon.payload.profileMultihashes[0] ?? null,
      senderPublicKey: encodeBase64URL(result.beacon.envelope.sender.publicKey),
      beaconId: encodeBase64URL(result.beacon.payload.beaconId),
      sequence: result.beacon.payload.sequence
    });
  }
  return records;
}

function gitLabResultToObservations(result: GitLabDiscoveryResult, carrier: string, query: string): readonly BeaconObservation[] {
  return result.records.map((record, index) => ({
    observationId: `${carrier}:${result.recordsUrl}:${String(index)}`,
    validation: record.validation,
    reason: record.reason,
    wrapperPreview: record.wrapperPreview,
    evidence: {
      carrier,
      query,
      source: result.repository,
      sourceUrl: result.htmlUrl,
      recordUrl: result.recordsUrl
    },
    expiresAt: record.expiresAt,
    relayEndpoint: record.relayEndpoint,
    profileMultihash: record.profileMultihash,
    senderPublicKey: record.senderPublicKey,
    beaconId: record.beaconId,
    sequence: record.sequence
  }));
}

function makeGitLabRequestInit(signal: AbortSignal | undefined): RequestInit {
  return {
    method: "GET",
    credentials: "omit",
    headers: { Accept: "application/json, text/plain" },
    ...(signal === undefined ? {} : { signal })
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxGitLabRecordBytes) {
    throw new Error("GitLab response too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isGitLabDiscoveryReport(value: unknown): value is GitLabDiscoveryReport {
  return isRecord(value) &&
    (value["status"] === "ok" || value["status"] === "empty" || value["status"] === "rate_limited" || value["status"] === "failed") &&
    typeof value["query"] === "string" &&
    typeof value["searchUrl"] === "string" &&
    Array.isArray(value["results"]);
}

function isGitLabProjectItem(value: unknown): value is GitLabProjectItem {
  return isRecord(value) &&
    typeof value["id"] === "number" &&
    typeof value["path_with_namespace"] === "string" &&
    typeof value["name_with_namespace"] === "string" &&
    typeof value["web_url"] === "string" &&
    (value["default_branch"] === undefined || value["default_branch"] === null || typeof value["default_branch"] === "string");
}

function readHeader(headers: Headers, names: readonly string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function parseNullableInteger(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupeGitLabResults(results: readonly GitLabDiscoveryResult[]): readonly GitLabDiscoveryResult[] {
  const deduped: GitLabDiscoveryResult[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.recordsUrl)) {
      continue;
    }
    seen.add(result.recordsUrl);
    deduped.push(result);
  }
  return deduped;
}

function sumNullable(values: readonly (number | null)[]): number | null {
  let total = 0;
  let found = false;
  for (const value of values) {
    if (value === null) {
      continue;
    }
    total += value;
    found = true;
  }
  return found ? total : null;
}

function previewWrapper(wrapper: string): string {
  return wrapper.length <= 28 ? wrapper : `${wrapper.slice(0, 22)}...${wrapper.slice(-6)}`;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
