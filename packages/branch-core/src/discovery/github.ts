import { encodeBase64URL } from "../protocol/v0/base64url.js";
import { validateBranchTextBootstrapBeacon } from "../protocol/v0/bootstrap-beacon.js";
import { parseBranchID, validateBranchTextIdentityContact } from "../protocol/v0/identity-contact.js";
import { extractBranchTextWrappers } from "../protocol/v0/text-carrier.js";
import type { BeaconObservation, SearchCarrier, SearchCarrierSearchReport } from "./client.js";
import type {
  IdentityContactObservation,
  IdentityContactSearchCarrier,
  IdentityContactSearchReport,
  IdentityContactSearchRequest
} from "./identity-contact.js";
import { githubLegacyMarkerQuery, githubPrimaryLocatorQuery } from "./publication-profile.js";

export const githubDiscoveryDefaultQuery = githubPrimaryLocatorQuery;
export const githubDiscoveryFallbackQuery = githubLegacyMarkerQuery;
export const githubRepositorySearchEndpoint = "https://api.github.com/search/repositories";
export const githubRawContentBaseUrl = "https://raw.githubusercontent.com";
export const githubApiVersion = "2022-11-28";
export const maxGitHubDiscoveryQueryBytes = 256;
export const maxGitHubDiscoveryPerPage = 10;
export const maxGitHubDiscoveryPage = 10;
export const maxGitHubRecordBytes = 64 * 1024;
export const maxGitHubSearchItems = 10;
export const maxGitHubWrappersPerRecord = 16;
export const defaultGitHubSearchTimeoutMs = 3_000;
export const minGitHubSearchTimeoutMs = 100;
export const maxGitHubSearchTimeoutMs = 10_000;

export type GitHubDiscoveryStatus = "ok" | "empty" | "partial" | "rate_limited" | "failed";

export interface GitHubDiscoveryRequest {
  readonly query: string;
  readonly includeForks: boolean;
  readonly perPage: number;
  readonly page: number;
  /** Bounds the complete GitHub search pass, including contents reads. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface GitHubSearchCarrierOptions {
  /** Bounds a complete search pass. Values are clamped to the adapter limit. */
  readonly timeoutMs?: number;
}

export interface GitHubDiscoveryResult {
  readonly repository: string;
  readonly defaultBranch: string;
  readonly fork: boolean;
  readonly htmlUrl: string;
  readonly recordsUrl: string;
  readonly wrapperCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly firstWrapperPreview: string | null;
  readonly records: readonly GitHubValidatedRecord[];
  readonly status: "candidate" | "no_records" | "error";
  readonly reason: string | null;
}

