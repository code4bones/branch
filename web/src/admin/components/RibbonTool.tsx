import {
  CopyOutlined,
  DownloadOutlined,
  ExperimentOutlined,
  PlayCircleOutlined,
  StopOutlined,
  UploadOutlined
} from "@ant-design/icons";
import {
  Button,
  Input,
  InputNumber,
  Progress,
  Segmented,
  Select,
  Space,
  Table,
  Typography,
  Upload,
  type TableColumnsType
} from "antd";
import { useEffect, useRef } from "react";

import { copyTextFromFallback, downloadText, downloadURL } from "../browser-files.js";
import { ribbonPngFilename } from "../defaults.js";
import {
  ribbonImagePublicationDescription,
  ribbonImagePublicationSearchQuery,
  ribbonImagePublicationTitle
} from "../publication-profile.js";
import { decodeRibbonImageAutoWithWorker, makeAutoDecodeBaseOptions } from "../ribbon-auto-decode.js";
import {
  createDiagnostics,
  useAdminStore,
  type DiagnosticsState,
  type RibbonFormState,
  type RibbonTab,
  type StatusClass,
  type TransformLabState
} from "../store.js";
import {
  makeTransformLabJson,
  selectTransformLabPresets,
  transformLabPresets,
  type TransformLabResult,
  type TransformRunMode
} from "../transform-lab.js";
import { runTransformLab } from "../transform-lab-runner.js";
import {
  canvasContext,
  canvasToImageData,
  canvasToPngBlob,
  imageToData,
  loadLocalImage,
  type LoadedBrowserImage
} from "../../visual/canvas-image.js";
import { clamp } from "../../visual/geometry.js";
import { ribbonBlockProfile } from "../../visual/ribbon-block.js";
import type { RibbonFoundRegion } from "../../visual/ribbon-decode.js";
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
  const decodeFileRef = useRef<File | null>(null);
  const transformAbortRef = useRef<AbortController | null>(null);
  const transformReportFallbackRef = useRef<HTMLTextAreaElement | null>(null);
  const ribbonTab = useAdminStore((state) => state.ribbonTab);
  const ribbon = useAdminStore((state) => state.ribbon);
  const cover = useAdminStore((state) => state.cover);
  const ribbonPngUrl = useAdminStore((state) => state.ribbonPngUrl);
  const decodedWrapper = useAdminStore((state) => state.decodedWrapper);
  const transformLab = useAdminStore((state) => state.transformLab);
  const setRibbonTab = useAdminStore((state) => state.setRibbonTab);
  const setRibbonField = useAdminStore((state) => state.setRibbonField);
  const setCover = useAdminStore((state) => state.setCover);
  const setRibbonPngUrl = useAdminStore((state) => state.setRibbonPngUrl);
  const setDecodedWrapper = useAdminStore((state) => state.setDecodedWrapper);
  const setDiagnostics = useAdminStore((state) => state.setDiagnostics);
  const setTransformLabSelectedPreset = useAdminStore((state) => state.setTransformLabSelectedPreset);
  const setTransformLabRunning = useAdminStore((state) => state.setTransformLabRunning);
  const setTransformLabProgress = useAdminStore((state) => state.setTransformLabProgress);
  const setTransformLabResults = useAdminStore((state) => state.setTransformLabResults);
  const setTransformLabStatus = useAdminStore((state) => state.setTransformLabStatus);

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

  async function onCoverFile(file: File | undefined): Promise<void> {
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
      setCover({ image: loaded, filename: file.name });
      setRibbonField("outputWidth", String(outputWidth));
      setRibbonField("outputHeight", String(outputHeight));
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
      const outputWidth = readBoundedInteger(ribbon.outputWidth, 640, 4096, "output width");
      const outputHeight = readBoundedInteger(ribbon.outputHeight, 640, 4096, "output height");
      const symbol = generateRibbonSymbol(ribbon.wrapper.trim());
      renderRibbonImage(canvas, symbol, {
        outputWidth,
        outputHeight,
        coverImage: cover?.image ?? null
      });
      setDiagnostics(diagnosticsFromSymbol(symbol, canvas, "generated", "status-good"));

      replaceRibbonPngUrl("");
      const blob = await canvasToPngBlob(canvas);
      replaceRibbonPngUrl(URL.createObjectURL(blob));
    } catch (error) {
      replaceRibbonPngUrl("");
      preserveCoverPreviewOnError();
      setDiagnostics(createDiagnostics(error instanceof Error ? error.message : "generation failed", "status-bad"));
    }
  }

  async function onDecode(): Promise<void> {
    try {
      setDiagnostics(createDiagnostics("decoding", "status-warn"));
      const image = await loadDecodeImage({ refreshPreview: true });
      const result = await decodeRibbonImageAutoWithWorker(image);
      setDecodedWrapper(result.wrapper);
      if (result.wrapper !== "" && result.foundRegion !== undefined) {
        drawFoundRegion(result.foundRegion);
      }
      setDiagnostics(createDiagnostics(result.status, result.wrapper === "" ? "status-bad" : "status-good", {
        canvas: `${String(image.width)}x${String(image.height)}`
      }));
    } catch (error) {
      setDecodedWrapper("");
      setDiagnostics(createDiagnostics(error instanceof Error ? error.message : "decode failed", "status-bad"));
    }
  }

  async function onDecodeImageFile(file: File | undefined): Promise<void> {
    setDecodedWrapper("");
    if (file === undefined) {
      decodeFileRef.current = null;
      drawIdle();
      setDiagnostics(createDiagnostics("idle", "status-warn"));
      return;
    }

    try {
      const loaded = await loadLocalImage(file, "decode image");
      decodeFileRef.current = file;
      drawDecodePreview(loaded);
      setDiagnostics(createDiagnostics("decode image loaded", "status-good", {
        canvas: `${String(loaded.width)}x${String(loaded.height)}`
      }));
    } catch (error) {
      decodeFileRef.current = null;
      drawIdle();
      setDiagnostics(createDiagnostics(errorMessage(error), "status-bad"));
    }
  }

  async function onRunTransformLab(mode: TransformRunMode): Promise<void> {
    if (transformLab.running) {
      return;
    }

    const controller = new AbortController();
    transformAbortRef.current = controller;
    setTransformLabRunning(true);
    setTransformLabProgress(null);
    setTransformLabStatus("preparing", "status-warn");
    setTransformLabResults([], "");

    try {
      const image = await loadDecodeImage();
      const presets = selectTransformLabPresets(mode, transformLab.selectedPresetId);
      const results = await runTransformLab({
        source: image,
        sourceMime: readDecodeSourceMime(decodeFileRef.current ?? undefined),
        presets,
        decodeOptions: makeAutoDecodeBaseOptions(image.width, image.height),
        decode: (candidate, _options, signal) => decodeRibbonImageAutoWithWorker(candidate, signal),
        onProgress: (progress) => {
          setTransformLabProgress(progress);
          setTransformLabStatus(`running ${String(progress.current)}/${String(progress.total)}: ${progress.label}`, "status-warn");
        },
        signal: controller.signal
      });
      const reportJson = makeTransformLabJson(results, new Date().toISOString(), ribbonBlockProfile);
      setTransformLabResults(results, reportJson);
      const [status, statusClass] = transformLabStatusFromResults(results, controller.signal.aborted);
      setTransformLabStatus(status, statusClass);
    } catch (error) {
      const cancelled = controller.signal.aborted;
      setTransformLabStatus(cancelled ? "cancelled" : errorMessage(error), cancelled ? "status-warn" : "status-bad");
    } finally {
      setTransformLabRunning(false);
      setTransformLabProgress(null);
      if (transformAbortRef.current === controller) {
        transformAbortRef.current = null;
      }
    }
  }

  function onCancelTransformLab(): void {
    transformAbortRef.current?.abort();
    setTransformLabStatus("cancelling", "status-warn");
  }

  async function onCopyTransformLabReport(): Promise<void> {
    if (transformLab.reportJson === "") {
      setTransformLabStatus("no report", "status-warn");
      return;
    }
    try {
      await copyTextFromFallback(transformLab.reportJson, transformReportFallbackRef.current);
      setTransformLabStatus("report copied", "status-good");
    } catch {
      setTransformLabStatus("copy failed", "status-bad");
    }
  }

  function onDownloadTransformLabReport(): void {
    if (transformLab.reportJson === "") {
      setTransformLabStatus("no report", "status-warn");
      return;
    }
    downloadText(transformLab.reportJson, "branch-transform-lab.json", "application/json");
  }

  async function loadDecodeImage(options: { readonly refreshPreview?: boolean } = {}) {
    const file = decodeFileRef.current;
    if (file === null) {
      return canvasToImageData(requireCanvas());
    }
    const loaded = await loadLocalImage(file, "decode image");
    if (options.refreshPreview === true) {
      drawDecodePreview(loaded);
    }
    return imageToData(loaded);
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

  function drawDecodePreview(image: LoadedBrowserImage): void {
    drawCoverPreview(requireCanvas(), image, image.width, image.height);
  }

  function drawFoundRegion(region: RibbonFoundRegion): void {
    const canvas = requireCanvas();
    const context = canvasContext(canvas);
    const lineWidth = Math.max(3, Math.round(Math.min(canvas.width, canvas.height) * 0.005));
    const x = clamp(region.x, 0, Math.max(0, canvas.width - 1));
    const y = clamp(region.y, 0, Math.max(0, canvas.height - 1));
    const right = clamp(region.x + region.width, x + 1, canvas.width);
    const bottom = clamp(region.y + region.height, y + 1, canvas.height);

    context.save();
    context.strokeStyle = "#38e8ff";
    context.lineWidth = lineWidth;
    context.setLineDash([lineWidth * 3, lineWidth * 1.5]);
    context.shadowColor = "rgba(56, 232, 255, 0.72)";
    context.shadowBlur = lineWidth * 2;
    context.strokeRect(
      x + lineWidth / 2,
      y + lineWidth / 2,
      Math.max(1, right - x - lineWidth),
      Math.max(1, bottom - y - lineWidth)
    );
    context.restore();
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
            onCoverFile={onCoverFile}
            onGenerate={onGenerate}
          />
        ) : (
          <RibbonDecodePanel
            decodedWrapper={decodedWrapper}
            onDecodeImageFile={onDecodeImageFile}
            onDecode={onDecode}
            transformLab={transformLab}
            transformReportFallbackRef={transformReportFallbackRef}
            onPresetChange={setTransformLabSelectedPreset}
            onRunTransformLab={onRunTransformLab}
            onCancelTransformLab={onCancelTransformLab}
            onCopyTransformLabReport={onCopyTransformLabReport}
            onDownloadTransformLabReport={onDownloadTransformLabReport}
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
    <Segmented
      block
      className="workflow-segmented"
      id="ribbon-workflow"
      options={[
        { label: "Encode", value: "encode" },
        { label: "Decode", value: "decode" }
      ]}
      value={activeTab}
      onChange={(value) => { onTabChange(value === "decode" ? "decode" : "encode"); }}
    />
  );
}

