import {
  CopyOutlined,
  DownloadOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
  SearchOutlined,
  StopOutlined,
  SyncOutlined
} from "@ant-design/icons";
import { Button, Input, InputNumber, Segmented, Select, Space, Table, Tag, type TableColumnsType } from "antd";
import { useMemo, useRef, useState } from "react";

import { copyTextFromFallback, downloadBytes, downloadText } from "../browser-files.js";
import { defaultBranchWrapper, gitLabBundleFilename } from "../defaults.js";
import {
  createGitLabSearchCarrier,
  gitLabDiscoveryConstraints,
  gitLabReportsFromCarrierReports,
  mergeGitLabDiscoveryReports,
  type GitLabDiscoveryResult,
  type GitLabValidatedRecord
} from "@code4bones/branch-core/discovery/gitlab.js";
import { makeGitLabArchive, makeGitLabFiles, parseGitLabRecords } from "../gitlab-dropin.js";
import { gitLabProjectDescription, gitLabProjectTopics, makeRootReadmeSnippet } from "../publication-profile.js";
import { fetchRelayBootstrapBeacon } from "../relay-bootstrap.js";
import { useAdminStore } from "../store.js";
import { discoverClientBootstrapBeacons } from "@code4bones/branch-core/discovery/client.js";

export function GitLabTool(): React.JSX.Element {
  const discoveryAbortRef = useRef<AbortController | null>(null);
  const [resultSearch, setResultSearch] = useState("");
  const gitLabTab = useAdminStore((state) => state.gitLabTab);
  const gitlab = useAdminStore((state) => state.gitlab);
  const setGitLabTab = useAdminStore((state) => state.setGitLabTab);
  const setGitLabMode = useAdminStore((state) => state.setGitLabMode);
  const setGitLabRecords = useAdminStore((state) => state.setGitLabRecords);
  const setGitLabRelayEndpointUri = useAdminStore((state) => state.setGitLabRelayEndpointUri);
  const setGitLabRelayAdminBaseUrl = useAdminStore((state) => state.setGitLabRelayAdminBaseUrl);
  const setGitLabRelayAdminToken = useAdminStore((state) => state.setGitLabRelayAdminToken);
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
  const visibleDiscoveryResults = useMemo(
    () => filterDiscoveryResults(gitlab.discoveryResults, resultSearch),
    [gitlab.discoveryResults, resultSearch]
  );

  async function onGenerate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const recordsInput = gitlab.records;
    const sourceCommit = gitlab.sourceCommit;
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
      setGitLabStatus("fetching relay-owned bootstrap.beacon", "status-warn");
      const beacon = await fetchRelayBootstrapBeacon({
        adminBaseUrl: gitlab.relayAdminBaseUrl,
        adminToken: gitlab.relayAdminToken,
        endpointUri: gitlab.relayEndpointUri
      });
      setGitLabMode("live");
      setGitLabRecords(beacon.wrapper);
      setGitLabStatus(`relay bootstrap.beacon fetched ${shortId(beacon.relay_public_key)}`, "status-good");
    } catch (error) {
      setGitLabStatus(errorMessage(error), "status-bad");
    }
  }

  return (
    <section className="github-admin" data-panel="gitlab" aria-label="GitLab carrier">
      <Segmented
        block
        className="workflow-segmented"
        id="gitlab-workflow"
        options={[
          { label: "Generate", value: "generate" },
          { label: "Check", value: "check" }
        ]}
        value={gitLabTab}
        onChange={(value) => { setGitLabTab(value === "check" ? "check" : "generate"); }}
      />

      {gitLabTab === "generate" ? (
        <div className="tool-grid is-active" id="gitlab-panel-generate" role="tabpanel" aria-labelledby="gitlab-tab-generate">
          <form className="panel control-panel" id="gitlab-form" onSubmit={(event) => { void onGenerate(event); }}>
            <div className="control-row">
              <label htmlFor="gitlab-mode">Bundle mode</label>
              <Select
                id="gitlab-mode"
                options={[
                  { label: "Demo fixture", value: "demo" },
                  { label: "Live publishable", value: "live" }
                ]}
                value={gitlab.mode}
                onChange={(value) => { setGitLabMode(value); }}
              />
            </div>

            <label htmlFor="gitlab-records">BRANCH0 records</label>
            <Input.TextArea
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
              <Input
                id="gitlab-relay-endpoint-uri"
                name="gitlab-relay-endpoint-uri"
                type="url"
                spellCheck={false}
                value={gitlab.relayEndpointUri}
                onChange={(event) => { setGitLabRelayEndpointUri(event.currentTarget.value); }}
              />
            </div>

            <div className="control-row">
              <label htmlFor="gitlab-relay-admin-url">Relay admin URL</label>
              <Input
                id="gitlab-relay-admin-url"
                name="gitlab-relay-admin-url"
                type="text"
                spellCheck={false}
                value={gitlab.relayAdminBaseUrl}
                onChange={(event) => { setGitLabRelayAdminBaseUrl(event.currentTarget.value); }}
              />
            </div>

            <div className="control-row">
              <label htmlFor="gitlab-relay-admin-token">Relay admin token</label>
              <Input.Password
                autoComplete="off"
                id="gitlab-relay-admin-token"
                name="gitlab-relay-admin-token"
                value={gitlab.relayAdminToken}
                onChange={(event) => { setGitLabRelayAdminToken(event.currentTarget.value); }}
              />
            </div>

            <div className="control-row">
              <label htmlFor="gitlab-source-commit">Source commit</label>
              <Input
                id="gitlab-source-commit"
                name="gitlab-source-commit"
                type="text"
                spellCheck={false}
                placeholder="optional-vcs-commit"
                value={gitlab.sourceCommit}
                onChange={(event) => { setGitLabSourceCommit(event.currentTarget.value); }}
              />
            </div>

            <Space wrap>
              <Button icon={<SyncOutlined />} onClick={() => { void onGenerateRelayBeacon(); }}>
                Fetch relay beacon
              </Button>
              <Button htmlType="submit" icon={<PlayCircleOutlined />} type="primary">Generate</Button>
              <Button
                icon={<DownloadOutlined />}
                id="download-gitlab-bundle"
                disabled={gitlab.files.length === 0}
                onClick={() => { downloadBytes(makeGitLabArchive(gitlab.files), gitLabBundleFilename, "application/zip"); }}
              >
                Download bundle
              </Button>
            </Space>
            <p className={gitlab.statusClass}>{gitlab.status}</p>

            <label htmlFor="gitlab-badge-snippet">README badge snippet</label>
            <Input.TextArea
              id="gitlab-badge-snippet"
              readOnly
              rows={2}
              spellCheck={false}
              value={gitlab.badgeSnippet}
            />
            <label htmlFor="gitlab-description">GitLab project description</label>
            <Input
              id="gitlab-description"
              readOnly
              type="text"
              value={gitLabProjectDescription}
            />
            <label htmlFor="gitlab-topics">GitLab topics</label>
            <Input
              id="gitlab-topics"
              readOnly
              type="text"
              value={gitLabTopics}
            />
            <Space wrap>
              <Button
                icon={<CopyOutlined />}
                disabled={gitlab.badgeSnippet === ""}
                onClick={() => { void copyTextFromFallback(gitlab.badgeSnippet, null); }}
              >
                Copy snippet
              </Button>
              <Button
                icon={<CopyOutlined />}
                onClick={() => { void copyTextFromFallback(gitLabProjectDescription, null); }}
              >
                Copy description
              </Button>
              <Button
                icon={<CopyOutlined />}
                onClick={() => { void copyTextFromFallback(gitLabTopics, null); }}
              >
                Copy topics
              </Button>
            </Space>
          </form>

          <section className="panel output-panel" aria-label="Generated GitLab files">
            <Segmented
              block
              className="file-segmented"
              id="gitlab-file-tabs"
              options={gitlab.files.map((file, index) => ({ label: file.path, value: index }))}
              value={gitlab.selectedFile}
              onChange={(value) => { setSelectedGitLabFile(typeof value === "number" ? value : Number(value)); }}
            />
            <Input.TextArea id="gitlab-file-output" spellCheck={false} readOnly rows={18} value={selectedFile?.content ?? ""} />
            <Space wrap>
              <Button
                icon={<FileTextOutlined />}
                id="download-gitlab-file"
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
                id="copy-gitlab-file"
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
        <section className="github-discovery-layout" id="gitlab-panel-check" role="tabpanel" aria-labelledby="gitlab-tab-check">
          <form className="panel control-panel github-discovery-summary" id="gitlab-discovery-form" onSubmit={(event) => { void onDiscover(event); }}>
            <div className="github-discovery-controls gitlab-discovery-controls">
              <div className="github-discovery-query-field">
                <label htmlFor="gitlab-discovery-query">Discovery query</label>
                <Input.TextArea
                  id="gitlab-discovery-query"
                  name="gitlab-discovery-query"
                  spellCheck={false}
                  rows={2}
                  value={gitlab.discoveryQuery}
                  onChange={(event) => { setGitLabDiscoveryQuery(event.currentTarget.value); }}
                />
              </div>

              <div className="control-row">
                <label htmlFor="gitlab-discovery-per-page">Page size</label>
                <InputNumber
                  id="gitlab-discovery-per-page"
                  min="1"
                  max="10"
                  stringMode
                  value={gitlab.discoveryPerPage}
                  onChange={(value) => { setGitLabDiscoveryPerPage(value ?? ""); }}
                />
              </div>

              <div className="control-row">
                <label htmlFor="gitlab-discovery-page">Page</label>
                <InputNumber
                  id="gitlab-discovery-page"
                  min="1"
                  max="10"
                  stringMode
                  value={gitlab.discoveryPage}
                  onChange={(value) => { setGitLabDiscoveryPage(value ?? ""); }}
                />
              </div>

              <Space className="github-discovery-actions" wrap>
                <Button htmlType="submit" icon={<SearchOutlined />} type="primary" disabled={gitlab.discoveryRunning}>Discover</Button>
                <Button icon={<StopOutlined />} disabled={!gitlab.discoveryRunning} onClick={() => { discoveryAbortRef.current?.abort(); }}>Cancel</Button>
              </Space>
              <p className={gitlab.discoveryStatusClass}>{gitlab.discoveryStatus}</p>
            </div>
          </form>

          <section className="panel output-panel github-discovery-results" aria-label="GitLab discovery results">
            <div className="table-toolbar">
              <Input.Search
                allowClear
                aria-label="Filter GitLab discovery results"
                placeholder="Filter project, endpoint, validation"
                value={resultSearch}
                onChange={(event) => { setResultSearch(event.currentTarget.value); }}
              />
              <span className="table-muted">{String(visibleDiscoveryResults.length)} of {String(gitlab.discoveryResults.length)}</span>
            </div>
            <Table
              columns={gitLabDiscoveryColumns}
              dataSource={[...visibleDiscoveryResults]}
              pagination={{ pageSize: 8, showSizeChanger: true }}
              rowKey="recordsUrl"
              scroll={{ x: 1120 }}
              size="small"
            />
            <ul className="github-discovery-notes">
              {gitLabDiscoveryConstraints.map((constraint) => (
                <li key={constraint}>{constraint}</li>
              ))}
            </ul>
          </section>
        </section>
      )}
    </section>
  );
}

function filterDiscoveryResults(
  results: readonly GitLabDiscoveryResult[],
  query: string
): readonly GitLabDiscoveryResult[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return results;
  }
  return results.filter((result) => [
    result.repository,
    result.defaultBranch,
    result.reason ?? "",
    result.recordsUrl,
    ...result.records.flatMap((record) => [
      record.reason,
      record.validation,
      record.wrapperPreview,
      record.relayEndpoint ?? "",
      record.profileMultihash ?? ""
    ])
  ].some((value) => value.toLowerCase().includes(needle)));
}

const gitLabDiscoveryColumns: TableColumnsType<GitLabDiscoveryResult> = [
  {
    title: "Project",
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

function textValue(result: GitLabDiscoveryResult, key: "relayEndpoint" | "profileMultihash"): string {
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
  return error instanceof Error ? error.message : "GitLab discovery failed";
}