export interface GitHubValidatedRecord {
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

export interface GitHubDiscoveryReport {
  readonly status: GitHubDiscoveryStatus;
  readonly query: string;
  readonly searchUrl: string;
  readonly totalCount: number | null;
  readonly incompleteResults: boolean;
  readonly rateLimitRemaining: string | null;
  readonly rateLimitReset: string | null;
  readonly results: readonly GitHubDiscoveryResult[];
  readonly message: string;
}

export interface GitHubIdentityContactDiscoveryReport {
  readonly status: GitHubDiscoveryStatus;
  readonly query: string;
  readonly branchID: string;
  readonly searchUrl: string;
  readonly totalCount: number | null;
  readonly incompleteResults: boolean;
  readonly rateLimitRemaining: string | null;
  readonly rateLimitReset: string | null;
  readonly results: readonly GitHubIdentityContactDiscoveryResult[];
  readonly message: string;
}

export interface GitHubIdentityContactDiscoveryResult {
  readonly repository: string;
  readonly defaultBranch: string;
  readonly fork: boolean;
  readonly htmlUrl: string;
  readonly recordsUrl: string;
  readonly wrapperCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly firstWrapperPreview: string | null;
  readonly records: readonly GitHubIdentityContactValidatedRecord[];
  readonly status: "candidate" | "no_records" | "error";
  readonly reason: string | null;
}

export interface GitHubIdentityContactValidatedRecord {
  readonly wrapperPreview: string;
  readonly validation: "accepted" | "rejected";
  readonly reason: IdentityContactObservation["reason"];
  readonly branchID: string | null;
  readonly expiresAt: number | null;
  readonly sequence: number | null;
  readonly routeHints: readonly {
    readonly transport: string;
    readonly uri: string;
    readonly relayPublicKey: string;
    readonly profileMultihash: string;
    readonly priority: number;
  }[];
  readonly profileMultihashes: readonly string[];
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

interface GitHubRepositorySearchResponse {
  readonly total_count: number;
  readonly incomplete_results: boolean;
  readonly items: readonly GitHubRepositorySearchItem[];
}

interface GitHubRepositorySearchItem {
  readonly full_name: string;
  readonly fork: boolean;
  readonly html_url: string;
  readonly default_branch: string;
  readonly owner: {
    readonly login: string;
  };
  readonly name: string;
}

export async function discoverGitHubDropIns(
  request: GitHubDiscoveryRequest,
  fetcher: Fetcher = globalThis.fetch.bind(globalThis)
): Promise<GitHubDiscoveryReport> {
  const normalized = normalizeDiscoveryRequest(request);
  const deadline = createGitHubSearchDeadline(fetcher, normalized.signal, normalized.timeoutMs ?? defaultGitHubSearchTimeoutMs);
  try {
    return await discoverGitHubDropInsWithinDeadline(normalized, deadline.fetcher);
  } finally {
    deadline.dispose();
  }
}

async function discoverGitHubDropInsWithinDeadline(
  normalized: GitHubDiscoveryRequest,
  fetcher: Fetcher
): Promise<GitHubDiscoveryReport> {
  const searchUrl = makeGitHubRepositorySearchUrl(normalized);
  const searchResponse = await fetcher(searchUrl, makeGitHubRequestInit(normalized.signal));
  const rateLimitRemaining = searchResponse.headers.get("x-ratelimit-remaining");
  const rateLimitReset = searchResponse.headers.get("x-ratelimit-reset");

  if (searchResponse.status === 403 || searchResponse.status === 429) {
    return {
      status: "rate_limited",
      query: normalized.query,
      searchUrl,
      totalCount: null,
      incompleteResults: false,
      rateLimitRemaining,
      rateLimitReset,
      results: [],
      message: `GitHub search rate limited (${String(searchResponse.status)})`
    };
  }
  if (!searchResponse.ok) {
    return {
      status: "failed",
      query: normalized.query,
      searchUrl,
      totalCount: null,
      incompleteResults: false,
      rateLimitRemaining,
      rateLimitReset,
      results: [],
      message: `GitHub search failed (${String(searchResponse.status)})`
    };
  }

  const searchPayload = await readJson(searchResponse);
  if (!isRepositorySearchResponse(searchPayload)) {
    return {
      status: "failed",
      query: normalized.query,
      searchUrl,
      totalCount: null,
      incompleteResults: false,
      rateLimitRemaining,
      rateLimitReset,
      results: [],
      message: "GitHub search response rejected"
    };
  }

  const results: GitHubDiscoveryResult[] = [];
  for (const repository of selectRepositories(searchPayload.items, normalized.includeForks)) {
    try {
      results.push(await readRepositoryRecords(repository, normalized.signal, fetcher));
    } catch (error) {
      if (isAbortError(error) || isGitHubSearchTimeoutError(error) || normalized.signal?.aborted === true) {
        throw error;
      }
      results.push(emptyResult(repositoryResultBase(repository), "error", "GitHub records response rejected"));
    }
  }

  const status = statusFromRepositoryResults(results);
  return {
    status,
    query: normalized.query,
    searchUrl,
    totalCount: searchPayload.total_count,
    incompleteResults: searchPayload.incomplete_results,
    rateLimitRemaining,
    rateLimitReset,
    results,
    message: repositoryResultsMessage(results, "records")
  };
}

export function createGitHubSearchCarrier(fetcher?: Fetcher, options: GitHubSearchCarrierOptions = {}): SearchCarrier {
  return {
    id: "github",
    search: async (request) => gitHubReportToSearchCarrierReport(
      await discoverGitHubDropIns({
        query: request.query,
        includeForks: request.includeForks ?? false,
        perPage: request.perPage,
        page: request.page,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(request.signal === undefined ? {} : { signal: request.signal })
      }, fetcher),
      "github"
    )
  };
}

export function createGitHubIdentityContactSearchCarrier(
  fetcher?: Fetcher,
  options: GitHubSearchCarrierOptions = {}
): IdentityContactSearchCarrier {
  return {
    id: "github",
    search: async (request) => gitHubIdentityContactReportToSearchCarrierReport(
      await discoverGitHubIdentityContacts({
        query: request.query,
        branchID: request.branchID,
        includeForks: request.includeForks ?? false,
        perPage: request.perPage,
        page: request.page,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(request.signal === undefined ? {} : { signal: request.signal })
      }, fetcher),
      "github"
    )
  };
}

export function gitHubReportToSearchCarrierReport(report: GitHubDiscoveryReport, carrier: string): SearchCarrierSearchReport {
  return {
    carrier,
    status: report.status,
    query: report.query,
    message: report.message,
    observations: report.results.flatMap((result) => gitHubResultToObservations(result, carrier, report.query)),
    evidenceCount: report.results.length,
    raw: report
  };
}

export function gitHubIdentityContactReportToSearchCarrierReport(
  report: GitHubIdentityContactDiscoveryReport,
  carrier: string
): IdentityContactSearchReport {
  return {
    carrier,
    status: report.status,
    query: report.query,
    branchID: report.branchID,
    message: report.message,
    observations: report.results.flatMap((result) => gitHubIdentityContactResultToObservations(result, carrier, report.query)),
    evidenceCount: report.results.length,
    raw: report
  };
}

export function gitHubReportsFromCarrierReports(reports: readonly SearchCarrierSearchReport[]): readonly GitHubDiscoveryReport[] {
  return reports.map((report) => report.raw).filter(isGitHubDiscoveryReport);
}

export function gitHubIdentityContactReportsFromCarrierReports(
  reports: readonly IdentityContactSearchReport[]
): readonly GitHubIdentityContactDiscoveryReport[] {
  return reports.map((report) => report.raw).filter(isGitHubIdentityContactDiscoveryReport);
}

export function mergeGitHubDiscoveryReports(reports: readonly GitHubDiscoveryReport[]): GitHubDiscoveryReport {
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
      message: "0 accepted records from 0 candidate repositories"
    };
  }
  const results = dedupeGitHubResults(reports.flatMap((report) => report.results));
  const accepted = results.reduce((total, result) => total + result.acceptedCount, 0);
  const status = accepted > 0
    ? reports.some((report) => report.status === "failed" || report.status === "partial" || report.status === "rate_limited")
      ? "partial"
      : "ok"
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
    message: repositoryResultsMessage(results, "records")
  };
}