function RibbonEncodePanel(
  { ribbon, ribbonPngUrl, setRibbonField, onCoverFile, onGenerate }: {
    readonly ribbon: RibbonFormState;
    readonly ribbonPngUrl: string;
    readonly setRibbonField: SetRibbonField;
    readonly onCoverFile: (file: File | undefined) => Promise<void>;
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
      <Input.TextArea
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
        <Upload
          accept="image/png,image/jpeg,image/webp"
          beforeUpload={(file) => {
            void onCoverFile(file);
            return false;
          }}
          maxCount={1}
          onRemove={() => {
            void onCoverFile(undefined);
            return true;
          }}
        >
          <Button icon={<UploadOutlined />} id="cover-image">Choose cover</Button>
        </Upload>
      </div>

      <RibbonOutputSizeControls ribbon={ribbon} setRibbonField={setRibbonField} />

      <section className="publication-fields" aria-label="Image publication metadata">
        <Typography.Title level={3}>Publication</Typography.Title>
        <div className="publication-row">
          <label htmlFor="ribbon-publication-title">Pinterest title</label>
          <Input id="ribbon-publication-title" readOnly value={ribbonImagePublicationTitle} />
          <Button icon={<CopyOutlined />} onClick={() => void copyTextFromFallback(ribbonImagePublicationTitle, null)}>
            Copy title
          </Button>
        </div>
        <label htmlFor="ribbon-publication-description">Pinterest description</label>
        <Input.TextArea
          id="ribbon-publication-description"
          readOnly
          rows={3}
          value={ribbonImagePublicationDescription}
        />
        <Space wrap>
          <Button icon={<CopyOutlined />} onClick={() => void copyTextFromFallback(ribbonImagePublicationDescription, null)}>
            Copy description
          </Button>
        </Space>
        <div className="publication-row">
          <label htmlFor="ribbon-publication-query">Image search query</label>
          <Input id="ribbon-publication-query" readOnly value={ribbonImagePublicationSearchQuery} />
          <Button icon={<CopyOutlined />} onClick={() => void copyTextFromFallback(ribbonImagePublicationSearchQuery, null)}>
            Copy query
          </Button>
        </div>
      </section>

      <Space wrap>
        <Button htmlType="submit" icon={<PlayCircleOutlined />} type="primary">Generate</Button>
        <Button icon={<DownloadOutlined />} id="download-ribbon" disabled={ribbonPngUrl === ""} onClick={() => { downloadURL(ribbonPngUrl, ribbonPngFilename); }}>
          Download PNG
        </Button>
      </Space>
    </form>
  );
}

