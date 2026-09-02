import type { RibbonImageData } from "./ribbon-image.js";

export interface CropEdges {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface ColorShift {
  readonly brightness?: number;
  readonly contrast?: number;
  readonly gamma?: number;
  readonly saturation?: number;
  readonly whiteBalance?: {
    readonly red: number;
    readonly green: number;
    readonly blue: number;
  };
}

export function resizeNearest(image: RibbonImageData, width: number, height: number): RibbonImageData {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("target dimensions must be positive integers");
  }

  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor((y * image.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor((x * image.width) / width));
      copyPixel(image.data, image.width, sourceX, sourceY, data, width, x, y);
    }
  }
  return { width, height, data };
}

export function centerCrop(image: RibbonImageData, width: number, height: number): RibbonImageData {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("crop dimensions must be positive integers");
  }
  if (width > image.width || height > image.height) {
    throw new Error("crop dimensions must fit source image");
  }

  const startX = Math.floor((image.width - width) / 2);
  const startY = Math.floor((image.height - height) / 2);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      copyPixel(image.data, image.width, startX + x, startY + y, data, width, x, y);
    }
  }
  return { width, height, data };
}

export function cropEdges(image: RibbonImageData, edges: CropEdges): RibbonImageData {
  const left = edgePixels(image.width, edges.left);
  const right = edgePixels(image.width, edges.right);
  const top = edgePixels(image.height, edges.top);
  const bottom = edgePixels(image.height, edges.bottom);
  const width = image.width - left - right;
  const height = image.height - top - bottom;
  if (width <= 0 || height <= 0) {
    throw new Error("edge crop removes the whole image");
  }

  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      copyPixel(image.data, image.width, left + x, top + y, data, width, x, y);
    }
  }
  return { width, height, data };
}

export function rotateRight(image: RibbonImageData, degrees: 90 | 180 | 270): RibbonImageData {
  if (degrees === 180) {
    const data = new Uint8ClampedArray(image.data.byteLength);
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        copyPixel(
          image.data,
          image.width,
          x,
          y,
          data,
          image.width,
          image.width - 1 - x,
          image.height - 1 - y
        );
      }
    }
    return { width: image.width, height: image.height, data };
  }

  const width = image.height;
  const height = image.width;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const targetX = degrees === 90 ? image.height - 1 - y : y;
      const targetY = degrees === 90 ? x : image.width - 1 - x;
      copyPixel(image.data, image.width, x, y, data, width, targetX, targetY);
    }
  }
  return { width, height, data };
}

export function applyColorShift(image: RibbonImageData, shift: ColorShift): RibbonImageData {
  const data = new Uint8ClampedArray(image.data);
  const brightness = shift.brightness ?? 0;
  const contrast = shift.contrast ?? 1;
  const gamma = shift.gamma ?? 1;
  const saturation = shift.saturation ?? 1;
  const whiteBalance = shift.whiteBalance ?? { red: 1, green: 1, blue: 1 };

  for (let offset = 0; offset < data.length; offset += 4) {
    let red = adjustChannel(data[offset] ?? 0, brightness, contrast, gamma) * whiteBalance.red;
    let green = adjustChannel(data[offset + 1] ?? 0, brightness, contrast, gamma) * whiteBalance.green;
    let blue = adjustChannel(data[offset + 2] ?? 0, brightness, contrast, gamma) * whiteBalance.blue;
    const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722;

    red = luma + (red - luma) * saturation;
    green = luma + (green - luma) * saturation;
    blue = luma + (blue - luma) * saturation;

    data[offset] = clampByte(red);
    data[offset + 1] = clampByte(green);
    data[offset + 2] = clampByte(blue);
  }

  return { width: image.width, height: image.height, data };
}

export function screenshotScale(image: RibbonImageData, displayScale: number): RibbonImageData {
  if (!Number.isFinite(displayScale) || displayScale <= 0) {
    throw new Error("display scale must be positive");
  }
  const downWidth = Math.max(1, Math.round(image.width / displayScale));
  const downHeight = Math.max(1, Math.round(image.height / displayScale));
  return resizeNearest(resizeNearest(image, downWidth, downHeight), image.width, image.height);
}

export function fitInsideWithPadding(
  image: RibbonImageData,
  width: number,
  height: number,
  background: readonly [number, number, number] = [255, 255, 255]
): RibbonImageData {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("target dimensions must be positive integers");
  }

  const scale = Math.min(width / image.width, height / image.height);
  const fitWidth = Math.max(1, Math.round(image.width * scale));
  const fitHeight = Math.max(1, Math.round(image.height * scale));
  const resized = resizeNearest(image, fitWidth, fitHeight);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = background[0];
    data[offset + 1] = background[1];
    data[offset + 2] = background[2];
    data[offset + 3] = 255;
  }

  const startX = Math.floor((width - fitWidth) / 2);
  const startY = Math.floor((height - fitHeight) / 2);
  for (let y = 0; y < fitHeight; y += 1) {
    for (let x = 0; x < fitWidth; x += 1) {
      copyPixel(resized.data, resized.width, x, y, data, width, startX + x, startY + y);
    }
  }
  return { width, height, data };
}