export function makeGitHubRepositorySearchUrl(request: GitHubDiscoveryRequest): string {
  const normalized = normalizeDiscoveryRequest(request);
  const query = normalized.includeForks ? `${normalized.query} fork:true` : normalized.query;
  const url = new URL(githubRepositorySearchEndpoint);
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", String(normalized.perPage));
  url.searchParams.set("page", String(normalized.page));
  return url.toString();
}

export async function discoverGitHubIdentityContacts(
  request: IdentityContactSearchRequest,
  fetcher: Fetcher = globalThis.fetch.bind(globalThis)
): Promise<GitHubIdentityContactDiscoveryReport> {
  const branchID = request.branchID.trim();
  parseBranchID(branchID);
  const normalized = normalizeDiscoveryRequest({
    query: request.query,
    includeForks: request.includeForks ?? false,
    perPage: request.perPage,
    page: request.page,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.signal === undefined ? {} : { signal: request.signal })
  });
  const deadline = createGitHubSearchDeadline(fetcher, normalized.signal, normalized.timeoutMs ?? defaultGitHubSearchTimeoutMs);
  try {
    return await discoverGitHubIdentityContactsWithinDeadline(branchID, normalized, deadline.fetcher);
  } finally {
    deadline.dispose();
  }
}

async function discoverGitHubIdentityContactsWithinDeadline(
  branchID: string,
  normalized: GitHubDiscoveryRequest,
  fetcher: Fetcher
): Promise<GitHubIdentityContactDiscoveryReport> {
  const searchUrl = makeGitHubRepositorySearchUrl(normalized);
  const searchResponse = await fetcher(searchUrl, makeGitHubRequestInit(normalized.signal));
  const rateLimitRemaining = searchResponse.headers.get("x-ratelimit-remaining");
  const rateLimitReset = searchResponse.headers.get("x-ratelimit-reset");

  if (searchResponse.status === 403 || searchResponse.status === 429) {
    return {
      status: "rate_limited",
      query: normalized.query,
      branchID,
      searchUrl,
      totalCount: null,
      incompleteResults: false,
      rateLimitRemaining,
      rateLimitReset,
      results: [],
      message: `GitHub identity search rate limited (${String(searchResponse.status)})`
    };
  }
  if (!searchResponse.ok) {
    return {
      status: "failed",
      query: normalized.query,
      branchID,
      searchUrl,
      totalCount: null,
      incompleteResults: false,
      rateLimitRemaining,
      rateLimitReset,
      results: [],
      message: `GitHub identity search failed (${String(searchResponse.status)})`
    };
  }

  const searchPayload = await readJson(searchResponse);
  if (!isRepositorySearchResponse(searchPayload)) {
    return {
      status: "failed",
      query: normalized.query,
      branchID,
      searchUrl,
      totalCount: null,
      incompleteResults: false,
      rateLimitRemaining,
      rateLimitReset,
      results: [],
      message: "GitHub identity search response rejected"
    };
  }

  const results: GitHubIdentityContactDiscoveryResult[] = [];
  for (const repository of selectRepositories(searchPayload.items, normalized.includeForks)) {
    try {
      results.push(await readRepositoryIdentityContactRecords(repository, branchID, normalized.signal, fetcher));
    } catch (error) {
      if (isAbortError(error) || isGitHubSearchTimeoutError(error) || normalized.signal?.aborted === true) {
        throw error;
      }
      results.push(emptyIdentityContactResult(repositoryResultBase(repository), "error", "GitHub records response rejected"));
    }
  }

  const status = statusFromRepositoryResults(results);
  return {
    status,
    query: normalized.query,
    branchID,
    searchUrl,
    totalCount: searchPayload.total_count,
    incompleteResults: searchPayload.incomplete_results,
    rateLimitRemaining,
    rateLimitReset,
    results,
    message: repositoryResultsMessage(results, "identity records")
  };
}