function RibbonDecodePanel(
  {
    decodedWrapper,
    onDecodeImageFile,
    onDecode,
    transformLab,
    transformReportFallbackRef,
    onPresetChange,
    onRunTransformLab,
    onCancelTransformLab,
    onCopyTransformLabReport,
    onDownloadTransformLabReport
  }: {
    readonly decodedWrapper: string;
    readonly onDecodeImageFile: (file: File | undefined) => Promise<void>;
    readonly onDecode: () => Promise<void>;
    readonly transformLab: TransformLabState;
    readonly transformReportFallbackRef: React.RefObject<HTMLTextAreaElement | null>;
    readonly onPresetChange: (presetId: string) => void;
    readonly onRunTransformLab: (mode: TransformRunMode) => Promise<void>;
    readonly onCancelTransformLab: () => void;
    readonly onCopyTransformLabReport: () => Promise<void>;
    readonly onDownloadTransformLabReport: () => void;
  }
): React.JSX.Element {
  return (
    <section className="panel control-panel" id="ribbon-panel-decode" role="tabpanel" aria-labelledby="ribbon-tab-decode">
      <div className="decode-controls">
        <label htmlFor="decode-image">Decode image</label>
        <Upload
          accept="image/png,image/jpeg,image/webp"
          beforeUpload={(file) => {
            void onDecodeImageFile(file);
            return false;
          }}
          maxCount={1}
          onRemove={() => {
            void onDecodeImageFile(undefined);
            return true;
          }}
        >
          <Button icon={<UploadOutlined />} id="decode-image">Choose image</Button>
        </Upload>
        <Button icon={<PlayCircleOutlined />} id="decode-ribbon" type="primary" onClick={() => void onDecode()}>
          Decode
        </Button>
      </div>

      <label htmlFor="decoded-wrapper">Decoded wrapper</label>
      <Input.TextArea id="decoded-wrapper" spellCheck={false} readOnly rows={7} value={decodedWrapper} />

      <TransformLabPanel
        transformLab={transformLab}
        reportFallbackRef={transformReportFallbackRef}
        onPresetChange={onPresetChange}
        onRun={onRunTransformLab}
        onCancel={onCancelTransformLab}
        onCopyReport={onCopyTransformLabReport}
        onDownloadReport={onDownloadTransformLabReport}
      />
    </section>
  );
}

