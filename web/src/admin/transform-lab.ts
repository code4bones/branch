export type TransformLabPresetId =
  | "jpeg-95"
  | "jpeg-80"
  | "jpeg-60"
  | "webp-95"
  | "webp-80"
  | "webp-60"
  | "resize-75"
  | "resize-50"
  | "resize-75-jpeg-80"
  | "thumbnail-center-crop"
  | "thumbnail-fit-padding"
  | "rotate-90"
  | "rotate-180"
  | "color-shift"
  | "blur"
  | "sharpen"
  | "screenshot-scale-2"
  | "pinterest-like-simulation";

export type TransformOperationKind =
  | "recompress"
  | "resize"
  | "center-crop"
  | "fit-padding"
  | "rotate"
  | "color-shift"
  | "blur"
  | "sharpen"
  | "screenshot";

export type TransformOutputMime = "image/png" | "image/jpeg" | "image/webp";
export type TransformRunMode = "selected" | "matrix";
export type TransformResultStatus = "verified" | "exact-unverified" | "mismatch" | "rejected" | "unsupported" | "failed" | "cancelled";
export type SignatureValidationStatus = "verified" | "invalid" | "not_available";

export interface TransformOperation {
  readonly kind: TransformOperationKind;
  readonly label: string;
  readonly percent?: number;
  readonly mime?: TransformOutputMime;
  readonly quality?: number;
  readonly degrees?: 90 | 180 | 270;
  readonly radius?: number;
}

export interface TransformLabPreset {
  readonly id: TransformLabPresetId;
  readonly label: string;
  readonly operations: readonly TransformOperation[];
  readonly simulation: boolean;
}

export interface TransformImageSummary {
  readonly width: number;
  readonly height: number;
  readonly mime: TransformOutputMime | "image/unknown";
  readonly quality: number | null;
  readonly byteSize: number | null;
}

export interface TransformFoundRegion {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly source: "heuristic" | "locator";
}

export interface TransformLabResult {
  readonly presetId: TransformLabPresetId | "original";
  readonly presetLabel: string;
  readonly simulation: boolean;
  readonly input: TransformImageSummary;
  readonly output: TransformImageSummary;
  readonly operations: readonly string[];
  readonly decodeStatus: string;
  readonly status: TransformResultStatus;
  readonly recovered: boolean;
  readonly exactMatch: boolean;
  readonly wrapperSha256: string | null;
  readonly baselineSha256: string | null;
  readonly signatureValidation: SignatureValidationStatus;
  readonly correctedErrors: "not_available";
  readonly foundRegion: TransformFoundRegion | null;
  readonly locatorProfile: string | null;
  readonly durationMs: number;
  readonly failureReason: string | null;
}

export interface TransformLabReport {
  readonly format: "branch.transform-lab/0";
  readonly generatedAt: string;
  readonly resultCount: number;
  readonly results: readonly TransformLabResult[];
}

export interface TransformClassificationInput {
  readonly presetId: TransformLabResult["presetId"];
  readonly presetLabel: string;
  readonly simulation: boolean;
  readonly input: TransformImageSummary;
  readonly output: TransformImageSummary;
  readonly operations: readonly string[];
  readonly decodeStatus: string;
  readonly decodedWrapper: string;
  readonly wrapperSha256: string | null;
  readonly baselineSha256: string | null;
  readonly signatureValidation: SignatureValidationStatus;
  readonly foundRegion?: TransformFoundRegion | null;
  readonly locatorProfile?: string | null;
  readonly durationMs: number;
  readonly failureReason?: string;
}

export const maxTransformLabMatrixPresets = 18;

