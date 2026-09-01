import { useRef } from "react";

import { copyTextFromFallback, downloadBytes, downloadText } from "../browser-files.js";
import { defaultBranchWrapper, githubBundleFilename } from "../defaults.js";
import {
  createGitHubSearchCarrier,
  gitHubReportsFromCarrierReports,
  githubDiscoveryConstraints,
  githubDiscoveryFallbackQuery,
  mergeGitHubDiscoveryReports,
  type GitHubValidatedRecord
} from "../../discovery/github.js";
import { makeGitHubArchive, makeGitHubFiles, parseBranchRecords } from "../github-dropin.js";
import { githubRepositoryTopics, makeRootReadmeSnippet } from "../publication-profile.js";
import { useAdminStore } from "../store.js";
import { discoverClientBootstrapBeacons } from "../../discovery/client.js";
import { createBootstrapBeaconWrapper } from "../../protocol/v0/bootstrap-beacon.js";

export function GitHubTool(): React.JSX.Element {
  const outputRef = useRef<HTMLTextAreaElement | null>(null);
  const badgeRef = useRef<HTMLTextAreaElement | null>(null);
  const topicsRef = useRef<HTMLInputElement | null>(null);
  const discoveryAbortRef = useRef<AbortController | null>(null);
  const githubTab = useAdminStore((state) => state.githubTab);
  const github = useAdminStore((state) => state.github);
  const setGitHubTab = useAdminStore((state) => state.setGitHubTab);
  const setGitHubMode = useAdminStore((state) => state.setGitHubMode);
  const setGitHubRecords = useAdminStore((state) => state.setGitHubRecords);
  const setGitHubRelayEndpointUri = useAdminStore((state) => state.setGitHubRelayEndpointUri);
  const setGitHubSourceCommit = useAdminStore((state) => state.setGitHubSourceCommit);
  const setGitHubFiles = useAdminStore((state) => state.setGitHubFiles);
  const setGitHubBadgeSnippet = useAdminStore((state) => state.setGitHubBadgeSnippet);
  const setSelectedGitHubFile = useAdminStore((state) => state.setSelectedGitHubFile);
  const setGitHubStatus = useAdminStore((state) => state.setGitHubStatus);
  const setGitHubDiscoveryQuery = useAdminStore((state) => state.setGitHubDiscoveryQuery);
  const setGitHubDiscoveryIncludeForks = useAdminStore((state) => state.setGitHubDiscoveryIncludeForks);
  const setGitHubDiscoveryIncludeLegacyFallback = useAdminStore((state) => state.setGitHubDiscoveryIncludeLegacyFallback);
  const setGitHubDiscoveryPerPage = useAdminStore((state) => state.setGitHubDiscoveryPerPage);
  const setGitHubDiscoveryPage = useAdminStore((state) => state.setGitHubDiscoveryPage);
  const setGitHubDiscoveryRunning = useAdminStore((state) => state.setGitHubDiscoveryRunning);
  const setGitHubDiscoveryResults = useAdminStore((state) => state.setGitHubDiscoveryResults);
  const setGitHubDiscoveryStatus = useAdminStore((state) => state.setGitHubDiscoveryStatus);
  const selectedFile = github.files[github.selectedFile] ?? null;
  const githubTopics = githubRepositoryTopics.join(", ");

  async function onGenerate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const recordsInput = readFormString(formData, "github-records");
    const sourceCommit = readFormString(formData, "source-commit");
    setGitHubRecords(recordsInput);
    setGitHubSourceCommit(sourceCommit);
    try {
      setGitHubStatus("generating", "status-warn");
      const records = await parseBranchRecords(recordsInput, { mode: github.mode });
      const files = await makeGitHubFiles(records, sourceCommit.trim(), Math.floor(Date.now() / 1000), github.mode);
      setGitHubFiles(files);
      setGitHubBadgeSnippet(makeRootReadmeSnippet());
      setGitHubStatus(github.mode === "demo" ? "demo fixture generated" : "live bundle generated", "status-good");
    } catch (error) {
      setGitHubFiles([]);
      setGitHubBadgeSnippet("");
      setGitHubStatus(error instanceof Error ? error.message : "generation failed", "status-bad");
    }
  }

  async function onDiscover(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    discoveryAbortRef.current?.abort();
    const controller = new AbortController();
    discoveryAbortRef.current = controller;
    setGitHubDiscoveryRunning(true);
    setGitHubDiscoveryResults([]);
    setGitHubDiscoveryStatus("searching GitHub", "status-warn");
    try {
      const discovery = await discoverClientBootstrapBeacons({
        carrier: createGitHubSearchCarrier(),
        primaryQuery: github.discoveryQuery,
        fallbackQuery: githubDiscoveryFallbackQuery,
        includeFallback: github.discoveryIncludeLegacyFallback,
        includeForks: github.discoveryIncludeForks,
        perPage: readBoundedInteger(github.discoveryPerPage, 1, 10, 5),
        page: readBoundedInteger(github.discoveryPage, 1, 10, 1),
        signal: controller.signal
      });
      const report = mergeGitHubDiscoveryReports(gitHubReportsFromCarrierReports(discovery.carrierReports));
      setGitHubDiscoveryResults(report.results);
      const incomplete = report.incompleteResults ? ", incomplete" : "";
      const fallback = discovery.carrierReports.length > 1 ? ", fallback searched" : "";
      setGitHubDiscoveryStatus(
        `${discovery.message}${fallback}${incomplete}; rate ${report.rateLimitRemaining ?? "unknown"}`,
        discovery.status === "ok" || discovery.status === "partial"
          ? "status-good"
          : discovery.status === "failed" || discovery.status === "rate_limited"
            ? "status-bad"
            : "status-warn"
      );
    } catch (error) {
      setGitHubDiscoveryStatus(controller.signal.aborted ? "cancelled" : errorMessage(error), controller.signal.aborted ? "status-warn" : "status-bad");
    } finally {
      setGitHubDiscoveryRunning(false);
    }
  }

  function onCancelDiscover(): void {
    discoveryAbortRef.current?.abort();
  }

  async function onGenerateRelayBeacon(): Promise<void> {
    try {
      setGitHubStatus("generating relay bootstrap.beacon", "status-warn");
      const wrapper = await createBootstrapBeaconWrapper({
        relayEndpoints: [{
          transport: "wss",
          uri: github.relayEndpointUri.trim(),
          priority: 0
        }]
      });
      setGitHubMode("live");
      setGitHubRecords(wrapper);
      setGitHubStatus("relay bootstrap.beacon generated", "status-good");
    } catch (error) {
      setGitHubStatus(errorMessage(error), "status-bad");
    }
  }

  return (
    <section className="github-admin" data-panel="github" aria-label="GitHub carrier">
      <div className="ribbon-tabs github-tabs" role="tablist" aria-label="GitHub workflow">
        <button
          aria-controls="github-panel-generate"
          aria-selected={githubTab === "generate"}
          className={`tab${githubTab === "generate" ? " is-active" : ""}`}
          id="github-tab-generate"
          role="tab"
          type="button"
          onClick={() => { setGitHubTab("generate"); }}
        >
          Generate
        </button>
        <button
          aria-controls="github-panel-check"
          aria-selected={githubTab === "check"}
          className={`tab${githubTab === "check" ? " is-active" : ""}`}
          id="github-tab-check"
          role="tab"
          type="button"
          onClick={() => { setGitHubTab("check"); }}
        >
          Check
        </button>
      </div>

      {githubTab === "generate" ? (
        <div className="tool-grid is-active" id="github-panel-generate" role="tabpanel" aria-labelledby="github-tab-generate">
          <form className="panel control-panel" id="github-form" onSubmit={(event) => { void onGenerate(event); }}>
            <div className="control-row">
              <label htmlFor="github-mode">Bundle mode</label>
              <select
                id="github-mode"
                name="github-mode"
                value={github.mode}
                onChange={(event) => { setGitHubMode(event.currentTarget.value === "live" ? "live" : "demo"); }}
              >
                <option value="demo">Demo fixture</option>
                <option value="live">Live publishable</option>
              </select>
            </div>

            <label htmlFor="github-records">BRANCH0 records</label>
            <textarea
              id="github-records"
              name="github-records"
              spellCheck={false}
              rows={9}
              placeholder={defaultBranchWrapper}
              value={github.records}
              onChange={(event) => { setGitHubRecords(event.currentTarget.value); }}
            />

            <div className="control-row">
              <label htmlFor="relay-endpoint-uri">Relay WSS endpoint</label>
              <input
                id="relay-endpoint-uri"
                name="relay-endpoint-uri"
                type="url"
                spellCheck={false}
                value={github.relayEndpointUri}
                onChange={(event) => { setGitHubRelayEndpointUri(event.currentTarget.value); }}
              />
            </div>

            <div className="control-row">
              <label htmlFor="source-commit">Source commit</label>
              <input
                id="source-commit"
                name="source-commit"
                type="text"
                spellCheck={false}
                placeholder="optional-vcs-commit"
                value={github.sourceCommit}
                onChange={(event) => { setGitHubSourceCommit(event.currentTarget.value); }}
              />
            </div>

            <div className="button-row">
              <button
                type="button"
                onClick={() => { void onGenerateRelayBeacon(); }}
              >
                Generate relay beacon
              </button>
              <button type="submit">Generate</button>
              <button
                type="button"
                id="download-bundle"
                disabled={github.files.length === 0}
                onClick={() => { downloadBytes(makeGitHubArchive(github.files), githubBundleFilename, "application/zip"); }}
              >
                Download bundle
              </button>
            </div>
            <p className={github.statusClass}>{github.status}</p>

            <label htmlFor="github-badge-snippet">README badge snippet</label>
            <textarea
              id="github-badge-snippet"
              ref={badgeRef}
              readOnly
              rows={2}
              spellCheck={false}
              value={github.badgeSnippet}
            />
            <label htmlFor="github-topics">GitHub topics</label>
            <input
              id="github-topics"
              ref={topicsRef}
              readOnly
              type="text"
              value={githubTopics}
            />
            <div className="button-row">
              <button
                type="button"
                disabled={github.badgeSnippet === ""}
                onClick={() => { void copyTextFromFallback(github.badgeSnippet, badgeRef.current); }}
              >
                Copy snippet
              </button>
              <button
                type="button"
                onClick={() => { void copyTextFromFallback(githubTopics, topicsRef.current); }}
              >
                Copy topics
              </button>
            </div>
          </form>

          <section className="panel output-panel" aria-label="Generated GitHub files">
            <div className="file-tabs" id="file-tabs" role="tablist" aria-label="Generated files">
              {github.files.map((file, index) => (
                <button
                  className={`file-tab${index === github.selectedFile ? " is-active" : ""}`}
                  key={file.path}
                  type="button"
                  onClick={() => { setSelectedGitHubFile(index); }}
                >
                  {file.path}
                </button>
              ))}
            </div>
            <textarea id="file-output" ref={outputRef} spellCheck={false} readOnly rows={18} value={selectedFile?.content ?? ""} />
            <div className="button-row">
              <button
                type="button"
                id="download-file"
                disabled={selectedFile === null}
                onClick={() => {
                  if (selectedFile !== null) {
                    downloadText(selectedFile.content, selectedFile.path.split("/").pop() ?? "branch-file.txt", selectedFile.type);
                  }
                }}
              >
                Download file
              </button>
              <button
                type="button"
                id="copy-file"
                disabled={selectedFile === null}
                onClick={() => {
                  if (selectedFile !== null) {
                    void copyTextFromFallback(selectedFile.content, outputRef.current);
                  }
                }}
              >
                Copy
              </button>
            </div>
          </section>
        </div>
      ) : (
        <div className="tool-grid is-active" id="github-panel-check" role="tabpanel" aria-labelledby="github-tab-check">
          <form className="panel control-panel github-discovery-panel" id="github-discovery-form" onSubmit={(event) => { void onDiscover(event); }}>
            <label htmlFor="github-discovery-query">Discovery query</label>
            <textarea
              id="github-discovery-query"
              name="github-discovery-query"
              spellCheck={false}
              rows={3}
              value={github.discoveryQuery}
              onChange={(event) => { setGitHubDiscoveryQuery(event.currentTarget.value); }}
            />

            <div className="control-row">
              <label htmlFor="github-discovery-per-page">Page size</label>
              <input
                id="github-discovery-per-page"
                name="github-discovery-per-page"
                type="number"
                min="1"
                max="10"
                value={github.discoveryPerPage}
                onChange={(event) => { setGitHubDiscoveryPerPage(event.currentTarget.value); }}
              />
            </div>

            <div className="control-row">
              <label htmlFor="github-discovery-page">Page</label>
              <input
                id="github-discovery-page"
                name="github-discovery-page"
                type="number"
                min="1"
                max="10"
                value={github.discoveryPage}
                onChange={(event) => { setGitHubDiscoveryPage(event.currentTarget.value); }}
              />
            </div>

            <label className="checkbox-row" htmlFor="github-discovery-forks">
              <input
                id="github-discovery-forks"
                name="github-discovery-forks"
                type="checkbox"
                checked={github.discoveryIncludeForks}
                onChange={(event) => { setGitHubDiscoveryIncludeForks(event.currentTarget.checked); }}
              />
              <span>Include forks</span>
            </label>

            <label className="checkbox-row" htmlFor="github-discovery-fallback">
              <input
                id="github-discovery-fallback"
                name="github-discovery-fallback"
                type="checkbox"
                checked={github.discoveryIncludeLegacyFallback}
                onChange={(event) => { setGitHubDiscoveryIncludeLegacyFallback(event.currentTarget.checked); }}
              />
              <span>Legacy fallback</span>
            </label>

            <div className="button-row">
              <button type="submit" disabled={github.discoveryRunning}>Discover</button>
              <button type="button" disabled={!github.discoveryRunning} onClick={onCancelDiscover}>Cancel</button>
            </div>
            <p className={github.discoveryStatusClass}>{github.discoveryStatus}</p>
          </form>

          <section className="panel output-panel github-discovery-results" aria-label="GitHub discovery results">
            <table>
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>Branch</th>
                  <th>Records</th>
                  <th>Validation</th>
                  <th>Relay endpoint</th>
                  <th>Expiry</th>
                  <th>Profile</th>
                </tr>
              </thead>
              <tbody>
                {github.discoveryResults.map((result) => (
                  <tr key={result.recordsUrl}>
                    <td><a href={result.htmlUrl} rel="noreferrer" target="_blank">{result.repository}</a></td>
                    <td>{result.defaultBranch}{result.fork ? " fork" : ""}</td>
                    <td>{result.wrapperCount}{result.firstWrapperPreview === null ? "" : ` ${result.firstWrapperPreview}`}</td>
                    <td>
                      <strong>{result.acceptedCount}</strong> accepted / <strong>{result.rejectedCount}</strong> rejected
                      {result.reason === null ? "" : `; ${result.reason}`}
                      {result.records.map((record) => (
                        <div className={`record-validation is-${record.validation}`} key={`${result.recordsUrl}-${record.wrapperPreview}`}>
                          {record.validation}: {record.reason}
                        </div>
                      ))}
                    </td>
                    <td>{firstAcceptedValue(result.records, "relayEndpoint") ?? "-"}</td>
                    <td>{formatUnixSeconds(firstAcceptedValue(result.records, "expiresAt"))}</td>
                    <td>{firstAcceptedValue(result.records, "profileMultihash") ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="github-discovery-notes">
              {githubDiscoveryConstraints.map((constraint) => (
                <li key={constraint}>{constraint}</li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </section>
  );
}

function firstAcceptedValue<K extends "relayEndpoint" | "expiresAt" | "profileMultihash">(
  records: readonly GitHubValidatedRecord[],
  key: K
): K extends "expiresAt" ? number | null : string | null {
  const accepted = records.find((record) => record.validation === "accepted");
  return (accepted?.[key] ?? null) as K extends "expiresAt" ? number | null : string | null;
}

function formatUnixSeconds(value: number | null): string {
  if (value === null) {
    return "-";
  }
  return new Date(value * 1000).toISOString();
}

function readFormString(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function readBoundedInteger(value: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "GitHub discovery failed";
}
