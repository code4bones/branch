import { parseBranchID, type IdentityContactRouteHint, type IdentityContactValidationReason } from "../protocol/v0/identity-contact.js";

export type IdentityContactDiscoveryStatus = "ok" | "empty" | "partial" | "failed" | "rate_limited" | "aborted";
export type IdentityContactObservationValidation = "accepted" | "rejected";

export interface IdentityContactSearchCarrier {
  readonly id: string;
  readonly search: (request: IdentityContactSearchRequest) => Promise<IdentityContactSearchReport>;
}

export interface IdentityContactSearchRequest {
  readonly query: string;
  readonly branchID: string;
  readonly page: number;
  readonly perPage: number;
  readonly includeForks?: boolean;
  /** Optional carrier-specific deadline; the carrier clamps its own bounds. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface IdentityContactEvidence {
  readonly carrier: string;
  readonly query: string;
  readonly source: string;
  readonly sourceUrl: string;
  readonly recordUrl: string;
}

export interface IdentityContactObservation {
  readonly observationId: string;
  readonly validation: IdentityContactObservationValidation;
  readonly reason: IdentityContactValidationReason | "branch_id_mismatch";
  readonly wrapperPreview: string;
  readonly evidence: IdentityContactEvidence;
  readonly branchID: string | null;
  readonly expiresAt: number | null;
  readonly sequence: number | null;
  readonly routeHints: readonly IdentityContactRouteHint[];
  readonly profileMultihashes: readonly string[];
}

export interface IdentityContactSearchReport {
  readonly carrier: string;
  readonly status: IdentityContactDiscoveryStatus;
  readonly query: string;
  readonly branchID: string;
  readonly message: string;
  readonly observations: readonly IdentityContactObservation[];
  readonly evidenceCount: number;
  readonly raw: unknown;
}

export interface ClientIdentityContactDiscoveryRequest {
  readonly carrier: IdentityContactSearchCarrier;
  readonly branchID: string;
  readonly primaryQuery: string;
  readonly fallbackQuery?: string | null;
  readonly includeFallback?: boolean;
  readonly includeForks?: boolean;
  readonly page?: number;
  readonly perPage?: number;
  readonly signal?: AbortSignal;
}

export interface ClientIdentityContactDiscoveryReport {
  readonly status: IdentityContactDiscoveryStatus;
  readonly branchID: string;
  readonly primaryQuery: string;
  readonly fallbackQuery: string | null;
  readonly carrierReports: readonly IdentityContactSearchReport[];
  readonly observations: readonly IdentityContactObservation[];
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly message: string;
}

const maxClientIdentityPerPage = 10;
const maxClientIdentityPage = 10;
const maxClientIdentityObservations = 64;

export async function discoverClientIdentityContacts(request: ClientIdentityContactDiscoveryRequest): Promise<ClientIdentityContactDiscoveryReport> {
  const branchID = boundedBranchID(request.branchID);
  const primaryQuery = boundedQuery(request.primaryQuery);
  const fallbackQuery = request.fallbackQuery === null || request.fallbackQuery === undefined ? null : boundedQuery(request.fallbackQuery);
  const page = clampInteger(request.page ?? 1, 1, maxClientIdentityPage);
  const perPage = clampInteger(request.perPage ?? 5, 1, maxClientIdentityPerPage);
  const reports: IdentityContactSearchReport[] = [];

  const primaryReport = await runIdentityCarrierSearch(request.carrier, {
    query: primaryQuery,
    branchID,
    page,
    perPage,
    includeForks: request.includeForks ?? false,
    ...(request.signal === undefined ? {} : { signal: request.signal })
  });
  reports.push(primaryReport);

  const shouldRunFallback = (request.includeFallback ?? true) &&
    fallbackQuery !== null &&
    fallbackQuery !== primaryQuery &&
    !hasAcceptedIdentityObservation(primaryReport) &&
    primaryReport.status !== "rate_limited" &&
    primaryReport.status !== "aborted";

  if (shouldRunFallback) {
    reports.push(await runIdentityCarrierSearch(request.carrier, {
      query: fallbackQuery,
      branchID,
      page,
      perPage,
      includeForks: request.includeForks ?? false,
      ...(request.signal === undefined ? {} : { signal: request.signal })
    }));
  }

  const observations = dedupeIdentityObservations(reports.flatMap((report) => report.observations));
  const acceptedCount = observations.filter((observation) => observation.validation === "accepted").length;
  const rejectedCount = observations.filter((observation) => observation.validation === "rejected").length;
  const status = selectStatus(reports, acceptedCount);

  return {
    status,
    branchID,
    primaryQuery,
    fallbackQuery,
    carrierReports: reports,
    observations,
    acceptedCount,
    rejectedCount,
    message: `${String(acceptedCount)} accepted / ${String(rejectedCount)} rejected identity observations across ${String(reports.length)} ${request.carrier.id} search pass${reports.length === 1 ? "" : "es"}`
  };
}

async function runIdentityCarrierSearch(
  carrier: IdentityContactSearchCarrier,
  request: IdentityContactSearchRequest
): Promise<IdentityContactSearchReport> {
  try {
    return await carrier.search(request);
  } catch (error) {
    const aborted = request.signal?.aborted === true || isAbortError(error);
    return {
      carrier: carrier.id,
      status: aborted ? "aborted" : "failed",
      query: request.query,
      branchID: request.branchID,
      message: aborted ? "identity carrier search aborted" : errorMessage(error),
      observations: [],
      evidenceCount: 0,
      raw: null
    };
  }
}

function dedupeIdentityObservations(observations: readonly IdentityContactObservation[]): readonly IdentityContactObservation[] {
  const deduped: IdentityContactObservation[] = [];
  const seen = new Set<string>();
  for (const observation of observations) {
    const key = observation.validation === "accepted" &&
      observation.branchID !== null &&
      observation.sequence !== null
      ? `accepted:${observation.branchID}:${String(observation.sequence)}:${String(observation.expiresAt ?? 0)}:${observation.routeHints.map((hint) => hint.uri).join(",")}`
      : `candidate:${observation.evidence.carrier}:${observation.evidence.recordUrl}:${observation.wrapperPreview}:${observation.validation}:${observation.reason}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(observation);
    if (deduped.length >= maxClientIdentityObservations) {
      break;
    }
  }
  return deduped;
}

function hasAcceptedIdentityObservation(report: IdentityContactSearchReport): boolean {
  return report.observations.some((observation) => observation.validation === "accepted");
}

function selectStatus(reports: readonly IdentityContactSearchReport[], acceptedCount: number): IdentityContactDiscoveryStatus {
  if (acceptedCount > 0) {
    return reports.some((report) =>
      report.status === "failed" || report.status === "partial" || report.status === "rate_limited"
    )
      ? "partial"
      : "ok";
  }
  if (reports.some((report) => report.status === "rate_limited")) {
    return "rate_limited";
  }
  if (reports.some((report) => report.status === "aborted")) {
    return "aborted";
  }
  if (reports.some((report) => report.status === "failed")) {
    return "failed";
  }
  return "empty";
}

function boundedBranchID(branchID: string): string {
  const normalized = branchID.trim();
  parseBranchID(normalized);
  return normalized;
}

function boundedQuery(query: string): string {
  const normalized = query.trim();
  if (new TextEncoder().encode(normalized).byteLength > 256) {
    throw new Error("identity discovery query too large");
  }
  if (normalized === "") {
    throw new Error("identity discovery query is required");
  }
  return normalized;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 160) : "identity carrier search failed";
}