export const transformLabPresets: readonly TransformLabPreset[] = [
  {
    id: "jpeg-95",
    label: "JPEG 95",
    simulation: false,
    operations: [{ kind: "recompress", label: "JPEG quality 95", mime: "image/jpeg", quality: 0.95 }]
  },
  {
    id: "jpeg-80",
    label: "JPEG 80",
    simulation: false,
    operations: [{ kind: "recompress", label: "JPEG quality 80", mime: "image/jpeg", quality: 0.8 }]
  },
  {
    id: "jpeg-60",
    label: "JPEG 60",
    simulation: false,
    operations: [{ kind: "recompress", label: "JPEG quality 60", mime: "image/jpeg", quality: 0.6 }]
  },
  {
    id: "webp-95",
    label: "WebP 95",
    simulation: false,
    operations: [{ kind: "recompress", label: "WebP quality 95", mime: "image/webp", quality: 0.95 }]
  },
  {
    id: "webp-80",
    label: "WebP 80",
    simulation: false,
    operations: [{ kind: "recompress", label: "WebP quality 80", mime: "image/webp", quality: 0.8 }]
  },
  {
    id: "webp-60",
    label: "WebP 60",
    simulation: false,
    operations: [{ kind: "recompress", label: "WebP quality 60", mime: "image/webp", quality: 0.6 }]
  },
  {
    id: "resize-75",
    label: "Resize 75%",
    simulation: false,
    operations: [{ kind: "resize", label: "resize 75%", percent: 0.75 }]
  },
  {
    id: "resize-50",
    label: "Resize 50%",
    simulation: false,
    operations: [{ kind: "resize", label: "resize 50%", percent: 0.5 }]
  },
  {
    id: "resize-75-jpeg-80",
    label: "Resize 75% + JPEG 80",
    simulation: false,
    operations: [
      { kind: "resize", label: "resize 75%", percent: 0.75 },
      { kind: "recompress", label: "JPEG quality 80", mime: "image/jpeg", quality: 0.8 }
    ]
  },
  {
    id: "thumbnail-center-crop",
    label: "Thumbnail crop",
    simulation: false,
    operations: [{ kind: "center-crop", label: "center crop 80%", percent: 0.8 }]
  },
  {
    id: "thumbnail-fit-padding",
    label: "Thumbnail padding",
    simulation: false,
    operations: [{ kind: "fit-padding", label: "fit with padding 75%", percent: 0.75 }]
  },
  {
    id: "rotate-90",
    label: "Rotate 90",
    simulation: false,
    operations: [{ kind: "rotate", label: "rotate 90", degrees: 90 }]
  },
  {
    id: "rotate-180",
    label: "Rotate 180",
    simulation: false,
    operations: [{ kind: "rotate", label: "rotate 180", degrees: 180 }]
  },
  {
    id: "color-shift",
    label: "Color shift",
    simulation: false,
    operations: [{ kind: "color-shift", label: "brightness/contrast/gamma shift" }]
  },
  {
    id: "blur",
    label: "Blur",
    simulation: false,
    operations: [{ kind: "blur", label: "box blur radius 1", radius: 1 }]
  },
  {
    id: "sharpen",
    label: "Sharpen",
    simulation: false,
    operations: [{ kind: "sharpen", label: "sharpen kernel" }]
  },
  {
    id: "screenshot-scale-2",
    label: "Screenshot scale",
    simulation: false,
    operations: [{ kind: "screenshot", label: "screenshot scale 2", percent: 2 }]
  },
  {
    id: "pinterest-like-simulation",
    label: "Pinterest-like simulation",
    simulation: true,
    operations: [
      { kind: "resize", label: "service resize 75%", percent: 0.75 },
      { kind: "recompress", label: "JPEG quality 85", mime: "image/jpeg", quality: 0.85 }
    ]
  }
] as const;

export function findTransformLabPreset(id: string): TransformLabPreset {
  const preset = transformLabPresets.find((candidate) => candidate.id === id);
  if (preset !== undefined) {
    return preset;
  }
  const fallback = transformLabPresets[1];
  if (fallback === undefined) {
    throw new Error("transform lab presets unavailable");
  }
  return fallback;
}

export function selectTransformLabPresets(mode: TransformRunMode, selectedId: string): readonly TransformLabPreset[] {
  if (mode === "selected") {
    return [findTransformLabPreset(selectedId)];
  }
  return transformLabPresets.slice(0, maxTransformLabMatrixPresets);
}

export function classifyTransformLabResult(input: TransformClassificationInput): TransformLabResult {
  const recovered = input.decodedWrapper !== "";
  const exactMatch = recovered &&
    input.wrapperSha256 !== null &&
    input.baselineSha256 !== null &&
    input.wrapperSha256 === input.baselineSha256;
  const status = classifyStatus(recovered, exactMatch, input.signatureValidation, input.failureReason);

  return {
    presetId: input.presetId,
    presetLabel: input.presetLabel,
    simulation: input.simulation,
    input: input.input,
    output: input.output,
    operations: input.operations,
    decodeStatus: input.decodeStatus,
    status,
    recovered,
    exactMatch,
    wrapperSha256: input.wrapperSha256,
    baselineSha256: input.baselineSha256,
    signatureValidation: input.signatureValidation,
    correctedErrors: "not_available",
    foundRegion: input.foundRegion ?? null,
    locatorProfile: input.locatorProfile ?? null,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    failureReason: input.failureReason ?? null
  };
}

export function makeFailedTransformLabResult(
  preset: Pick<TransformLabPreset, "id" | "label" | "simulation" | "operations">,
  input: TransformImageSummary,
  status: "unsupported" | "failed" | "cancelled",
  durationMs: number,
  failureReason: string
): TransformLabResult {
  return {
    presetId: preset.id,
    presetLabel: preset.label,
    simulation: preset.simulation,
    input,
    output: input,
    operations: preset.operations.map((operation) => operation.label),
    decodeStatus: status,
    status,
    recovered: false,
    exactMatch: false,
    wrapperSha256: null,
    baselineSha256: null,
    signatureValidation: "not_available",
    correctedErrors: "not_available",
    foundRegion: null,
    locatorProfile: null,
    durationMs: Math.max(0, Math.round(durationMs)),
    failureReason
  };
}

export function makeTransformLabReport(results: readonly TransformLabResult[], generatedAt = new Date().toISOString()): TransformLabReport {
  return {
    format: "branch.transform-lab/0",
    generatedAt,
    resultCount: results.length,
    results
  };
}

export function makeTransformLabJson(results: readonly TransformLabResult[], generatedAt?: string): string {
  return `${JSON.stringify(makeTransformLabReport(results, generatedAt), null, 2)}\n`;
}

function classifyStatus(
  recovered: boolean,
  exactMatch: boolean,
  signatureValidation: SignatureValidationStatus,
  failureReason: string | undefined
): TransformResultStatus {
  if (failureReason !== undefined) {
    return "failed";
  }
  if (!recovered) {
    return "rejected";
  }
  if (!exactMatch) {
    return "mismatch";
  }
  return signatureValidation === "verified" ? "verified" : "exact-unverified";
}
