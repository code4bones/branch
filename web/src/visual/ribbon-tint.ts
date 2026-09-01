import type { Point } from "./geometry.js";
import type { RibbonImageData } from "./ribbon-image.js";
import type { QRModules } from "./ribbon-render.js";

export function drawTintQR(
  context: CanvasRenderingContext2D,
  modules: QRModules,
  x: number,
  y: number,
  modulePitch: number,
  quietZone: number,
  tintStrength: number
): void {
  const moduleCount = modules.size;
  const size = (moduleCount + quietZone * 2) * modulePitch;
  const image = context.getImageData(x, y, size, size);
  const data = image.data;

  for (let pixelY = 0; pixelY < size; pixelY += 1) {
    for (let pixelX = 0; pixelX < size; pixelX += 1) {
      const moduleX = Math.floor(pixelX / modulePitch) - quietZone;
      const moduleY = Math.floor(pixelY / modulePitch) - quietZone;
      if (moduleX < 0 || moduleY < 0 || moduleX >= moduleCount || moduleY >= moduleCount) {
        continue;
      }

      const offset = (pixelY * size + pixelX) * 4;
      const dark = Boolean(modules.get(moduleX, moduleY));
      if (dark) {
        data[offset + 2] = (data[offset + 2] ?? 0) | 1;
        if (tintStrength === 0) {
          continue;
        }
        data[offset] = clampByte((data[offset] ?? 0) - Math.round(tintStrength * 0.55));
        data[offset + 1] = clampByte((data[offset + 1] ?? 0) - Math.round(tintStrength * 0.35));
        data[offset + 2] = clampByte((data[offset + 2] ?? 0) + tintStrength) | 1;
        continue;
      }

      data[offset + 2] = (data[offset + 2] ?? 0) & 0xfe;
      if (tintStrength === 0) {
        continue;
      }
      data[offset] = clampByte((data[offset] ?? 0) + Math.round(tintStrength * 0.18));
      data[offset + 1] = clampByte((data[offset + 1] ?? 0) + Math.round(tintStrength * 0.12));
      data[offset + 2] = clampByte((data[offset + 2] ?? 0) - Math.round(tintStrength * 0.2)) & 0xfe;
    }
  }

  context.putImageData(image, x, y);
}

export function extractStegoTintCandidates(
  image: RibbonImageData,
  placement: Point,
  moduleCount: number,
  modulePitch: number,
  quietZone: number
): readonly RibbonImageData[] {
  const bits = sampleTintStegoBits(image, placement, moduleCount, modulePitch, quietZone);
  return [renderBitQR(bits, moduleCount, false), renderBitQR(bits, moduleCount, true)];
}

export function extractChromaTintCandidates(
  image: RibbonImageData,
  placement: Point,
  moduleCount: number,
  modulePitch: number,
  quietZone: number
): readonly RibbonImageData[] {
  const scores = sampleTintModules(image, placement, moduleCount, modulePitch, quietZone);
  const sorted = [...scores].sort((left, right) => left - right);
  const thresholds = [0.42, 0.5, 0.58].map((quantile) => sorted[Math.floor(sorted.length * quantile)] ?? 0);
  return thresholds.flatMap((threshold) => [
    renderBitQR(
      scores.map((score) => score > threshold),
      moduleCount,
      false
    ),
    renderBitQR(
      scores.map((score) => score > threshold),
      moduleCount,
      true
    )
  ]);
}

export function renderBitQR(bits: readonly boolean[], moduleCount: number, invert: boolean): RibbonImageData {
  const renderPitch = 8;
  const renderQuietZone = 4;
  const width = (moduleCount + renderQuietZone * 2) * renderPitch;
  const data = new Uint8ClampedArray(width * width * 4);
  data.fill(255);
  for (let index = 3; index < data.length; index += 4) {
    data[index] = 255;
  }

  for (let moduleY = 0; moduleY < moduleCount; moduleY += 1) {
    for (let moduleX = 0; moduleX < moduleCount; moduleX += 1) {
      const index = moduleY * moduleCount + moduleX;
      let dark = bits[index] ?? false;
      if (invert) {
        dark = !dark;
      }
      if (!dark) {
        continue;
      }
      fillExtractedModule(data, width, moduleX + renderQuietZone, moduleY + renderQuietZone, renderPitch);
    }
  }
  return { width, height: width, data };
}

function sampleTintStegoBits(
  image: RibbonImageData,
  placement: Point,
  moduleCount: number,
  modulePitch: number,
  quietZone: number
): readonly boolean[] {
  const bits: boolean[] = [];
  const margin = Math.max(0, Math.floor(modulePitch * 0.2));
  for (let moduleY = 0; moduleY < moduleCount; moduleY += 1) {
    for (let moduleX = 0; moduleX < moduleCount; moduleX += 1) {
      let ones = 0;
      let count = 0;
      const startX = placement.x + (moduleX + quietZone) * modulePitch + margin;
      const startY = placement.y + (moduleY + quietZone) * modulePitch + margin;
      const endX = placement.x + (moduleX + quietZone + 1) * modulePitch - margin;
      const endY = placement.y + (moduleY + quietZone + 1) * modulePitch - margin;
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const offset = (y * image.width + x) * 4;
          ones += (image.data[offset + 2] ?? 0) & 1;
          count += 1;
        }
      }
      bits.push(count > 0 && ones / count >= 0.5);
    }
  }
  return bits;
}

function sampleTintModules(
  image: RibbonImageData,
  placement: Point,
  moduleCount: number,
  modulePitch: number,
  quietZone: number
): readonly number[] {
  const scores: number[] = [];
  const margin = Math.max(0, Math.floor(modulePitch * 0.2));
  for (let moduleY = 0; moduleY < moduleCount; moduleY += 1) {
    for (let moduleX = 0; moduleX < moduleCount; moduleX += 1) {
      let total = 0;
      let count = 0;
      const startX = placement.x + (moduleX + quietZone) * modulePitch + margin;
      const startY = placement.y + (moduleY + quietZone) * modulePitch + margin;
      const endX = placement.x + (moduleX + quietZone + 1) * modulePitch - margin;
      const endY = placement.y + (moduleY + quietZone + 1) * modulePitch - margin;
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const offset = (y * image.width + x) * 4;
          const red = image.data[offset] ?? 0;
          const green = image.data[offset + 1] ?? 0;
          const blue = image.data[offset + 2] ?? 0;
          total += blue - (red + green) / 2;
          count += 1;
        }
      }
      scores.push(count === 0 ? 0 : total / count);
    }
  }
  return scores;
}

function fillExtractedModule(
  data: Uint8ClampedArray,
  width: number,
  moduleX: number,
  moduleY: number,
  modulePitch: number
): void {
  const startX = moduleX * modulePitch;
  const startY = moduleY * modulePitch;
  for (let y = startY; y < startY + modulePitch; y += 1) {
    for (let x = startX; x < startX + modulePitch; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      data[offset + 3] = 255;
    }
  }
}

function clampByte(value: number): number {
  return Math.min(Math.max(Math.round(value), 0), 255);
}