export const githubDiscoveryConstraints = [
  "Uses topic:branchbootstrapv0 as the primary GitHub metadata locator; legacy README marker queries are bounded transition fallbacks.",
  "Uses one GitHub repository search, then reads public .branch/records.br0 bytes from raw.githubusercontent.com to avoid per-repository Contents API quota consumption.",
  "Unauthenticated requests are IP rate limited; 403/429 and x-ratelimit headers are surfaced to the operator.",
  "Search may be incomplete, delayed, paginated, fork-filtered, or missing recently pushed records.",
  "One adapter-owned deadline bounds a complete repository search pass and preserves caller cancellation.",
  "A malformed or oversized candidate records file is isolated to that repository; later bounded candidates still validate.",
  "Extracted BRANCH0 wrappers remain candidates until protocol-core validation accepts signatures and freshness."
] as const;

function normalizeDiscoveryRequest(request: GitHubDiscoveryRequest): GitHubDiscoveryRequest {
  const query = request.query.trim() || githubDiscoveryDefaultQuery;
  if (new TextEncoder().encode(query).byteLength > maxGitHubDiscoveryQueryBytes) {
    throw new Error("GitHub discovery query too large");
  }
  return {
    query,
    includeForks: request.includeForks,
    perPage: clampInteger(request.perPage, 1, maxGitHubDiscoveryPerPage),
    page: clampInteger(request.page, 1, maxGitHubDiscoveryPage),
    timeoutMs: clampInteger(request.timeoutMs ?? defaultGitHubSearchTimeoutMs, minGitHubSearchTimeoutMs, maxGitHubSearchTimeoutMs),
    ...(request.signal === undefined ? {} : { signal: request.signal })
  };
}