function TransformLabPanel(
  { transformLab, reportFallbackRef, onPresetChange, onRun, onCancel, onCopyReport, onDownloadReport }: {
    readonly transformLab: TransformLabState;
    readonly reportFallbackRef: React.RefObject<HTMLTextAreaElement | null>;
    readonly onPresetChange: (presetId: string) => void;
    readonly onRun: (mode: TransformRunMode) => Promise<void>;
    readonly onCancel: () => void;
    readonly onCopyReport: () => Promise<void>;
    readonly onDownloadReport: () => void;
  }
): React.JSX.Element {
  return (
    <section className="transform-lab" aria-labelledby="transform-lab-title">
      <Typography.Title id="transform-lab-title" level={3}>Transform Lab</Typography.Title>
      <div className="control-row">
        <label htmlFor="transform-preset">Preset</label>
        <Select
          id="transform-preset"
          options={transformLabPresets.map((preset) => ({ label: preset.label, value: preset.id }))}
          value={transformLab.selectedPresetId}
          onChange={onPresetChange}
        />
      </div>

      <Space className="lab-actions" wrap>
        <Button icon={<ExperimentOutlined />} id="run-transform-preset" disabled={transformLab.running} onClick={() => void onRun("selected")}>
          Run selected
        </Button>
        <Button icon={<PlayCircleOutlined />} id="run-transform-matrix" type="primary" disabled={transformLab.running} onClick={() => void onRun("matrix")}>
          Run matrix
        </Button>
        <Button icon={<StopOutlined />} id="cancel-transform-lab" disabled={!transformLab.running} onClick={onCancel}>
          Cancel
        </Button>
      </Space>

      <div className="lab-status">
        <span className={transformLab.statusClass}>{transformLab.status}</span>
        {transformLab.progress === null ? null : (
          <Progress
            aria-label="Transform Lab progress"
            percent={Math.round((transformLab.progress.current / Math.max(1, transformLab.progress.total)) * 100)}
            size="small"
          />
        )}
        <Space wrap>
          <Button icon={<CopyOutlined />} id="copy-transform-report" disabled={transformLab.reportJson === ""} onClick={() => void onCopyReport()}>
            Copy JSON
          </Button>
          <Button icon={<DownloadOutlined />} id="download-transform-report" disabled={transformLab.reportJson === ""} onClick={onDownloadReport}>
            Download JSON
          </Button>
        </Space>
      </div>

      <TransformLabResults results={transformLab.results} />
      <textarea ref={reportFallbackRef} className="copy-fallback" readOnly tabIndex={-1} value={transformLab.reportJson} />
    </section>
  );
}

