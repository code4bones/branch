import { useEffect, useRef } from "react";

import { downloadURL } from "../browser-files.js";
import { ribbonPngFilename } from "../defaults.js";
import { createDiagnostics, useAdminStore, type DiagnosticsState, type RibbonFormState, type RibbonTab } from "../store.js";
import {
  canvasToImageData,
  canvasToPngBlob,
  imageToData,
  loadLocalImage,
  type LoadedBrowserImage
} from "../../visual/canvas-image.js";
import { clamp } from "../../visual/geometry.js";
import type { DecodeRibbonImageOptions } from "../../visual/ribbon-decode.js";
import { decodeRibbonImageWithWorker } from "../ribbon-decode-client.js";
import {
  drawCoverPreview,
  drawIdleCanvas,
  generateRibbonSymbol,
  renderRibbonImage,
  type GeneratedRibbonSymbol
} from "../../visual/ribbon-render.js";
import { DiagnosticsView } from "./DiagnosticsView.js";

type SetRibbonField = <K extends keyof RibbonFormState>(field: K, value: RibbonFormState[K]) => void;

export function RibbonTool(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const decodeFileRef = useRef<HTMLInputElement | null>(null);
  const ribbonTab = useAdminStore((state) => state.ribbonTab);
  const ribbon = useAdminStore((state) => state.ribbon);
  const cover = useAdminStore((state) => state.cover);
  const ribbonPngUrl = useAdminStore((state) => state.ribbonPngUrl);
  const decodedWrapper = useAdminStore((state) => state.decodedWrapper);
  const setRibbonTab = useAdminStore((state) => state.setRibbonTab);
  const setRibbonField = useAdminStore((state) => state.setRibbonField);
  const setCover = useAdminStore((state) => state.setCover);
  const setRibbonPngUrl = useAdminStore((state) => state.setRibbonPngUrl);
  const setDecodedWrapper = useAdminStore((state) => state.setDecodedWrapper);
  const setDiagnostics = useAdminStore((state) => state.setDiagnostics);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas !== null) {
      drawIdleCanvas(canvas);
    }
  }, []);

  function replaceRibbonPngUrl(url: string): void {
    if (ribbonPngUrl !== "") {
      URL.revokeObjectURL(ribbonPngUrl);
    }
    setRibbonPngUrl(url);
  }

  async function onCoverChange(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    if (file === undefined) {
      setCover(null);
      replaceRibbonPngUrl("");
      drawIdle();
      setDiagnostics(createDiagnostics("idle", "status-warn"));
      return;
    }

    try {
      const loaded = await loadLocalImage(file);
      const outputWidth = clamp(Math.max(readOptionalInteger(ribbon.outputWidth, 1000), loaded.width), 640, 4096);
      const outputHeight = clamp(Math.max(readOptionalInteger(ribbon.outputHeight, 1500), loaded.height), 640, 4096);
      const carrierSize = fitCarrierSize(ribbon.carrierSize, outputWidth, outputHeight);
      setCover({ image: loaded, filename: file.name });
      setRibbonField("outputWidth", String(outputWidth));
      setRibbonField("outputHeight", String(outputHeight));
      setRibbonField("carrierSize", String(carrierSize));
      replaceRibbonPngUrl("");
      drawCover(loaded, outputWidth, outputHeight);
      setDiagnostics(createDiagnostics("cover loaded", "status-good", { canvas: `${String(outputWidth)}x${String(outputHeight)}` }));
    } catch {
      setCover(null);
      replaceRibbonPngUrl("");
      drawIdle();
      setDiagnostics(createDiagnostics("cover image failed", "status-bad"));
    }
  }

  async function onGenerate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const canvas = requireCanvas();
    try {
      const quietZone = readBoundedInteger(ribbon.quietZone, 4, 12, "quiet zone");
      const outputWidth = readBoundedInteger(ribbon.outputWidth, 640, 4096, "output width");
      const outputHeight = readBoundedInteger(ribbon.outputHeight, 640, 4096, "output height");
      const carrierSize = fitCarrierSize(ribbon.carrierSize, outputWidth, outputHeight);
      setRibbonField("carrierSize", String(carrierSize));
      const symbol = generateRibbonSymbol(ribbon.wrapper.trim(), quietZone, carrierSize);
      renderRibbonImage(canvas, symbol, {
        outputWidth,
        outputHeight,
        carrierSize,
        visualMode: ribbon.visualMode,
        tintStrength: readBoundedInteger(ribbon.tintStrength, 0, 24, "tint strength"),
        placement: ribbon.placement,
        coverImage: cover?.image ?? null
      });
      setDiagnostics(diagnosticsFromSymbol(symbol, ribbon.visualMode, canvas, "generated", "status-good"));

      replaceRibbonPngUrl("");
      const blob = await canvasToPngBlob(canvas);
      replaceRibbonPngUrl(URL.createObjectURL(blob));
    } catch (error) {
      replaceRibbonPngUrl("");
      preserveCoverPreviewOnError();
      setDiagnostics(createDiagnostics(error instanceof Error ? error.message : "generation failed", "status-bad", { mode: ribbon.visualMode }));
    }
  }

  async function onDecode(): Promise<void> {
    try {
      const image = await loadDecodeImage();
      const carrierSize = fitCarrierSize(ribbon.carrierSize, image.width, image.height);
      const quietZone = readBoundedInteger(ribbon.quietZone, 4, 12, "quiet zone");
      setRibbonField("carrierSize", String(carrierSize));
      const preferredVersion = readPreferredVersion(ribbon.wrapper, quietZone, carrierSize);
      const decodeOptions: DecodeRibbonImageOptions = {
        quietZone,
        carrierSize,
        placement: ribbon.placement
      };
      const result = await decodeRibbonImageWithWorker(
        image,
        preferredVersion === undefined ? decodeOptions : { ...decodeOptions, preferredVersion }
      );
      setDecodedWrapper(result.wrapper);
      setDiagnostics(createDiagnostics(result.status, result.wrapper === "" ? "status-bad" : "status-good", {
        mode: ribbon.visualMode,
        canvas: `${String(image.width)}x${String(image.height)}`
      }));
    } catch (error) {
      setDecodedWrapper("");
      setDiagnostics(createDiagnostics(error instanceof Error ? error.message : "decode failed", "status-bad", { mode: ribbon.visualMode }));
    }
  }

  async function loadDecodeImage() {
    const file = decodeFileRef.current?.files?.[0];
    if (file === undefined) {
      return canvasToImageData(requireCanvas());
    }
    return imageToData(await loadLocalImage(file, "decode image"));
  }

  function preserveCoverPreviewOnError(): void {
    if (cover === null) {
      drawIdle();
      return;
    }
    const outputWidth = clamp(readOptionalInteger(ribbon.outputWidth, requireCanvas().width || 1000), 640, 4096);
    const outputHeight = clamp(readOptionalInteger(ribbon.outputHeight, requireCanvas().height || 1500), 640, 4096);
    drawCover(cover.image, outputWidth, outputHeight);
  }

  function drawIdle(): void {
    drawIdleCanvas(requireCanvas());
  }

  function drawCover(image: LoadedBrowserImage, outputWidth: number, outputHeight: number): void {
    drawCoverPreview(requireCanvas(), image, outputWidth, outputHeight);
  }

  function requireCanvas(): HTMLCanvasElement {
    const canvas = canvasRef.current;
    if (canvas === null) {
      throw new Error("canvas unavailable");
    }
    return canvas;
  }

  return (
    <section className="tool-grid is-active ribbon-tool" data-panel="ribbon" aria-label="Ribbon Image generator">
      <div className="ribbon-control-stack">
        <RibbonWorkflowTabs activeTab={ribbonTab} onTabChange={setRibbonTab} />
        {ribbonTab === "encode" ? (
          <RibbonEncodePanel
            ribbon={ribbon}
            ribbonPngUrl={ribbonPngUrl}
            setRibbonField={setRibbonField}
            onCoverChange={onCoverChange}
            onGenerate={onGenerate}
          />
        ) : (
          <RibbonDecodePanel
            decodeFileRef={decodeFileRef}
            decodedWrapper={decodedWrapper}
            ribbon={ribbon}
            setRibbonField={setRibbonField}
            onDecode={onDecode}
          />
        )}
      </div>

      <section className="panel preview-panel" aria-label="Ribbon Image preview">
        <canvas id="ribbon-canvas" ref={canvasRef} width="640" height="640" />
        <DiagnosticsView />
      </section>
    </section>
  );
}