async function readRepositoryRecords(
  repository: GitHubRepositorySearchItem,
  signal: AbortSignal | undefined,
  fetcher: Fetcher
): Promise<GitHubDiscoveryResult> {
  const recordsUrl = makeGitHubRawRecordsUrl(repository.owner.login, repository.name, ".branch/records.br0", repository.default_branch);
  const base = repositoryResultBase(repository, recordsUrl);
  const response = await fetcher(recordsUrl, makeGitHubRawRequestInit(signal));

  if (response.status === 404) {
    return emptyResult(base, "no_records", "no .branch/records.br0 on default branch");
  }
  if (response.status === 403 || response.status === 429) {
    return emptyResult(base, "error", `GitHub content rate limited (${String(response.status)})`);
  }
  if (!response.ok) {
    return emptyResult(base, "error", `GitHub content failed (${String(response.status)})`);
  }
  const content = await readBoundedText(response, maxGitHubRecordBytes);
  const wrappers = extractBranchTextWrappers(content, maxGitHubWrappersPerRecord);
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

async function readRepositoryIdentityContactRecords(
  repository: GitHubRepositorySearchItem,
  branchID: string,
  signal: AbortSignal | undefined,
  fetcher: Fetcher
): Promise<GitHubIdentityContactDiscoveryResult> {
  const recordsUrl = makeGitHubRawRecordsUrl(repository.owner.login, repository.name, ".branch/records.br0", repository.default_branch);
  const base = repositoryResultBase(repository, recordsUrl);
  const response = await fetcher(recordsUrl, makeGitHubRawRequestInit(signal));

  if (response.status === 404) {
    return emptyIdentityContactResult(base, "no_records", "no .branch/records.br0 on default branch");
  }
  if (response.status === 403 || response.status === 429) {
    return emptyIdentityContactResult(base, "error", `GitHub content rate limited (${String(response.status)})`);
  }
  if (!response.ok) {
    return emptyIdentityContactResult(base, "error", `GitHub content failed (${String(response.status)})`);
  }
  const content = await readBoundedText(response, maxGitHubRecordBytes);
  const wrappers = extractBranchTextWrappers(content, maxGitHubWrappersPerRecord);
  const firstWrapper = wrappers[0]?.wrapper ?? null;
  const records = await validateIdentityContactWrappers(wrappers.map((wrapper) => wrapper.wrapper), branchID);
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
        ? "records.br0 has no accepted identity.announce records for BranchID"
        : null
  };
}

