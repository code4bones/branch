import {
  CopyOutlined,
  DownloadOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
  SearchOutlined,
  StopOutlined,
  SyncOutlined
} from "@ant-design/icons";
import { Button, Checkbox, Input, InputNumber, Segmented, Select, Space, Table, Tag, type TableColumnsType } from "antd";
import { useRef } from "react";

import { copyTextFromFallback, downloadBytes, downloadText } from "../browser-files.js";
import { defaultBranchWrapper, githubBundleFilename } from "../defaults.js";
import {
  createGitHubSearchCarrier,
  gitHubReportsFromCarrierReports,
  githubDiscoveryConstraints,
  githubDiscoveryFallbackQuery,
  mergeGitHubDiscoveryReports,
  type GitHubDiscoveryResult,
  type GitHubValidatedRecord
} from "@code4bones/branch-core/discovery/github.js";
import { makeGitHubArchive, makeGitHubFiles, parseBranchRecords } from "../github-dropin.js";
import { githubRepositoryTopics, makeRootReadmeSnippet } from "../publication-profile.js";
import { fetchRelayBootstrapBeacon } from "../relay-bootstrap.js";
import { useAdminStore } from "../store.js";
import { discoverClientBootstrapBeacons } from "@code4bones/branch-core/discovery/client.js";