export function boxBlur(image: RibbonImageData, radius: number): RibbonImageData {
  if (!Number.isInteger(radius) || radius < 1 || radius > 4) {
    throw new Error("blur radius outside 1-4");
  }

  const data = new Uint8ClampedArray(image.data.length);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let count = 0;
      for (let sampleY = Math.max(0, y - radius); sampleY <= Math.min(image.height - 1, y + radius); sampleY += 1) {
        for (let sampleX = Math.max(0, x - radius); sampleX <= Math.min(image.width - 1, x + radius); sampleX += 1) {
          const offset = (sampleY * image.width + sampleX) * 4;
          red += image.data[offset] ?? 0;
          green += image.data[offset + 1] ?? 0;
          blue += image.data[offset + 2] ?? 0;
          alpha += image.data[offset + 3] ?? 255;
          count += 1;
        }
      }
      const target = (y * image.width + x) * 4;
      data[target] = clampByte(red / count);
      data[target + 1] = clampByte(green / count);
      data[target + 2] = clampByte(blue / count);
      data[target + 3] = clampByte(alpha / count);
    }
  }
  return { width: image.width, height: image.height, data };
}

export function sharpen(image: RibbonImageData): RibbonImageData {
  const data = new Uint8ClampedArray(image.data.length);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const target = (y * image.width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const center = readChannel(image, x, y, channel) * 5;
        const sharpened = center -
          readChannel(image, x - 1, y, channel) -
          readChannel(image, x + 1, y, channel) -
          readChannel(image, x, y - 1, channel) -
          readChannel(image, x, y + 1, channel);
        data[target + channel] = clampByte(sharpened);
      }
      data[target + 3] = image.data[target + 3] ?? 255;
    }
  }
  return { width: image.width, height: image.height, data };
}

export function mildCameraPerspective(image: RibbonImageData): RibbonImageData {
  const insetTop = Math.max(1, Math.round(image.width * 0.04));
  const data = new Uint8ClampedArray(image.width * image.height * 4);
  data.fill(255);
  for (let index = 3; index < data.length; index += 4) {
    data[index] = 255;
  }

  for (let y = 0; y < image.height; y += 1) {
    const progress = y / Math.max(1, image.height - 1);
    const leftInset = Math.round(insetTop * (1 - progress));
    const rightInset = leftInset;
    const rowWidth = Math.max(1, image.width - leftInset - rightInset);
    for (let x = 0; x < image.width; x += 1) {
      const mappedX = Math.round(leftInset + (x / Math.max(1, image.width - 1)) * (rowWidth - 1));
      copyPixel(image.data, image.width, x, y, data, image.width, mappedX, y);
    }
  }
  return data.length === image.data.length ? { width: image.width, height: image.height, data } : image;
}

function copyPixel(
  source: Uint8ClampedArray,
  sourceWidth: number,
  sourceX: number,
  sourceY: number,
  target: Uint8ClampedArray,
  targetWidth: number,
  targetX: number,
  targetY: number
): void {
  const sourceOffset = (sourceY * sourceWidth + sourceX) * 4;
  const targetOffset = (targetY * targetWidth + targetX) * 4;
  target[targetOffset] = source[sourceOffset] ?? 0;
  target[targetOffset + 1] = source[sourceOffset + 1] ?? 0;
  target[targetOffset + 2] = source[sourceOffset + 2] ?? 0;
  target[targetOffset + 3] = source[sourceOffset + 3] ?? 255;
}

function edgePixels(size: number, fraction: number): number {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 0.5) {
    throw new Error("edge fraction must be in [0, 0.5)");
  }
  return Math.floor(size * fraction);
}

function adjustChannel(value: number, brightness: number, contrast: number, gamma: number): number {
  const contrasted = (value - 128) * contrast + 128 + brightness;
  const normalized = clampByte(contrasted) / 255;
  return 255 * normalized ** (1 / gamma);
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function readChannel(image: RibbonImageData, x: number, y: number, channel: number): number {
  const boundedX = Math.max(0, Math.min(image.width - 1, x));
  const boundedY = Math.max(0, Math.min(image.height - 1, y));
  return image.data[(boundedY * image.width + boundedX) * 4 + channel] ?? 0;
}