function emptyResult(
  base: Pick<GitHubDiscoveryResult, "repository" | "defaultBranch" | "fork" | "htmlUrl" | "recordsUrl">,
  status: GitHubDiscoveryResult["status"],
  reason: string
): GitHubDiscoveryResult {
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

function emptyIdentityContactResult(
  base: Pick<GitHubIdentityContactDiscoveryResult, "repository" | "defaultBranch" | "fork" | "htmlUrl" | "recordsUrl">,
  status: GitHubIdentityContactDiscoveryResult["status"],
  reason: string
): GitHubIdentityContactDiscoveryResult {
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

async function validateWrappers(wrappers: readonly string[]): Promise<readonly GitHubValidatedRecord[]> {
  const records: GitHubValidatedRecord[] = [];
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

async function validateIdentityContactWrappers(
  wrappers: readonly string[],
  branchID: string
): Promise<readonly GitHubIdentityContactValidatedRecord[]> {
  const records: GitHubIdentityContactValidatedRecord[] = [];
  for (const wrapper of wrappers) {
    const result = await validateBranchTextIdentityContact(wrapper);
    if (!result.accepted || result.contact === undefined) {
      records.push({
        wrapperPreview: previewWrapper(wrapper),
        validation: "rejected",
        reason: result.reason,
        branchID: null,
        expiresAt: null,
        sequence: null,
        routeHints: [],
        profileMultihashes: []
      });
      continue;
    }
    const contactBranchID = result.contact.payload.branchId;
    if (contactBranchID !== branchID) {
      records.push({
        wrapperPreview: previewWrapper(wrapper),
        validation: "rejected",
        reason: "branch_id_mismatch",
        branchID: contactBranchID,
        expiresAt: result.contact.payload.expiresAt,
        sequence: result.contact.payload.sequence,
        routeHints: result.contact.payload.routeHints,
        profileMultihashes: result.contact.payload.profileMultihashes
      });
      continue;
    }
    records.push({
      wrapperPreview: previewWrapper(wrapper),
      validation: "accepted",
      reason: result.reason,
      branchID: contactBranchID,
      expiresAt: result.contact.payload.expiresAt,
      sequence: result.contact.payload.sequence,
      routeHints: result.contact.payload.routeHints,
      profileMultihashes: result.contact.payload.profileMultihashes
    });
  }
  return records;
}

function gitHubResultToObservations(result: GitHubDiscoveryResult, carrier: string, query: string): readonly BeaconObservation[] {
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

function gitHubIdentityContactResultToObservations(
  result: GitHubIdentityContactDiscoveryResult,
  carrier: string,
  query: string
): readonly IdentityContactObservation[] {
  return result.records.map((record, index) => ({
    observationId: `${carrier}:identity:${result.recordsUrl}:${String(index)}`,
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
    branchID: record.branchID,
    expiresAt: record.expiresAt,
    sequence: record.sequence,
    routeHints: record.routeHints,
    profileMultihashes: record.profileMultihashes
  }));
}

function makeGitHubRawRecordsUrl(owner: string, repo: string, path: string, ref: string): string {
  const segments = [owner, repo, ref, ...path.split("/")].map((segment) => encodeURIComponent(segment));
  return `${githubRawContentBaseUrl}/${segments.join("/")}`;
}

function makeGitHubHeaders(): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": githubApiVersion
  };
}

function makeGitHubRequestInit(signal: AbortSignal | undefined): RequestInit {
  return {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    headers: makeGitHubHeaders(),
    ...(signal === undefined ? {} : { signal })
  };
}

function makeGitHubRawRequestInit(signal: AbortSignal | undefined): RequestInit {
  return {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    headers: { Accept: "text/plain" },
    ...(signal === undefined ? {} : { signal })
  };
}

interface GitHubSearchDeadline {
  readonly fetcher: Fetcher;
  readonly dispose: () => void;
}

class GitHubSearchTimeoutError extends Error {
  constructor() {
    super("GitHub search timed out");
  }
}

function createGitHubSearchDeadline(fetcher: Fetcher, signal: AbortSignal | undefined, timeoutMs: number): GitHubSearchDeadline {
  const controller = new AbortController();
  let timeout = false;
  const termination = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => {
      if (timeout) {
        reject(new GitHubSearchTimeoutError());
        return;
      }
      reject(new DOMException("GitHub search aborted", "AbortError"));
    }, { once: true });
  });
  const abortFromCaller = (): void => {
    controller.abort(signal?.reason);
  };
  if (signal?.aborted === true) {
    abortFromCaller();
  } else {
    signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort();
  }, timeoutMs);
  return {
    fetcher: async (input, init) => Promise.race([
      fetcher(input, { ...init, signal: controller.signal }),
      termination
    ]),
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
      controller.abort();
    }
  };
}

async function readJson(response: Response): Promise<unknown> {
  const bytes = await readBoundedResponseBytes(response, maxGitHubRecordBytes);
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const bytes = await readBoundedResponseBytes(response, limit);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("GitHub response is not UTF-8 text");
  }
}

