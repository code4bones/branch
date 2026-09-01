import { useRef } from "react";

import { copyTextFromFallback, downloadBytes, downloadText } from "../browser-files.js";
import { defaultBranchWrapper, gitLabBundleFilename } from "../defaults.js";
import {
  createGitLabSearchCarrier,
  gitLabDiscoveryConstraints,
  gitLabReportsFromCarrierReports,
  mergeGitLabDiscoveryReports,
  type GitLabValidatedRecord
} from "../../discovery/gitlab.js";
import { makeGitLabArchive, makeGitLabFiles, parseGitLabRecords } from "../gitlab-dropin.js";
import { gitLabProjectDescription, gitLabProjectTopics, makeRootReadmeSnippet } from "../publication-profile.js";
import { useAdminStore } from "../store.js";
import { discoverClientBootstrapBeacons } from "../../discovery/client.js";
import { createBootstrapBeaconWrapper } from "../../protocol/v0/bootstrap-beacon.js";

export function GitLabTool(): React.JSX.Element {
  const outputRef = useRef<HTMLTextAreaElement | null>(null);
  const badgeRef = useRef<HTMLTextAreaElement | null>(null);
  const topicsRef = useRef<HTMLInputElement | null>(null);
  const descriptionRef = useRef<HTMLInputElement | null>(null);
  const discoveryAbortRef = useRef<AbortController | null>(null);
  const gitLabTab = useAdminStore((state) => state.gitLabTab);
  const gitlab = useAdminStore((state) => state.gitlab);
  const setGitLabTab = useAdminStore((state) => state.setGitLabTab);
  const setGitLabMode = useAdminStore((state) => state.setGitLabMode);
  const setGitLabRecords = useAdminStore((state) => state.setGitLabRecords);
  const setGitLabRelayEndpointUri = useAdminStore((state) => state.setGitLabRelayEndpointUri);
  const setGitLabSourceCommit = useAdminStore((state) => state.setGitLabSourceCommit);
  const setGitLabFiles = useAdminStore((state) => state.setGitLabFiles);
  const setGitLabBadgeSnippet = useAdminStore((state) => state.setGitLabBadgeSnippet);
  const setSelectedGitLabFile = useAdminStore((state) => state.setSelectedGitLabFile);
  const setGitLabStatus = useAdminStore((state) => state.setGitLabStatus);
  const setGitLabDiscoveryQuery = useAdminStore((state) => state.setGitLabDiscoveryQuery);
  const setGitLabDiscoveryPerPage = useAdminStore((state) => state.setGitLabDiscoveryPerPage);
  const setGitLabDiscoveryPage = useAdminStore((state) => state.setGitLabDiscoveryPage);
  const setGitLabDiscoveryRunning = useAdminStore((state) => state.setGitLabDiscoveryRunning);
  const setGitLabDiscoveryResults = useAdminStore((state) => state.setGitLabDiscoveryResults);
  const setGitLabDiscoveryStatus = useAdminStore((state) => state.setGitLabDiscoveryStatus);
  const selectedFile = gitlab.files[gitlab.selectedFile] ?? null;
  const gitLabTopics = gitLabProjectTopics.join(", ");

  async function onGenerate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const recordsInput = readFormString(formData, "gitlab-records");
    const sourceCommit = readFormString(formData, "gitlab-source-commit");
    setGitLabRecords(recordsInput);
    setGitLabSourceCommit(sourceCommit);
    try {
      setGitLabStatus("generating", "status-warn");
      const records = await parseGitLabRecords(recordsInput, { mode: gitlab.mode });
      const files = await makeGitLabFiles(records, sourceCommit.trim(), Math.floor(Date.now() / 1000), gitlab.mode);
      setGitLabFiles(files);
      setGitLabBadgeSnippet(makeRootReadmeSnippet());
      setGitLabStatus(gitlab.mode === "demo" ? "demo fixture generated" : "live bundle generated", "status-good");
    } catch (error) {
      setGitLabFiles([]);
      setGitLabBadgeSnippet("");
      setGitLabStatus(errorMessage(error), "status-bad");
    }
  }

  async function onDiscover(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    discoveryAbortRef.current?.abort();
    const controller = new AbortController();
    discoveryAbortRef.current = controller;
    setGitLabDiscoveryRunning(true);
    setGitLabDiscoveryResults([]);
    setGitLabDiscoveryStatus("searching GitLab projects", "status-warn");
    try {
      const discovery = await discoverClientBootstrapBeacons({
        carrier: createGitLabSearchCarrier(),
        primaryQuery: gitlab.discoveryQuery,
        fallbackQuery: null,
        includeFallback: false,
        includeForks: false,
        perPage: readBoundedInteger(gitlab.discoveryPerPage, 1, 10, 5),
        page: readBoundedInteger(gitlab.discoveryPage, 1, 10, 1),
        signal: controller.signal
      });
      const report = mergeGitLabDiscoveryReports(gitLabReportsFromCarrierReports(discovery.carrierReports));
      setGitLabDiscoveryResults(report.results);
      const incomplete = report.incompleteResults ? ", more pages" : "";
      setGitLabDiscoveryStatus(
        `${discovery.message}${incomplete}; rate ${report.rateLimitRemaining ?? "unknown"}`,
        discovery.status === "ok" || discovery.status === "partial"
          ? "status-good"
          : discovery.status === "failed" || discovery.status === "rate_limited"
            ? "status-bad"
            : "status-warn"
      );
    } catch (error) {
      setGitLabDiscoveryStatus(controller.signal.aborted ? "cancelled" : errorMessage(error), controller.signal.aborted ? "status-warn" : "status-bad");
    } finally {
      setGitLabDiscoveryRunning(false);
    }
  }

  async function onGenerateRelayBeacon(): Promise<void> {
    try {
      setGitLabStatus("generating relay bootstrap.beacon", "status-warn");
      const wrapper = await createBootstrapBeaconWrapper({
        relayEndpoints: [{
          transport: "wss",
          uri: gitlab.relayEndpointUri.trim(),
          priority: 0
        }]
      });
      setGitLabMode("live");
      setGitLabRecords(wrapper);
      setGitLabStatus("relay bootstrap.beacon generated", "status-good");
    } catch (error) {
      setGitLabStatus(errorMessage(error), "status-bad");
    }
  }

  return (
    <section className="github-admin" data-panel="gitlab" aria-label="GitLab carrier">
      <div className="ribbon-tabs github-tabs" role="tablist" aria-label="GitLab workflow">
        <button
          aria-controls="gitlab-panel-generate"
          aria-selected={gitLabTab === "generate"}
          className={`tab${gitLabTab === "generate" ? " is-active" : ""}`}
          id="gitlab-tab-generate"
          role="tab"
          type="button"
          onClick={() => { setGitLabTab("generate"); }}
        >
          Generate
        </button>
        <button
          aria-controls="gitlab-panel-check"
          aria-selected={gitLabTab === "check"}
          className={`tab${gitLabTab === "check" ? " is-active" : ""}`}
          id="gitlab-tab-check"
          role="tab"
          type="button"
          onClick={() => { setGitLabTab("check"); }}
        >
          Check
        </button>
      </div>

      {gitLabTab === "generate" ? (
        <div className="tool-grid is-active" id="gitlab-panel-generate" role="tabpanel" aria-labelledby="gitlab-tab-generate">
          <form className="panel control-panel" id="gitlab-form" onSubmit={(event) => { void onGenerate(event); }}>
            <div className="control-row">
              <label htmlFor="gitlab-mode">Bundle mode</label>
              <select
                id="gitlab-mode"
                name="gitlab-mode"
                value={gitlab.mode}
                onChange={(event) => { setGitLabMode(event.currentTarget.value === "live" ? "live" : "demo"); }}
              >
                <option value="demo">Demo fixture</option>
                <option value="live">Live publishable</option>
              </select>
            </div>

            <label htmlFor="gitlab-records">BRANCH0 records</label>
            <textarea
              id="gitlab-records"
              name="gitlab-records"
              spellCheck={false}
              rows={9}
              placeholder={defaultBranchWrapper}
              value={gitlab.records}
              onChange={(event) => { setGitLabRecords(event.currentTarget.value); }}
            />

            <div className="control-row">
              <label htmlFor="gitlab-relay-endpoint-uri">Relay WSS endpoint</label>
              <input
                id="gitlab-relay-endpoint-uri"
                name="gitlab-relay-endpoint-uri"
                type="url"
                spellCheck={false}
                value={gitlab.relayEndpointUri}
                onChange={(event) => { setGitLabRelayEndpointUri(event.currentTarget.value); }}
              />
            </div>

            <div className="control-row">
              <label htmlFor="gitlab-source-commit">Source commit</label>
              <input
                id="gitlab-source-commit"
                name="gitlab-source-commit"
                type="text"
                spellCheck={false}
                placeholder="optional-vcs-commit"
                value={gitlab.sourceCommit}
                onChange={(event) => { setGitLabSourceCommit(event.currentTarget.value); }}
              />
            </div>

            <div className="button-row">
              <button type="button" onClick={() => { void onGenerateRelayBeacon(); }}>
                Generate relay beacon
              </button>
              <button type="submit">Generate</button>
              <button
                type="button"
                id="download-gitlab-bundle"
                disabled={gitlab.files.length === 0}
                onClick={() => { downloadBytes(makeGitLabArchive(gitlab.files), gitLabBundleFilename, "application/zip"); }}
              >
                Download bundle
              </button>
            </div>
            <p className={gitlab.statusClass}>{gitlab.status}</p>

            <label htmlFor="gitlab-badge-snippet">README badge snippet</label>
            <textarea
              id="gitlab-badge-snippet"
              ref={badgeRef}
              readOnly
              rows={2}
              spellCheck={false}
              value={gitlab.badgeSnippet}
            />
            <label htmlFor="gitlab-description">GitLab project description</label>
            <input
              id="gitlab-description"
              ref={descriptionRef}
              readOnly
              type="text"
              value={gitLabProjectDescription}
            />
            <label htmlFor="gitlab-topics">GitLab topics</label>
            <input
              id="gitlab-topics"
              ref={topicsRef}
              readOnly
              type="text"
              value={gitLabTopics}
            />
            <div className="button-row">
              <button
                type="button"
                disabled={gitlab.badgeSnippet === ""}
                onClick={() => { void copyTextFromFallback(gitlab.badgeSnippet, badgeRef.current); }}
              >
                Copy snippet
              </button>
              <button
                type="button"
                onClick={() => { void copyTextFromFallback(gitLabProjectDescription, descriptionRef.current); }}
              >
                Copy description
              </button>
              <button
                type="button"
                onClick={() => { void copyTextFromFallback(gitLabTopics, topicsRef.current); }}
              >
                Copy topics
              </button>
            </div>
          </form>

          <section className="panel output-panel" aria-label="Generated GitLab files">
            <div className="file-tabs" id="gitlab-file-tabs" role="tablist" aria-label="Generated files">
              {gitlab.files.map((file, index) => (
                <button
                  className={`file-tab${index === gitlab.selectedFile ? " is-active" : ""}`}
                  key={file.path}
                  type="button"
                  onClick={() => { setSelectedGitLabFile(index); }}
                >
                  {file.path}
                </button>
              ))}
            </div>
            <textarea id="gitlab-file-output" ref={outputRef} spellCheck={false} readOnly rows={18} value={selectedFile?.content ?? ""} />
            <div className="button-row">
              <button
                type="button"
                id="download-gitlab-file"
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
                id="copy-gitlab-file"
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
        <div className="tool-grid is-active" id="gitlab-panel-check" role="tabpanel" aria-labelledby="gitlab-tab-check">
          <form className="panel control-panel github-discovery-panel" id="gitlab-discovery-form" onSubmit={(event) => { void onDiscover(event); }}>
            <label htmlFor="gitlab-discovery-query">Discovery query</label>
            <textarea
              id="gitlab-discovery-query"
              name="gitlab-discovery-query"
              spellCheck={false}
              rows={3}
              value={gitlab.discoveryQuery}
              onChange={(event) => { setGitLabDiscoveryQuery(event.currentTarget.value); }}
            />

            <div className="control-row">
              <label htmlFor="gitlab-discovery-per-page">Page size</label>
              <input
                id="gitlab-discovery-per-page"
                name="gitlab-discovery-per-page"
                type="number"
                min="1"
                max="10"
                value={gitlab.discoveryPerPage}
                onChange={(event) => { setGitLabDiscoveryPerPage(event.currentTarget.value); }}
              />
            </div>

            <div className="control-row">
              <label htmlFor="gitlab-discovery-page">Page</label>
              <input
                id="gitlab-discovery-page"
                name="gitlab-discovery-page"
                type="number"
                min="1"
                max="10"
                value={gitlab.discoveryPage}
                onChange={(event) => { setGitLabDiscoveryPage(event.currentTarget.value); }}
              />
            </div>

            <div className="button-row">
              <button type="submit" disabled={gitlab.discoveryRunning}>Discover</button>
              <button type="button" disabled={!gitlab.discoveryRunning} onClick={() => { discoveryAbortRef.current?.abort(); }}>Cancel</button>
            </div>
            <p className={gitlab.discoveryStatusClass}>{gitlab.discoveryStatus}</p>
          </form>

          <section className="panel output-panel github-discovery-results" aria-label="GitLab discovery results">
            <table>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Branch</th>
                  <th>Records</th>
                  <th>Validation</th>
                  <th>Relay endpoint</th>
                  <th>Expiry</th>
                  <th>Profile</th>
                </tr>
              </thead>
              <tbody>
                {gitlab.discoveryResults.map((result) => (
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
              {gitLabDiscoveryConstraints.map((constraint) => (
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
  records: readonly GitLabValidatedRecord[],
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
  return error instanceof Error ? error.message : "GitLab discovery failed";
}
