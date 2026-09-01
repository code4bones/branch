import type { RibbonImageData } from "./ribbon-image.js";

export interface LoadedBrowserImage {
  readonly image: HTMLImageElement;
  readonly width: number;
  readonly height: number;
}

export function loadLocalImage(file: File, label = "cover image"): Promise<LoadedBrowserImage> {
  if (!file.type.startsWith("image/")) {
    return Promise.reject(new Error(`${label} must be an image`));
  }
  if (file.size > 20 * 1024 * 1024) {
    return Promise.reject(new Error(`${label} too large`));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error(`${label} read failed`));
        return;
      }

      const image = new Image();
      image.onload = () => {
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (width <= 0 || height <= 0 || width * height > 4096 * 4096) {
          reject(new Error(`${label} dimensions outside bounds`));
          return;
        }
        resolve({ image, width, height });
      };
      image.onerror = () => { reject(new Error(`${label} failed`)); };
      image.src = reader.result;
    };
    reader.onerror = () => { reject(new Error(`${label} read failed`)); };
    reader.readAsDataURL(file);
  });
}

export function imageToData(loaded: LoadedBrowserImage): RibbonImageData {
  const canvas = document.createElement("canvas");
  canvas.width = loaded.width;
  canvas.height = loaded.height;
  const context = canvasContext(canvas);
  context.drawImage(loaded.image, 0, 0, loaded.width, loaded.height);
  return {
    width: loaded.width,
    height: loaded.height,
    data: context.getImageData(0, 0, loaded.width, loaded.height).data
  };
}

export function canvasToImageData(canvas: HTMLCanvasElement): RibbonImageData {
  const context = canvasContext(canvas);
  return {
    width: canvas.width,
    height: canvas.height,
    data: context.getImageData(0, 0, canvas.width, canvas.height).data
  };
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error("png export failed"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

export function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("canvas unavailable");
  }
  return context;
}