function RibbonWorkflowTabs(
  { activeTab, onTabChange }: {
    readonly activeTab: RibbonTab;
    readonly onTabChange: (tab: RibbonTab) => void;
  }
): React.JSX.Element {
  return (
    <div className="ribbon-tabs" role="tablist" aria-label="Ribbon Image workflow">
      <button
        type="button"
        className={`tab${activeTab === "encode" ? " is-active" : ""}`}
        id="ribbon-tab-encode"
        role="tab"
        aria-selected={activeTab === "encode"}
        aria-controls="ribbon-panel-encode"
        onClick={() => { onTabChange("encode"); }}
      >
        Encode
      </button>
      <button
        type="button"
        className={`tab${activeTab === "decode" ? " is-active" : ""}`}
        id="ribbon-tab-decode"
        role="tab"
        aria-selected={activeTab === "decode"}
        aria-controls="ribbon-panel-decode"
        onClick={() => { onTabChange("decode"); }}
      >
        Decode
      </button>
    </div>
  );
}

function RibbonEncodePanel(
  { ribbon, ribbonPngUrl, setRibbonField, onCoverChange, onGenerate }: {
    readonly ribbon: RibbonFormState;
    readonly ribbonPngUrl: string;
    readonly setRibbonField: SetRibbonField;
    readonly onCoverChange: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
    readonly onGenerate: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  }
): React.JSX.Element {
  return (
    <form
      className="panel control-panel"
      id="ribbon-panel-encode"
      data-form-id="ribbon-form"
      role="tabpanel"
      aria-labelledby="ribbon-tab-encode"
      onSubmit={(event) => void onGenerate(event)}
    >
      <label htmlFor="branch-wrapper">BRANCH0 wrapper</label>
      <textarea
        id="branch-wrapper"
        name="branch-wrapper"
        spellCheck={false}
        rows={9}
        placeholder={ribbon.wrapper}
        value={ribbon.wrapper}
        onChange={(event) => { setRibbonField("wrapper", event.currentTarget.value); }}
      />

      <div className="control-row">
        <label htmlFor="cover-image">Cover image</label>
        <input id="cover-image" name="cover-image" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void onCoverChange(event)} />
      </div>

      <div className="control-row">
        <label htmlFor="visual-mode">Visual mode</label>
        <select id="visual-mode" name="visual-mode" value={ribbon.visualMode} onChange={(event) => { setRibbonField("visualMode", event.currentTarget.value === "seal" ? "seal" : "tint"); }}>
          <option value="seal">Seal</option>
          <option value="tint">Tint</option>
        </select>
      </div>

      <RibbonGeometryControls idPrefix="" ribbon={ribbon} setRibbonField={setRibbonField} includeOutputSize={true} />

      <div className="control-row">
        <label htmlFor="tint-strength">Tint strength</label>
        <input id="tint-strength" name="tint-strength" type="range" min="0" max="24" step="1" value={ribbon.tintStrength} onChange={(event) => { setRibbonField("tintStrength", event.currentTarget.value); }} />
      </div>

      <div className="button-row">
        <button type="submit">Generate</button>
        <button type="button" id="download-ribbon" disabled={ribbonPngUrl === ""} onClick={() => { downloadURL(ribbonPngUrl, ribbonPngFilename); }}>
          Download PNG
        </button>
      </div>
    </form>
  );
}