function TransformLabResults({ results }: { readonly results: readonly TransformLabResult[] }): React.JSX.Element {
  if (results.length === 0) {
    return <div className="lab-empty">No results</div>;
  }

  const columns: TableColumnsType<TransformLabResult> = [
    {
      title: "Preset",
      dataIndex: "presetLabel",
      key: "preset",
      sorter: (left, right) => left.presetLabel.localeCompare(right.presetLabel)
    },
    {
      title: "Result",
      dataIndex: "status",
      key: "result",
      sorter: (left, right) => left.status.localeCompare(right.status),
      render: (_, result) => <span className={statusClassForTransformResult(result)}>{result.status}</span>
    },
    {
      title: "Output",
      key: "output",
      render: (_, result) => `${String(result.output.width)}x${String(result.output.height)}`
    },
    {
      title: "MIME",
      key: "mime",
      render: (_, result) => formatMime(result)
    },
    {
      title: "Bytes",
      key: "bytes",
      sorter: (left, right) => (left.output.byteSize ?? 0) - (right.output.byteSize ?? 0),
      render: (_, result) => result.output.byteSize === null ? "-" : String(result.output.byteSize)
    },
    {
      title: "Decode",
      key: "decode",
      render: (_, result) => result.failureReason ?? result.decodeStatus
    },
    {
      title: "Region",
      key: "region",
      render: (_, result) => formatFoundRegion(result)
    },
    {
      title: "Match",
      key: "match",
      sorter: (left, right) => Number(left.exactMatch) - Number(right.exactMatch),
      render: (_, result) => result.exactMatch ? "exact" : "-"
    },
    {
      title: "Signature",
      dataIndex: "signatureValidation",
      key: "signature"
    },
    {
      title: "ms",
      dataIndex: "durationMs",
      key: "duration",
      sorter: (left, right) => left.durationMs - right.durationMs
    }
  ];

  return (
    <Table
      className="lab-results"
      columns={columns}
      dataSource={[...results]}
      pagination={{ pageSize: 8, showSizeChanger: true }}
      rowKey="presetId"
      scroll={{ x: 980 }}
      size="small"
    />
  );
}

