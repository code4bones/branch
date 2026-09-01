import {
  decodeRibbonImage,
  type DecodeRibbonImageOptions,
  type DecodedRibbonWrapper
} from "../visual/ribbon-decode.js";
import type { RibbonImageData } from "../visual/ribbon-image.js";
import {
  ribbonDecodeWorkerScript,
  ribbonDecodeWorkerTimeoutMs,
  type RibbonDecodeWorkerRequest,
  type RibbonDecodeWorkerResponse
} from "./ribbon-decode-worker-protocol.js";

export type RibbonDecodeWorkerFactory = (url: string) => Worker;

let nextRequestId = 1;

export async function decodeRibbonImageWithWorker(
  image: RibbonImageData,
  options: DecodeRibbonImageOptions,
  workerFactory: RibbonDecodeWorkerFactory = createWorker
): Promise<DecodedRibbonWrapper> {
  let worker: Worker;
  try {
    worker = workerFactory(ribbonDecodeWorkerScript);
  } catch {
    return decodeRibbonImage(image, options);
  }

  const requestId = nextRequestId;
  nextRequestId += 1;

  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      resolve({ status: "decode worker timeout", wrapper: "" });
    }, ribbonDecodeWorkerTimeoutMs);

    const cleanup = () => {
      window.clearTimeout(timeout);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.terminate();
    };

    const onMessage = (event: MessageEvent<unknown>) => {
      const response = readWorkerResponse(event.data, requestId);
      if (response === null) {
        return;
      }

      cleanup();
      if (response.type === "decode-ribbon-image-error") {
        resolve({ status: response.error, wrapper: "" });
        return;
      }
      resolve(response.result);
    };

    const onError = () => {
      cleanup();
      resolve({ status: "decode worker failed", wrapper: "" });
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);

    const request: RibbonDecodeWorkerRequest = {
      type: "decode-ribbon-image",
      requestId,
      image: {
        width: image.width,
        height: image.height,
        data: makeTransferableBuffer(image.data)
      },
      options
    };
    worker.postMessage(request, [request.image.data]);
  });
}

function createWorker(url: string): Worker {
  return new Worker(url);
}

function readWorkerResponse(message: unknown, requestId: number): RibbonDecodeWorkerResponse | null {
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const response = message as Partial<RibbonDecodeWorkerResponse>;
  if (response.requestId !== requestId) {
    return null;
  }
  if (response.type === "decode-ribbon-image-error" && typeof response.error === "string") {
    return response as RibbonDecodeWorkerResponse;
  }
  if (response.type === "decode-ribbon-image-result" && isDecodedWrapper(response.result)) {
    return response as RibbonDecodeWorkerResponse;
  }
  return null;
}

function isDecodedWrapper(result: unknown): result is DecodedRibbonWrapper {
  if (typeof result !== "object" || result === null) {
    return false;
  }
  const candidate = result as Partial<DecodedRibbonWrapper>;
  return typeof candidate.status === "string" && typeof candidate.wrapper === "string";
}

function makeTransferableBuffer(data: Uint8ClampedArray): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8ClampedArray(buffer).set(data);
  return buffer;
}