export function GitHubTool(): React.JSX.Element {
  const discoveryAbortRef = useRef<AbortController | null>(null);
  const githubTab = useAdminStore((state) => state.githubTab);
  const github = useAdminStore((state) => state.github);
  const setGitHubTab = useAdminStore((state) => state.setGitHubTab);
  const setGitHubMode = useAdminStore((state) => state.setGitHubMode);
  const setGitHubRecords = useAdminStore((state) => state.setGitHubRecords);
  const setGitHubRelayEndpointUri = useAdminStore((state) => state.setGitHubRelayEndpointUri);
  const setGitHubRelayAdminBaseUrl = useAdminStore((state) => state.setGitHubRelayAdminBaseUrl);
  const setGitHubRelayAdminToken = useAdminStore((state) => state.setGitHubRelayAdminToken);
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
    const recordsInput = github.records;
    const sourceCommit = github.sourceCommit;
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
      setGitHubStatus("fetching relay-owned bootstrap.beacon", "status-warn");
      const beacon = await fetchRelayBootstrapBeacon({
        adminBaseUrl: github.relayAdminBaseUrl,
        adminToken: github.relayAdminToken,
        endpointUri: github.relayEndpointUri
      });
      setGitHubMode("live");
      setGitHubRecords(beacon.wrapper);
      setGitHubStatus(`relay bootstrap.beacon fetched ${shortId(beacon.relay_public_key)}`, "status-good");
    } catch (error) {
      setGitHubStatus(errorMessage(error), "status-bad");
    }
  }

  return (
    <section className="github-admin" data-panel="github" aria-label="GitHub carrier">
      <Segmented
        block
        className="workflow-segmented"
        id="github-workflow"
        options={[
          { label: "Generate", value: "generate" },
          { label: "Check", value: "check" }
        ]}
        value={githubTab}
        onChange={(value) => { setGitHubTab(value === "check" ? "check" : "generate"); }}
      />

      {githubTab === "generate" ? (
        <div className="tool-grid is-active" id="github-panel-generate" role="tabpanel" aria-labelledby="github-tab-generate">
          <form className="panel control-panel" id="github-form" onSubmit={(event) => { void onGenerate(event); }}>
            <div className="control-row">
              <label htmlFor="github-mode">Bundle mode</label>
              <Select
                id="github-mode"
                options={[
                  { label: "Demo fixture", value: "demo" },
                  { label: "Live publishable", value: "live" }
                ]}
                value={github.mode}
                onChange={(value) => { setGitHubMode(value); }}
              />
            </div>

            <label htmlFor="github-records">BRANCH0 records</label>
            <Input.TextArea
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
              <Input
                id="relay-endpoint-uri"
                name="relay-endpoint-uri"
                type="url"
                spellCheck={false}
                value={github.relayEndpointUri}
                onChange={(event) => { setGitHubRelayEndpointUri(event.currentTarget.value); }}
              />
            </div>

            <div className="control-row">
              <label htmlFor="github-relay-admin-url">Relay admin URL</label>
              <Input
                id="github-relay-admin-url"
                name="github-relay-admin-url"
                type="text"
                spellCheck={false}
                value={github.relayAdminBaseUrl}
                onChange={(event) => { setGitHubRelayAdminBaseUrl(event.currentTarget.value); }}
              />
            </div>

            <div className="control-row">
              <label htmlFor="github-relay-admin-token">Relay admin token</label>
              <Input.Password
                autoComplete="off"
                id="github-relay-admin-token"
                name="github-relay-admin-token"
                value={github.relayAdminToken}
                onChange={(event) => { setGitHubRelayAdminToken(event.currentTarget.value); }}
              />
            </div>

            <div className="control-row">
              <label htmlFor="source-commit">Source commit</label>
              <Input
                id="source-commit"
                name="source-commit"
                type="text"
                spellCheck={false}
                placeholder="optional-vcs-commit"
                value={github.sourceCommit}
                onChange={(event) => { setGitHubSourceCommit(event.currentTarget.value); }}
              />
            </div>

            <Space wrap>
              <Button icon={<SyncOutlined />} onClick={() => { void onGenerateRelayBeacon(); }}>
                Fetch relay beacon
              </Button>
              <Button htmlType="submit" icon={<PlayCircleOutlined />} type="primary">Generate</Button>
              <Button
                icon={<DownloadOutlined />}
                id="download-bundle"
                disabled={github.files.length === 0}
                onClick={() => { downloadBytes(makeGitHubArchive(github.files), githubBundleFilename, "application/zip"); }}
              >
                Download bundle
              </Button>
            </Space>
            <p className={github.statusClass}>{github.status}</p>

            <label htmlFor="github-badge-snippet">README badge snippet</label>
            <Input.TextArea
              id="github-badge-snippet"
              readOnly
              rows={2}
              spellCheck={false}
              value={github.badgeSnippet}
            />
            <label htmlFor="github-topics">GitHub topics</label>
            <Input
              id="github-topics"
              readOnly
              type="text"
              value={githubTopics}
            />
            <Space wrap>
              <Button
                icon={<CopyOutlined />}
                disabled={github.badgeSnippet === ""}
                onClick={() => { void copyTextFromFallback(github.badgeSnippet, null); }}
              >
                Copy snippet
              </Button>
              <Button
                icon={<CopyOutlined />}
                onClick={() => { void copyTextFromFallback(githubTopics, null); }}
              >
                Copy topics
              </Button>
            </Space>
          </form>

          <section className="panel output-panel" aria-label="Generated GitHub files">
            <Segmented
              block
              className="file-segmented"
              id="file-tabs"
              options={github.files.map((file, index) => ({ label: file.path, value: index }))}
              value={github.selectedFile}
              onChange={(value) => { setSelectedGitHubFile(typeof value === "number" ? value : Number(value)); }}
            />
            <Input.TextArea id="file-output" spellCheck={false} readOnly rows={18} value={selectedFile?.content ?? ""} />
            <Space wrap>
              <Button
                icon={<FileTextOutlined />}
                id="download-file"
                disabled={selectedFile === null}
                onClick={() => {
                  if (selectedFile !== null) {
                    downloadText(selectedFile.content, selectedFile.path.split("/").pop() ?? "branch-file.txt", selectedFile.type);
                  }
                }}
              >
                Download file
              </Button>
              <Button
                icon={<CopyOutlined />}
                id="copy-file"
                disabled={selectedFile === null}
                onClick={() => {
                  if (selectedFile !== null) {
                    void copyTextFromFallback(selectedFile.content, null);
                  }
                }}
              >
                Copy
              </Button>
            </Space>
          </section>
        </div>
      ) : (
        <section className="github-discovery-layout" id="github-panel-check" role="tabpanel" aria-labelledby="github-tab-check">
          <form className="panel control-panel github-discovery-summary" id="github-discovery-form" onSubmit={(event) => { void onDiscover(event); }}>
            <div className="github-discovery-controls">
              <div className="github-discovery-query-field">
                <label htmlFor="github-discovery-query">Discovery query</label>
                <Input.TextArea
                  id="github-discovery-query"
                  name="github-discovery-query"
                  spellCheck={false}
                  rows={2}
                  value={github.discoveryQuery}
                  onChange={(event) => { setGitHubDiscoveryQuery(event.currentTarget.value); }}
                />
              </div>

              <div className="control-row">
                <label htmlFor="github-discovery-per-page">Page size</label>
                <InputNumber
                  id="github-discovery-per-page"
                  min="1"
                  max="10"
                  stringMode
                  value={github.discoveryPerPage}
                  onChange={(value) => { setGitHubDiscoveryPerPage(value ?? ""); }}
                />
              </div>

              <div className="control-row">
                <label htmlFor="github-discovery-page">Page</label>
                <InputNumber
                  id="github-discovery-page"
                  min="1"
                  max="10"
                  stringMode
                  value={github.discoveryPage}
                  onChange={(value) => { setGitHubDiscoveryPage(value ?? ""); }}
                />
              </div>

              <Space className="github-discovery-options" direction="vertical" size={6}>
                <Checkbox
                  id="github-discovery-forks"
                  checked={github.discoveryIncludeForks}
                  onChange={(event) => { setGitHubDiscoveryIncludeForks(event.target.checked); }}
                >
                  Include forks
                </Checkbox>

                <Checkbox
                  id="github-discovery-fallback"
                  checked={github.discoveryIncludeLegacyFallback}
                  onChange={(event) => { setGitHubDiscoveryIncludeLegacyFallback(event.target.checked); }}
                >
                  Legacy fallback
                </Checkbox>
              </Space>

              <Space className="github-discovery-actions" wrap>
                <Button htmlType="submit" icon={<SearchOutlined />} type="primary" disabled={github.discoveryRunning}>Discover</Button>
                <Button icon={<StopOutlined />} disabled={!github.discoveryRunning} onClick={onCancelDiscover}>Cancel</Button>
              </Space>

              <p className={github.discoveryStatusClass}>{github.discoveryStatus}</p>
            </div>
          </form>

          <section className="panel output-panel github-discovery-results" aria-label="GitHub discovery results">
            <Table
              columns={githubDiscoveryColumns}
              dataSource={[...github.discoveryResults]}
              pagination={{ pageSize: 8, showSizeChanger: true }}
              rowKey="recordsUrl"
              scroll={{ x: 1120 }}
              size="small"
            />
            <ul className="github-discovery-notes">
              {githubDiscoveryConstraints.map((constraint) => (
                <li key={constraint}>{constraint}</li>
              ))}
            </ul>
          </section>
        </section>
      )}
    </section>
  );
}