function RibbonOutputSizeControls(
  { ribbon, setRibbonField }: {
    readonly ribbon: RibbonFormState;
    readonly setRibbonField: SetRibbonField;
  }
): React.JSX.Element {
  return (
    <>
      <div className="control-row">
        <label htmlFor="output-width">Output width</label>
        <InputNumber
          id="output-width"
          max="4096"
          min="640"
          step="10"
          stringMode
          value={ribbon.outputWidth}
          onChange={(value) => { setRibbonField("outputWidth", value ?? ""); }}
        />
      </div>

      <div className="control-row">
        <label htmlFor="output-height">Output height</label>
        <InputNumber
          id="output-height"
          max="4096"
          min="640"
          step="10"
          stringMode
          value={ribbon.outputHeight}
          onChange={(value) => { setRibbonField("outputHeight", value ?? ""); }}
        />
      </div>
    </>
  );
}

function transformLabStatusFromResults(results: readonly TransformLabResult[], cancelled: boolean): readonly [string, StatusClass] {
  if (cancelled || results.some((result) => result.status === "cancelled")) {
    return [`cancelled ${String(results.length)} cases`, "status-warn"];
  }
  const exact = results.filter((result) => result.status === "verified" || result.status === "exact-unverified").length;
  const rejected = results.filter((result) => result.status === "rejected" || result.status === "mismatch").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const unsupported = results.filter((result) => result.status === "unsupported").length;
  const status = `${String(exact)} exact, ${String(rejected)} rejected, ${String(failed)} failed, ${String(unsupported)} unsupported`;
  return [status, failed === 0 ? "status-good" : "status-warn"];
}

function statusClassForTransformResult(result: TransformLabResult): StatusClass {
  if (result.status === "verified" || result.status === "exact-unverified") {
    return "status-good";
  }
  if (result.status === "rejected" || result.status === "unsupported" || result.status === "cancelled") {
    return "status-warn";
  }
  return "status-bad";
}

function formatMime(result: TransformLabResult): string {
  const quality = result.output.quality === null ? "" : `/${String(Math.round(result.output.quality * 100))}`;
  return `${result.output.mime}${quality}`;
}

function formatFoundRegion(result: TransformLabResult): string {
  if (result.foundRegion === null) {
    return "-";
  }
  return `${result.foundRegion.source} ${String(result.foundRegion.x)},${String(result.foundRegion.y)} ${String(result.foundRegion.width ?? result.foundRegion.size)}x${String(result.foundRegion.height ?? result.foundRegion.size)}`;
}

function readDecodeSourceMime(file: File | undefined): "image/png" | "image/jpeg" | "image/webp" | "image/unknown" {
  if (file?.type === "image/png" || file?.type === "image/jpeg" || file?.type === "image/webp") {
    return file.type;
  }
  return "image/unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "operation failed";
}

function diagnosticsFromSymbol(
  symbol: GeneratedRibbonSymbol,
  canvas: HTMLCanvasElement,
  status: string,
  statusClass: "status-good" | "status-warn" | "status-bad"
): DiagnosticsState {
  return createDiagnostics(status, statusClass, {
    profile: symbol.diagnostics.profile,
    mode: "block",
    payloadLength: String(symbol.diagnostics.payloadLength),
    canvas: `${String(canvas.width)}x${String(canvas.height)}`,
    ecc: symbol.diagnostics.errorCorrectionLevel
  });
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
