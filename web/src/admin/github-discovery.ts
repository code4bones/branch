import { extractBranchTextWrappers } from "../protocol/v0/text-carrier.js";
import { validateBranchTextBootstrapBeacon } from "../protocol/v0/bootstrap-beacon.js";
import { githubLegacyMarkerQuery, githubPrimaryLocatorQuery } from "./publication-profile.js";

export const githubDiscoveryDefaultQuery = githubPrimaryLocatorQuery;
export const githubDiscoveryFallbackQuery = githubLegacyMarkerQuery;
export const githubRepositorySearchEndpoint = "https://api.github.com/search/repositories";
export const githubApiVersion = "2022-11-28";
export const maxGitHubDiscoveryQueryBytes = 256;
export const maxGitHubDiscoveryPerPage = 10;
export const maxGitHubDiscoveryPage = 10;
export const maxGitHubRecordBytes = 64 * 1024;

export type GitHubDiscoveryStatus = "ok" | "empty" | "rate_limited" | "failed";

export interface GitHubDiscoveryRequest {
  readonly query: string;
  readonly includeForks: boolean;
  readonly perPage: number;
  readonly page: number;
  readonly signal?: AbortSignal;
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
  for (const repository of searchPayload.items) {
    results.push(await readRepositoryRecords(repository, normalized.signal, fetcher));
  }

  return {
    status: results.some((result) => result.acceptedCount > 0) ? "ok" : "empty",
    query: normalized.query,
    searchUrl,
    totalCount: searchPayload.total_count,
    incompleteResults: searchPayload.incomplete_results,
    rateLimitRemaining,
    rateLimitReset,
    results,
    message: `${String(results.reduce((total, result) => total + result.acceptedCount, 0))} accepted records from ${String(results.filter((result) => result.status === "candidate").length)} candidate repositories`
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

export const githubDiscoveryConstraints = [
  "Uses branchbootstrapv0 as the primary public locator; legacy marker queries are bounded transition fallbacks.",
  "Reads .branch/records.br0 from the repository default branch through the GitHub contents API.",
  "Unauthenticated requests are IP rate limited; 403/429 and x-ratelimit headers are surfaced to the operator.",
  "Search may be incomplete, delayed, paginated, fork-filtered, or missing recently pushed records.",
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
    ...(request.signal === undefined ? {} : { signal: request.signal })
  };
}

async function readRepositoryRecords(
  repository: GitHubRepositorySearchItem,
  signal: AbortSignal | undefined,
  fetcher: Fetcher
): Promise<GitHubDiscoveryResult> {
  const recordsUrl = makeGitHubContentsUrl(repository.owner.login, repository.name, ".branch/records.br0", repository.default_branch);
  const base = {
    repository: repository.full_name,
    defaultBranch: repository.default_branch,
    fork: repository.fork,
    htmlUrl: repository.html_url,
    recordsUrl
  };
  const response = await fetcher(recordsUrl, makeGitHubRequestInit(signal));

  if (response.status === 404) {
    return emptyResult(base, "no_records", "no .branch/records.br0 on default branch");
  }
  if (response.status === 403 || response.status === 429) {
    return emptyResult(base, "error", `GitHub content rate limited (${String(response.status)})`);
  }
  if (!response.ok) {
    return emptyResult(base, "error", `GitHub content failed (${String(response.status)})`);
  }

  const payload = await readJson(response);
  const content = readContentFile(payload);
  if (content === null) {
    return emptyResult(base, "error", "records.br0 response rejected");
  }
  const wrappers = extractBranchTextWrappers(content, 16);
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
        profileMultihash: null
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
      profileMultihash: result.beacon.payload.profileMultihashes[0] ?? null
    });
  }
  return records;
}

function makeGitHubContentsUrl(owner: string, repo: string, path: string, ref: string): string {
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`);
  url.searchParams.set("ref", ref);
  return url.toString();
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
    headers: makeGitHubHeaders(),
    ...(signal === undefined ? {} : { signal })
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxGitHubRecordBytes) {
    throw new Error("GitHub response too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readContentFile(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value["type"] !== "file" || typeof value["content"] !== "string" || typeof value["encoding"] !== "string") {
    return null;
  }
  if (value["encoding"] !== "base64") {
    return null;
  }
  return decodeBase64(value["content"]);
}

function decodeBase64(value: string): string | null {
  const compact = value.replace(/\s+/g, "");
  try {
    if (typeof globalThis.atob === "function") {
      return globalThis.atob(compact);
    }
    const candidate = globalThis as { readonly Buffer?: { from(input: string, encoding: "base64"): { toString(encoding: "utf8"): string } } };
    return candidate.Buffer?.from(compact, "base64").toString("utf8") ?? null;
  } catch {
    return null;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
