export type RibbonPlacement = "center" | "bottom-right" | "bottom-left" | "top-right" | "top-left";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export function computePlacement(
  placement: RibbonPlacement,
  outputWidth: number,
  outputHeight: number,
  symbolSize: number
): Point {
  const margin = Math.max(24, Math.round(Math.min(outputWidth, outputHeight) * 0.04));
  const positions: Record<RibbonPlacement, Point> = {
    center: {
      x: Math.round((outputWidth - symbolSize) / 2),
      y: Math.round((outputHeight - symbolSize) / 2)
    },
    "bottom-right": {
      x: outputWidth - symbolSize - margin,
      y: outputHeight - symbolSize - margin
    },
    "bottom-left": {
      x: margin,
      y: outputHeight - symbolSize - margin
    },
    "top-right": {
      x: outputWidth - symbolSize - margin,
      y: margin
    },
    "top-left": {
      x: margin,
      y: margin
    }
  };
  const position = positions[placement];
  return {
    x: clamp(position.x, 0, outputWidth - symbolSize),
    y: clamp(position.y, 0, outputHeight - symbolSize)
  };
}

export function computeModulePitch(moduleCount: number, quietZone: number, carrierSize: number): number {
  const pitch = Math.floor(carrierSize / (moduleCount + quietZone * 2));
  if (pitch < 4) {
    throw new Error("carrier size too small");
  }
  return pitch;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