function RibbonDecodePanel(
  { decodeFileRef, decodedWrapper, ribbon, setRibbonField, onDecode }: {
    readonly decodeFileRef: React.RefObject<HTMLInputElement | null>;
    readonly decodedWrapper: string;
    readonly ribbon: RibbonFormState;
    readonly setRibbonField: SetRibbonField;
    readonly onDecode: () => Promise<void>;
  }
): React.JSX.Element {
  return (
    <section className="panel control-panel" id="ribbon-panel-decode" role="tabpanel" aria-labelledby="ribbon-tab-decode">
      <div className="decode-controls">
        <label htmlFor="decode-image">Decode image</label>
        <input id="decode-image" ref={decodeFileRef} name="decode-image" type="file" accept="image/png,image/jpeg,image/webp" />
        <button type="button" id="decode-ribbon" onClick={() => void onDecode()}>
          Decode
        </button>
      </div>

      <RibbonGeometryControls idPrefix="decode" ribbon={ribbon} setRibbonField={setRibbonField} includeOutputSize={false} />

      <label htmlFor="decoded-wrapper">Decoded wrapper</label>
      <textarea id="decoded-wrapper" spellCheck={false} readOnly rows={7} value={decodedWrapper} />
    </section>
  );
}

function RibbonGeometryControls(
  { idPrefix, ribbon, setRibbonField, includeOutputSize }: {
    readonly idPrefix: "" | "decode";
    readonly ribbon: RibbonFormState;
    readonly setRibbonField: SetRibbonField;
    readonly includeOutputSize: boolean;
  }
): React.JSX.Element {
  const quietZoneId = controlId(idPrefix, "quiet-zone");
  const carrierSizeId = controlId(idPrefix, "carrier-size");
  const placementId = controlId(idPrefix, "carrier-placement");

  return (
    <>
      <div className="control-row">
        <label htmlFor={quietZoneId}>Quiet zone</label>
        <input id={quietZoneId} name={quietZoneId} type="number" min="4" max="12" step="1" value={ribbon.quietZone} onChange={(event) => { setRibbonField("quietZone", event.currentTarget.value); }} />
      </div>

      <div className="control-row">
        <label htmlFor={carrierSizeId}>Carrier size</label>
        <input id={carrierSizeId} name={carrierSizeId} type="number" min="320" max="1600" step="16" value={ribbon.carrierSize} onChange={(event) => { setRibbonField("carrierSize", event.currentTarget.value); }} />
      </div>

      {includeOutputSize ? (
        <>
          <div className="control-row">
            <label htmlFor="output-width">Output width</label>
            <input id="output-width" name="output-width" type="number" min="640" max="4096" step="10" value={ribbon.outputWidth} onChange={(event) => { setRibbonField("outputWidth", event.currentTarget.value); }} />
          </div>

          <div className="control-row">
            <label htmlFor="output-height">Output height</label>
            <input id="output-height" name="output-height" type="number" min="640" max="4096" step="10" value={ribbon.outputHeight} onChange={(event) => { setRibbonField("outputHeight", event.currentTarget.value); }} />
          </div>
        </>
      ) : null}

      <div className="control-row">
        <label htmlFor={placementId}>Placement</label>
        <select id={placementId} name={placementId} value={ribbon.placement} onChange={(event) => { setRibbonField("placement", readPlacement(event.currentTarget.value)); }}>
          <option value="center">Center</option>
          <option value="bottom-right">Bottom right</option>
          <option value="bottom-left">Bottom left</option>
          <option value="top-right">Top right</option>
          <option value="top-left">Top left</option>
        </select>
      </div>
    </>
  );
}