async function readBoundedResponseBytes(response: Response, limit: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && isDeclaredResponseTooLarge(contentLength, limit)) {
    throw new Error("GitHub response too large");
  }
  if (response.body === null) {
    throw new Error("GitHub response body missing");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value.byteLength > limit - total) {
        try {
          await reader.cancel();
        } catch {
          // The bounded error below is authoritative even when cancellation fails.
        }
        throw new Error("GitHub response too large");
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isDeclaredResponseTooLarge(value: string, limit: number): boolean {
  if (!/^[0-9]+$/.test(value)) {
    return false;
  }
  const length = Number(value);
  return Number.isSafeInteger(length) && length > limit;
}

function isGitHubDiscoveryReport(value: unknown): value is GitHubDiscoveryReport {
  return isRecord(value) &&
    (value["status"] === "ok" || value["status"] === "empty" || value["status"] === "partial" || value["status"] === "rate_limited" || value["status"] === "failed") &&
    typeof value["query"] === "string" &&
    typeof value["searchUrl"] === "string" &&
    Array.isArray(value["results"]);
}

function isGitHubIdentityContactDiscoveryReport(value: unknown): value is GitHubIdentityContactDiscoveryReport {
  return isRecord(value) &&
    (value["status"] === "ok" || value["status"] === "empty" || value["status"] === "partial" || value["status"] === "rate_limited" || value["status"] === "failed") &&
    typeof value["query"] === "string" &&
    typeof value["branchID"] === "string" &&
    typeof value["searchUrl"] === "string" &&
    Array.isArray(value["results"]);
}

function isRepositorySearchResponse(value: unknown): value is GitHubRepositorySearchResponse {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value["total_count"] === "number" &&
    typeof value["incomplete_results"] === "boolean" &&
    Array.isArray(value["items"]) &&
    value["items"].every(isRepositorySearchItem);
}

function isRepositorySearchItem(value: unknown): value is GitHubRepositorySearchItem {
  if (!isRecord(value) || !isRecord(value["owner"])) {
    return false;
  }
  return typeof value["full_name"] === "string" &&
    typeof value["fork"] === "boolean" &&
    typeof value["html_url"] === "string" &&
    typeof value["default_branch"] === "string" &&
    typeof value["owner"]["login"] === "string" &&
    typeof value["name"] === "string";
}

function selectRepositories(
  repositories: readonly GitHubRepositorySearchItem[],
  includeForks: boolean
): readonly GitHubRepositorySearchItem[] {
  return repositories
    .slice(0, maxGitHubSearchItems)
    .filter((repository) => includeForks || !repository.fork);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isGitHubSearchTimeoutError(error: unknown): error is GitHubSearchTimeoutError {
  return error instanceof GitHubSearchTimeoutError;
}

function repositoryResultBase(
  repository: GitHubRepositorySearchItem,
  recordsUrl = makeGitHubRawRecordsUrl(repository.owner.login, repository.name, ".branch/records.br0", repository.default_branch)
): Pick<GitHubDiscoveryResult, "repository" | "defaultBranch" | "fork" | "htmlUrl" | "recordsUrl"> {
  return {
    repository: repository.full_name,
    defaultBranch: repository.default_branch,
    fork: repository.fork,
    htmlUrl: repository.html_url,
    recordsUrl
  };
}

function statusFromRepositoryResults(results: readonly { readonly acceptedCount: number; readonly status: "candidate" | "no_records" | "error" }[]): GitHubDiscoveryStatus {
  const accepted = results.some((result) => result.acceptedCount > 0);
  const failed = results.some((result) => result.status === "error");
  if (accepted) {
    return failed ? "partial" : "ok";
  }
  return failed ? "failed" : "empty";
}

function repositoryResultsMessage(
  results: readonly { readonly acceptedCount: number; readonly status: "candidate" | "no_records" | "error" }[],
  recordKind: string
): string {
  const accepted = results.reduce((total, result) => total + result.acceptedCount, 0);
  const candidates = results.filter((result) => result.status === "candidate").length;
  const failed = results.filter((result) => result.status === "error").length;
  const failureSuffix = failed === 0 ? "" : `; ${String(failed)} ${recordKind} read${failed === 1 ? "" : "s"} failed`;
  return `${String(accepted)} accepted records from ${String(candidates)} candidate repositories${failureSuffix}`;
}

function dedupeGitHubResults(results: readonly GitHubDiscoveryResult[]): readonly GitHubDiscoveryResult[] {
  const deduped: GitHubDiscoveryResult[] = [];
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
