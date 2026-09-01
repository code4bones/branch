import type { DecodeRibbonImageOptions, DecodedRibbonWrapper } from "../visual/ribbon-decode.js";

export const ribbonDecodeWorkerScript = "/admin/ribbon-decode-worker.js";
export const ribbonDecodeWorkerTimeoutMs = 5000;

export interface RibbonDecodeWorkerImage {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayBuffer;
}

export interface RibbonDecodeWorkerRequest {
  readonly type: "decode-ribbon-image";
  readonly requestId: number;
  readonly image: RibbonDecodeWorkerImage;
  readonly options: DecodeRibbonImageOptions;
}

export interface RibbonDecodeWorkerSuccess {
  readonly type: "decode-ribbon-image-result";
  readonly requestId: number;
  readonly result: DecodedRibbonWrapper;
}

export interface RibbonDecodeWorkerFailure {
  readonly type: "decode-ribbon-image-error";
  readonly requestId: number;
  readonly error: string;
}

export type RibbonDecodeWorkerResponse = RibbonDecodeWorkerSuccess | RibbonDecodeWorkerFailure;