function controlId(prefix: "" | "decode", id: string): string {
  return prefix === "" ? id : `${prefix}-${id}`;
}

function diagnosticsFromSymbol(
  symbol: GeneratedRibbonSymbol,
  mode: string,
  canvas: HTMLCanvasElement,
  status: string,
  statusClass: "status-good" | "status-warn" | "status-bad"
): DiagnosticsState {
  return createDiagnostics(status, statusClass, {
    profile: symbol.diagnostics.profile,
    mode,
    payloadLength: String(symbol.diagnostics.payloadLength),
    sourceSymbolVersion: String(symbol.diagnostics.sourceSymbolVersion),
    moduleCount: String(symbol.diagnostics.moduleCount),
    modulePitch: String(symbol.diagnostics.modulePitch),
    quietZone: String(symbol.diagnostics.quietZone),
    canvas: `${String(canvas.width)}x${String(canvas.height)}`,
    ecc: symbol.diagnostics.errorCorrectionLevel
  });
}

function fitCarrierSize(value: string, outputWidth: number, outputHeight: number): number {
  const requested = readBoundedInteger(value, 320, 1600, "carrier size");
  return clamp(requested, 320, Math.min(1600, outputWidth, outputHeight));
}

function readBoundedInteger(value: string, min: number, max: number, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} outside ${String(min)}-${String(max)}`);
  }
  return number;
}

function readOptionalInteger(value: string, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function readPlacement(value: string) {
  if (value === "center" || value === "bottom-right" || value === "bottom-left" || value === "top-right" || value === "top-left") {
    return value;
  }
  return "bottom-right";
}

function readPreferredVersion(wrapper: string, quietZone: number, carrierSize: number): number | undefined {
  try {
    return generateRibbonSymbol(wrapper.trim(), quietZone, carrierSize).diagnostics.sourceSymbolVersion;
  } catch {
    return undefined;
  }
}
