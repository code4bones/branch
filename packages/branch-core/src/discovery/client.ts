export type ClientDiscoveryStatus = "ok" | "empty" | "partial" | "failed" | "rate_limited" | "aborted";
export type BeaconObservationValidation = "accepted" | "rejected";

export interface SearchCarrier {
  readonly id: string;
  readonly search: (request: SearchCarrierSearchRequest) => Promise<SearchCarrierSearchReport>;
}

export interface SearchCarrierSearchRequest {
  readonly query: string;
  readonly page: number;
  readonly perPage: number;
  readonly includeForks?: boolean;
  readonly signal?: AbortSignal;
}

export interface CarrierEvidence {
  readonly carrier: string;
  readonly query: string;
  readonly source: string;
  readonly sourceUrl: string;
  readonly recordUrl: string;
}

export interface BeaconObservation {
  readonly observationId: string;
  readonly validation: BeaconObservationValidation;
  readonly reason: string;
  readonly wrapperPreview: string;
  readonly evidence: CarrierEvidence;
  readonly expiresAt: number | null;
  readonly relayEndpoint: string | null;
  readonly profileMultihash: string | null;
  readonly senderPublicKey: string | null;
  readonly beaconId: string | null;
  readonly sequence: number | null;
}

export interface SearchCarrierSearchReport {
  readonly carrier: string;
  readonly status: ClientDiscoveryStatus;
  readonly query: string;
  readonly message: string;
  readonly observations: readonly BeaconObservation[];
  readonly evidenceCount: number;
  readonly raw: unknown;
}

export interface ClientDiscoveryRequest {
  readonly carrier: SearchCarrier;
  readonly primaryQuery: string;
  readonly fallbackQuery?: string | null;
  readonly includeFallback?: boolean;
  readonly includeForks?: boolean;
  readonly page?: number;
  readonly perPage?: number;
  readonly signal?: AbortSignal;
}

export interface ClientDiscoveryReport {
  readonly status: ClientDiscoveryStatus;
  readonly primaryQuery: string;
  readonly fallbackQuery: string | null;
  readonly carrierReports: readonly SearchCarrierSearchReport[];
  readonly observations: readonly BeaconObservation[];
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly message: string;
}

const maxClientDiscoveryPerPage = 10;
const maxClientDiscoveryPage = 10;
const maxClientDiscoveryObservations = 64;

export async function discoverClientBootstrapBeacons(request: ClientDiscoveryRequest): Promise<ClientDiscoveryReport> {
  const primaryQuery = boundedQuery(request.primaryQuery);
  const fallbackQuery = request.fallbackQuery === null || request.fallbackQuery === undefined ? null : boundedQuery(request.fallbackQuery);
  const page = clampInteger(request.page ?? 1, 1, maxClientDiscoveryPage);
  const perPage = clampInteger(request.perPage ?? 5, 1, maxClientDiscoveryPerPage);
  const reports: SearchCarrierSearchReport[] = [];

  const primarySearchRequest = {
    query: primaryQuery,
    page,
    perPage,
    includeForks: request.includeForks ?? false,
    ...(request.signal === undefined ? {} : { signal: request.signal })
  };
  const primaryReport = await runCarrierSearch(request.carrier, primarySearchRequest);
  reports.push(primaryReport);

  const shouldRunFallback = (request.includeFallback ?? true) &&
    fallbackQuery !== null &&
    fallbackQuery !== primaryQuery &&
    !hasAcceptedObservation(primaryReport) &&
    primaryReport.status !== "rate_limited" &&
    primaryReport.status !== "aborted";

  if (shouldRunFallback) {
    reports.push(await runCarrierSearch(request.carrier, {
      query: fallbackQuery,
      page,
      perPage,
      includeForks: request.includeForks ?? false,
      ...(request.signal === undefined ? {} : { signal: request.signal })
    }));
  }

  const observations = dedupeObservations(reports.flatMap((report) => report.observations));
  const acceptedCount = observations.filter((observation) => observation.validation === "accepted").length;
  const rejectedCount = observations.filter((observation) => observation.validation === "rejected").length;
  const status = selectStatus(reports, acceptedCount);

  return {
    status,
    primaryQuery,
    fallbackQuery,
    carrierReports: reports,
    observations,
    acceptedCount,
    rejectedCount,
    message: `${String(acceptedCount)} accepted / ${String(rejectedCount)} rejected beacon observations across ${String(reports.length)} ${request.carrier.id} search pass${reports.length === 1 ? "" : "es"}`
  };
}

async function runCarrierSearch(carrier: SearchCarrier, request: SearchCarrierSearchRequest): Promise<SearchCarrierSearchReport> {
  try {
    return await carrier.search(request);
  } catch (error) {
    const aborted = request.signal?.aborted === true || isAbortError(error);
    return {
      carrier: carrier.id,
      status: aborted ? "aborted" : "failed",
      query: request.query,
      message: aborted ? "carrier search aborted" : errorMessage(error),
      observations: [],
      evidenceCount: 0,
      raw: null
    };
  }
}

function dedupeObservations(observations: readonly BeaconObservation[]): readonly BeaconObservation[] {
  const deduped: BeaconObservation[] = [];
  const seen = new Set<string>();
  for (const observation of observations) {
    const key = observation.validation === "accepted" &&
      observation.senderPublicKey !== null &&
      observation.beaconId !== null &&
      observation.sequence !== null
      ? `accepted:${observation.senderPublicKey}:${observation.beaconId}:${String(observation.sequence)}`
      : `candidate:${observation.evidence.carrier}:${observation.evidence.recordUrl}:${observation.wrapperPreview}:${observation.validation}:${observation.reason}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(observation);
    if (deduped.length >= maxClientDiscoveryObservations) {
      break;
    }
  }
  return deduped;
}

function hasAcceptedObservation(report: SearchCarrierSearchReport): boolean {
  return report.observations.some((observation) => observation.validation === "accepted");
}

function selectStatus(reports: readonly SearchCarrierSearchReport[], acceptedCount: number): ClientDiscoveryStatus {
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

function boundedQuery(query: string): string {
  const normalized = query.trim();
  if (new TextEncoder().encode(normalized).byteLength > 256) {
    throw new Error("client discovery query too large");
  }
  if (normalized === "") {
    throw new Error("client discovery query is required");
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
  return error instanceof Error ? error.message.slice(0, 160) : "carrier search failed";
}
