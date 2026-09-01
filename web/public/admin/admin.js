(function () {
  "use strict";

  const profile = "ribbon-seal/0";
  const branchPrefix = "BRANCH0.";
  const payloadLimit = 768;
  const magicText = "BRIMG0";
  const magic = encodeAscii(magicText);
  const encoder = new TextEncoder();
  const crcTable = makeCRC32CTable();

  const state = {
    ribbonPngUrl: "",
    githubFiles: [],
    selectedFile: 0
  };

  const elements = {
    tabs: Array.from(document.querySelectorAll("[data-tab]")),
    panels: Array.from(document.querySelectorAll("[data-panel]")),
    ribbonForm: document.getElementById("ribbon-form"),
    wrapper: document.getElementById("branch-wrapper"),
    modulePitch: document.getElementById("module-pitch"),
    quietZone: document.getElementById("quiet-zone"),
    canvas: document.getElementById("ribbon-canvas"),
    diagnostics: document.getElementById("ribbon-diagnostics"),
    downloadRibbon: document.getElementById("download-ribbon"),
    githubForm: document.getElementById("github-form"),
    githubRecords: document.getElementById("github-records"),
    sourceCommit: document.getElementById("source-commit"),
    downloadBundle: document.getElementById("download-bundle"),
    fileTabs: document.getElementById("file-tabs"),
    fileOutput: document.getElementById("file-output"),
    downloadFile: document.getElementById("download-file"),
    copyFile: document.getElementById("copy-file")
  };

  wireTabs();
  wireRibbon();
  wireGitHub();
  drawIdleCanvas();

  function wireTabs() {
    for (const tab of elements.tabs) {
      tab.addEventListener("click", () => {
        const target = tab.dataset.tab;
        for (const candidate of elements.tabs) {
          candidate.classList.toggle("is-active", candidate === tab);
        }
        for (const panel of elements.panels) {
          panel.classList.toggle("is-active", panel.dataset.panel === target);
        }
      });
    }
  }

  function wireRibbon() {
    elements.ribbonForm.addEventListener("submit", (event) => {
      event.preventDefault();
      try {
        const wrapper = elements.wrapper.value.trim();
        const modulePitch = readBoundedInteger(elements.modulePitch.value, 4, 24, "module pitch");
        const quietZone = readBoundedInteger(elements.quietZone.value, 4, 12, "quiet zone");
        const generated = generateRibbonSeal(wrapper, modulePitch, quietZone);
        renderQR(generated.qr.modules, modulePitch, quietZone, elements.canvas);
        setRibbonDiagnostics(generated.diagnostics, "generated", "status-good");

        if (state.ribbonPngUrl) {
          URL.revokeObjectURL(state.ribbonPngUrl);
        }
        elements.canvas.toBlob((blob) => {
          if (!blob) {
            setRibbonDiagnostics(generated.diagnostics, "png export failed", "status-bad");
            return;
          }
          state.ribbonPngUrl = URL.createObjectURL(blob);
          elements.downloadRibbon.disabled = false;
        }, "image/png");
      } catch (error) {
        drawIdleCanvas();
        elements.downloadRibbon.disabled = true;
        setRibbonDiagnostics(
          {
            profile,
            sourceSymbolVersion: "-",
            moduleCount: "-",
            modulePitch: "-",
            quietZone: "-",
            payloadLength: "-"
          },
          error instanceof Error ? error.message : "generation failed",
          "status-bad"
        );
      }
    });

    elements.downloadRibbon.addEventListener("click", () => {
      if (!state.ribbonPngUrl) {
        return;
      }
      downloadURL(state.ribbonPngUrl, "branch-ribbon-seal.png");
    });
  }

  function wireGitHub() {
    elements.githubForm.addEventListener("submit", (event) => {
      event.preventDefault();
      try {
        const records = parseBranchRecords(elements.githubRecords.value);
        state.githubFiles = makeGitHubFiles(records, elements.sourceCommit.value.trim());
        state.selectedFile = 0;
        renderFileTabs();
        renderSelectedFile();
        elements.downloadBundle.disabled = false;
      } catch (error) {
        state.githubFiles = [];
        renderFileTabs();
        elements.fileOutput.value = error instanceof Error ? error.message : "generation failed";
        elements.downloadBundle.disabled = true;
        elements.downloadFile.disabled = true;
        elements.copyFile.disabled = true;
      }
    });

    elements.downloadBundle.addEventListener("click", () => {
      if (state.githubFiles.length === 0) {
        return;
      }
      const bundle = state.githubFiles
        .map((file) => `===== ${file.path} =====\n${file.content}`)
        .join("\n\n");
      downloadText(bundle, "branch-github-dropin.txt", "text/plain");
    });

    elements.downloadFile.addEventListener("click", () => {
      const file = selectedFile();
      if (!file) {
        return;
      }
      downloadText(file.content, file.path.split("/").pop() || "branch-file.txt", file.type);
    });

    elements.copyFile.addEventListener("click", async () => {
      const file = selectedFile();
      if (!file) {
        return;
      }
      await copyText(file.content);
    });
  }

  function generateRibbonSeal(wrapper, modulePitch, quietZone) {
    const payload = branchWrapperBytes(wrapper);
    const frame = encodeRibbonFrame(payload);
    const qrApi = window.BranchQRCode;
    if (!qrApi || typeof qrApi.create !== "function") {
      throw new Error("QR encoder unavailable");
    }
    const qr = qrApi.create([{ mode: "byte", data: frame }], { errorCorrectionLevel: "H" });
    return {
      qr,
      diagnostics: {
        profile,
        sourceSymbolVersion: qr.version,
        moduleCount: qr.modules.size,
        modulePitch,
        quietZone,
        payloadLength: payload.byteLength
      }
    };
  }

  function branchWrapperBytes(wrapper) {
    if (!wrapper.startsWith(branchPrefix)) {
      throw new Error("payload must be a BRANCH0. wrapper");
    }
    const payload = encoder.encode(wrapper);
    if (payload.byteLength > payloadLimit) {
      throw new Error("payload too large");
    }
    return payload;
  }

  function encodeRibbonFrame(payload) {
    const profileBytes = encoder.encode(profile);
    const frame = new Uint8Array(magic.byteLength + 1 + profileBytes.byteLength + 1 + 2 + payload.byteLength + 4);
    let offset = 0;
    frame.set(magic, offset);
    offset += magic.byteLength;
    frame[offset] = profileBytes.byteLength;
    offset += 1;
    frame.set(profileBytes, offset);
    offset += profileBytes.byteLength;
    frame[offset] = 0x01;
    offset += 1;
    frame[offset] = (payload.byteLength >> 8) & 0xff;
    frame[offset + 1] = payload.byteLength & 0xff;
    offset += 2;
    frame.set(payload, offset);
    offset += payload.byteLength;
    writeUint32BE(frame, offset, crc32c(payload));
    return frame;
  }

  function renderQR(modules, modulePitch, quietZone, canvas) {
    const moduleCount = modules.size;
    const size = (moduleCount + quietZone * 2) * modulePitch;
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    context.fillStyle = "#f8fbff";
    context.fillRect(0, 0, size, size);
    context.fillStyle = "#003078";

    for (let moduleY = 0; moduleY < moduleCount; moduleY += 1) {
      for (let moduleX = 0; moduleX < moduleCount; moduleX += 1) {
        if (modules.get(moduleX, moduleY) === 0) {
          continue;
        }
        context.fillRect(
          (moduleX + quietZone) * modulePitch,
          (moduleY + quietZone) * modulePitch,
          modulePitch,
          modulePitch
        );
      }
    }
  }

  function drawIdleCanvas() {
    const canvas = elements.canvas;
    canvas.width = 640;
    canvas.height = 640;
    const context = canvas.getContext("2d");
    context.fillStyle = "#f8fbff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#d8e3f1";
    context.fillRect(128, 128, 384, 384);
    context.fillStyle = "#003078";
    context.fillRect(168, 168, 96, 96);
    context.fillRect(376, 168, 96, 96);
    context.fillRect(168, 376, 96, 96);
  }

  function setRibbonDiagnostics(diagnostics, status, statusClass) {
    elements.diagnostics.innerHTML = "";
    const rows = [
      ["Profile", diagnostics.profile],
      ["Status", status],
      ["Payload", diagnostics.payloadLength],
      ["QR version", diagnostics.sourceSymbolVersion],
      ["Modules", diagnostics.moduleCount],
      ["Pitch", diagnostics.modulePitch],
      ["Quiet zone", diagnostics.quietZone],
      ["ECC", "H"]
    ];

    for (const [label, value] of rows) {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      term.textContent = label;
      detail.textContent = String(value);
      if (label === "Status") {
        detail.className = statusClass;
      }
      row.append(term, detail);
      elements.diagnostics.append(row);
    }
  }

  function parseBranchRecords(source) {
    const records = source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    if (records.length === 0) {
      throw new Error("at least one BRANCH0. record is required");
    }
    for (const record of records) {
      if (!record.startsWith(branchPrefix)) {
        throw new Error("records.br0 accepts exact BRANCH0. wrappers only");
      }
      if (encoder.encode(record).byteLength > 64 * 1024) {
        throw new Error("record too large");
      }
    }
    return records;
  }

  function makeGitHubFiles(records, sourceCommit) {
    const generatedAt = Math.floor(Date.now() / 1000);
    const manifest = {
      schema: "branch.repository-dropin/0",
      markers: ["BRANCH0", "branch/connectivity/0", "branch-bootstrap-v0", "carry-the-ribbon"],
      records_path: ".branch/records.br0",
      badge_path: ".branch/ribbon.svg",
      generated_at: generatedAt,
      source_commit: sourceCommit || undefined,
      tool: "branch-admin-front/0"
    };

    return [
      {
        path: ".branch/records.br0",
        type: "text/plain",
        content: `${records.join("\n")}\n`
      },
      {
        path: ".branch/manifest.json",
        type: "application/json",
        content: `${JSON.stringify(dropUndefined(manifest), null, 2)}\n`
      },
      {
        path: ".branch/README.md",
        type: "text/markdown",
        content: makeDropInReadme()
      },
      {
        path: ".branch/ribbon.svg",
        type: "image/svg+xml",
        content: makeRibbonSvg()
      },
      {
        path: ".github/workflows/branch-carry-ribbon.yml",
        type: "text/yaml",
        content: makeWorkflow()
      }
    ];
  }

  function makeDropInReadme() {
    return `# Carry the Ribbon

B.R.A.N.C.H. — Blue Ribbon Autonomous Network for Carrier Hopping

Independent technical tribute to the Blue Ribbon Online Free Speech Campaign.
This repository does not imply affiliation with or endorsement by the Electronic
Frontier Foundation.

The Blue Ribbon is alive again.
From symbol to protocol.
The ribbon no longer merely hangs on the Web. It becomes a route through it.

Search markers: BRANCH0 branch/connectivity/0 branch-bootstrap-v0 carry-the-ribbon

The signed records are stored in \`.branch/records.br0\`. Repository ownership,
badges, topics, branch names, and CI status are publication evidence only. The
decoded B.R.A.N.C.H. signed event envelope remains the authority.
`;
  }

  function makeRibbonSvg() {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="96" viewBox="0 0 360 96" role="img" aria-labelledby="title desc">
  <title id="title">Blue Ribbon - Carry the Ribbon</title>
  <desc id="desc">B.R.A.N.C.H. repository carrier badge</desc>
  <rect width="360" height="96" rx="8" fill="#07111d"/>
  <path d="M54 17c15 0 28 11 32 26l-16 8c-1-10-8-18-16-18-9 0-16 8-16 18 0 8 5 15 12 17l-12 12c-11-6-18-17-18-30 0-18 15-33 34-33Z" fill="#64a8ff"/>
  <path d="M83 43c6 3 10 10 10 18 0 13-11 24-24 24H48l16-16h5c5 0 9-4 9-9 0-4-2-7-5-8l10-9Z" fill="#57d2c6"/>
  <text x="112" y="38" fill="#f4f7fb" font-family="Inter,Arial,sans-serif" font-size="22" font-weight="700">Carry the Ribbon</text>
  <text x="112" y="64" fill="#9eaaba" font-family="Inter,Arial,sans-serif" font-size="14">BRANCH0 branch/connectivity/0</text>
</svg>
`;
  }

  function makeWorkflow() {
    return `name: Carry the Ribbon

on:
  push:
    paths:
      - ".branch/**"
      - "README.md"
  workflow_dispatch:
  schedule:
    - cron: "17 4 * * 1"

permissions:
  contents: read

jobs:
  verify-dropin:
    runs-on: ubuntu-latest
    steps:
      - name: Prepare repository workspace
        shell: bash
        run: |
          git init .
          git remote add origin "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"
          git fetch --depth=1 origin "$GITHUB_SHA"
          git checkout --detach FETCH_HEAD
      - name: Verify local B.R.A.N.C.H. carrier files
        shell: bash
        run: |
          test -f .branch/records.br0
          test -f .branch/manifest.json
          grep -Eq '^BRANCH0\\.' .branch/records.br0
          grep -q 'branch.repository-dropin/0' .branch/manifest.json
`;
  }

  function renderFileTabs() {
    elements.fileTabs.innerHTML = "";
    state.githubFiles.forEach((file, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `file-tab${index === state.selectedFile ? " is-active" : ""}`;
      button.textContent = file.path;
      button.addEventListener("click", () => {
        state.selectedFile = index;
        renderFileTabs();
        renderSelectedFile();
      });
      elements.fileTabs.append(button);
    });
  }

  function renderSelectedFile() {
    const file = selectedFile();
    elements.fileOutput.value = file ? file.content : "";
    elements.downloadFile.disabled = !file;
    elements.copyFile.disabled = !file;
  }

  function selectedFile() {
    return state.githubFiles[state.selectedFile] || null;
  }

  function readBoundedInteger(value, min, max, name) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new Error(`${name} outside ${min}-${max}`);
    }
    return number;
  }

  function dropUndefined(source) {
    return Object.fromEntries(Object.entries(source).filter((entry) => entry[1] !== undefined));
  }

  function downloadText(text, filename, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    downloadURL(url, filename);
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function downloadURL(url, filename) {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    elements.fileOutput.focus();
    elements.fileOutput.select();
    document.execCommand("copy");
  }

  function crc32c(data) {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makeCRC32CTable() {
    const table = new Uint32Array(256);
    for (let i = 0; i < table.length; i += 1) {
      let crc = i;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
      }
      table[i] = crc >>> 0;
    }
    return table;
  }

  function writeUint32BE(target, offset, value) {
    target[offset] = (value >>> 24) & 0xff;
    target[offset + 1] = (value >>> 16) & 0xff;
    target[offset + 2] = (value >>> 8) & 0xff;
    target[offset + 3] = value & 0xff;
  }

  function encodeAscii(text) {
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) {
      bytes[index] = text.charCodeAt(index);
    }
    return bytes;
  }
})();