const githubDiscoveryColumns: TableColumnsType<GitHubDiscoveryResult> = [
  {
    title: "Repository",
    dataIndex: "repository",
    key: "repository",
    sorter: (left, right) => left.repository.localeCompare(right.repository),
    render: (value: string, result) => <a href={result.htmlUrl} rel="noreferrer" target="_blank">{value}</a>
  },
  {
    title: "Branch",
    key: "branch",
    sorter: (left, right) => left.defaultBranch.localeCompare(right.defaultBranch),
    render: (_, result) => `${result.defaultBranch}${result.fork ? " fork" : ""}`
  },
  {
    title: "Records",
    key: "records",
    sorter: (left, right) => left.wrapperCount - right.wrapperCount,
    render: (_, result) => (
      <>
        <strong>{result.wrapperCount}</strong>
        {result.firstWrapperPreview === null ? "" : ` ${result.firstWrapperPreview}`}
      </>
    )
  },
  {
    title: "Validation",
    key: "validation",
    sorter: (left, right) => left.acceptedCount - right.acceptedCount || left.rejectedCount - right.rejectedCount,
    render: (_, result) => (
      <Space direction="vertical" size={4}>
        <span>
          <Tag color="green">{result.acceptedCount} accepted</Tag>
          <Tag color={result.rejectedCount > 0 ? "red" : "default"}>{result.rejectedCount} rejected</Tag>
        </span>
        {result.reason === null ? null : <span className="table-muted">{result.reason}</span>}
        {result.records.map((record) => (
          <span className={`record-validation is-${record.validation}`} key={`${result.recordsUrl}-${record.wrapperPreview}`}>
            {record.validation}: {record.reason}
          </span>
        ))}
      </Space>
    )
  },
  {
    title: "Relay endpoint",
    key: "relayEndpoint",
    sorter: (left, right) => textValue(left, "relayEndpoint").localeCompare(textValue(right, "relayEndpoint")),
    render: (_, result) => <span className="mono-cell">{firstAcceptedValue(result.records, "relayEndpoint") ?? "-"}</span>
  },
  {
    title: "Expiry",
    key: "expiresAt",
    sorter: (left, right) => (firstAcceptedValue(left.records, "expiresAt") ?? 0) - (firstAcceptedValue(right.records, "expiresAt") ?? 0),
    render: (_, result) => formatUnixSeconds(firstAcceptedValue(result.records, "expiresAt"))
  },
  {
    title: "Profile",
    key: "profile",
    sorter: (left, right) => textValue(left, "profileMultihash").localeCompare(textValue(right, "profileMultihash")),
    render: (_, result) => <span className="mono-cell">{firstAcceptedValue(result.records, "profileMultihash") ?? "-"}</span>
  }
];

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

function textValue(result: GitHubDiscoveryResult, key: "relayEndpoint" | "profileMultihash"): string {
  return firstAcceptedValue(result.records, key) ?? "";
}

function readBoundedInteger(value: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function shortId(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 14)}...`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "GitHub discovery failed";
}
