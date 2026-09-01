import { decodeRibbonImage } from "../visual/ribbon-decode.js";
import type { DecodeRibbonImageOptions } from "../visual/ribbon-decode.js";
import type { RibbonImageData } from "../visual/ribbon-image.js";
import type {
  RibbonDecodeWorkerFailure,
  RibbonDecodeWorkerImage,
  RibbonDecodeWorkerRequest,
  RibbonDecodeWorkerResponse,
  RibbonDecodeWorkerSuccess
} from "./ribbon-decode-worker-protocol.js";

interface RibbonDecodeWorkerGlobal {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: RibbonDecodeWorkerResponse): void;
}

const workerSelf = readWorkerSelf();
if (workerSelf !== null) {
  workerSelf.onmessage = (event: MessageEvent<unknown>) => {
    const response = handleWorkerMessage(event.data);
    workerSelf.postMessage(response);
  };
}

export function handleWorkerMessage(message: unknown): RibbonDecodeWorkerResponse {
  if (!isDecodeRequest(message)) {
    return makeFailure(0, "invalid worker request");
  }

  const image = makeImageData(message.image);
  if (image === null) {
    return makeFailure(message.requestId, "invalid decode image");
  }

  try {
    return makeSuccess(message.requestId, decodeRibbonImage(image, message.options));
  } catch {
    return makeFailure(message.requestId, "decode failed");
  }
}

function isDecodeRequest(message: unknown): message is RibbonDecodeWorkerRequest {
  if (!isRecord(message)) {
    return false;
  }
  const requestId = message["requestId"];
  return message["type"] === "decode-ribbon-image" &&
    typeof requestId === "number" &&
    Number.isSafeInteger(requestId) &&
    requestId > 0 &&
    isWorkerImage(message["image"]) &&
    isDecodeOptions(message["options"]);
}

function isWorkerImage(image: unknown): image is RibbonDecodeWorkerImage {
  if (!isRecord(image)) {
    return false;
  }
  const width = image["width"];
  const height = image["height"];
  return typeof width === "number" &&
    typeof height === "number" &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    image["data"] instanceof ArrayBuffer;
}

function isDecodeOptions(options: unknown): options is DecodeRibbonImageOptions {
  if (!isRecord(options)) {
    return false;
  }
  return isOptionalNumber(options["maxInputPixels"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

function readWorkerSelf(): RibbonDecodeWorkerGlobal | null {
  if (typeof self === "undefined") {
    return null;
  }
  const candidate = self as unknown as Partial<RibbonDecodeWorkerGlobal>;
  return typeof candidate.postMessage === "function" ? candidate as RibbonDecodeWorkerGlobal : null;
}

function makeImageData(image: RibbonDecodeWorkerImage): RibbonImageData | null {
  const expectedBytes = image.width * image.height * 4;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || image.data.byteLength !== expectedBytes) {
    return null;
  }
  return {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data)
  };
}

function makeSuccess(requestId: number, result: RibbonDecodeWorkerSuccess["result"]): RibbonDecodeWorkerSuccess {
  return {
    type: "decode-ribbon-image-result",
    requestId,
    result
  };
}

function makeFailure(requestId: number, error: string): RibbonDecodeWorkerFailure {
  return {
    type: "decode-ribbon-image-error",
    requestId,
    error
  };
}
