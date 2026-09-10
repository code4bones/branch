import { CopyOutlined, SaveOutlined } from "@ant-design/icons";
import { Button, Input, Segmented, Space, Switch, Tag, Typography } from "antd";
import { useState } from "react";

import { DetailHeader } from "../app/DetailHeader.js";
import { pwaReleaseVersion } from "../app/pwa-release.js";
import { useBranchID } from "../identity/use-branch-id.js";
import { updateLocalIdentityDisplayName } from "../identity/create-local-identity.js";
import { useContactDiscoveryPolicy, useIdentity, useReceiptPolicy, useThemeControls, useTransportStatus } from "../state/hooks.js";
import type { ThemeMode } from "../state/slices/ui-slice.js";

export function SettingsPage(): React.JSX.Element {
  const identity = useIdentity();
  const themeControls = useThemeControls();
  const receiptPolicy = useReceiptPolicy();
  const contactDiscoveryPolicy = useContactDiscoveryPolicy();
  const transport = useTransportStatus();
  const branchID = useBranchID(identity.identity?.peerId ?? null);
  const [branchIdCopied, setBranchIdCopied] = useState(false);
  const [displayName, setDisplayName] = useState(identity.identity?.displayName ?? "");
  const [savingDisplayName, setSavingDisplayName] = useState(false);
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);

  const handleCopyBranchId = (): void => {
    if (branchID === null) {
      return;
    }
    void navigator.clipboard.writeText(branchID).then(() => {
      setBranchIdCopied(true);
      setTimeout(() => { setBranchIdCopied(false); }, 2000);
    });
  };

  const saveDisplayName = (): void => {
    setSavingDisplayName(true);
    setDisplayNameError(null);
    updateLocalIdentityDisplayName(displayName)
      .then((updated) => { identity.setIdentity(updated); })
      .catch((cause: unknown) => { setDisplayNameError(cause instanceof Error ? cause.message : "failed to save display name"); })
      .finally(() => { setSavingDisplayName(false); });
  };

  return (
    <section className="pwa-settings" aria-label="Settings">
      <DetailHeader title="Settings" />
      <dl className="pwa-settings-list">
        <div>
          <dt>PWA release</dt>
          <dd><Tag>{pwaReleaseVersion}</Tag></dd>
        </div>
        <div>
          <dt>Relay</dt>
          <dd>
            <Tag color={attachTagColor(transport.attachStatus)}>{transport.attachStatus}</Tag>
            {transport.attachMessage}
          </dd>
        </div>
        <div className="pwa-settings-trace-row">
          <dt>Relay trace</dt>
          <dd>
            {transport.transportTrace.length === 0 ? "No live-session events yet" : (
              <ol className="pwa-transport-trace">
                {transport.transportTrace.map((entry) => (
                  <li key={`${String(entry.at)}-${entry.detail}`}>
                    <time>{formatTraceTime(entry.at)}</time> {entry.detail}
                  </li>
                ))}
              </ol>
            )}
          </dd>
        </div>
        <div>
          <dt>BranchID</dt>
          <dd className="pwa-branch-id-row">
            <span>{branchID ?? "not created"}</span>
            {branchID !== null && (
              <Button icon={<CopyOutlined />} onClick={handleCopyBranchId} size="small" type="text">
                {branchIdCopied ? "Copied" : "Copy"}
              </Button>
            )}
          </dd>
        </div>
        <div>
          <dt>Display name</dt>
          <dd>
            <Space.Compact>
              <Input onChange={(event) => { setDisplayName(event.currentTarget.value); }} value={displayName} />
              <Button icon={<SaveOutlined />} loading={savingDisplayName} onClick={saveDisplayName} />
            </Space.Compact>
            {displayNameError !== null && <Typography.Text type="danger">{displayNameError}</Typography.Text>}
          </dd>
        </div>
        <div>
          <dt>Peer ID</dt>
          <dd>{identity.identity?.peerId ?? "not created"}</dd>
        </div>
        <div>
          <dt>Relay key (Ed25519)</dt>
          <dd>{identity.identity?.relayPublicKey ?? "not created"}</dd>
        </div>
        <div>
          <dt>Payload key (HPKE)</dt>
          <dd>{identity.identity?.hpkePublicKey ?? "not created"}</dd>
        </div>
        <div>
          <dt>Theme</dt>
          <dd>
            <Segmented
              onChange={(value) => { themeControls.setMode(value as ThemeMode); }}
              options={["dark", "light"]}
              value={themeControls.mode}
            />
          </dd>
        </div>
        <div>
          <dt>Read receipts</dt>
          <dd>
            <Space direction="vertical" size={2}>
              <Switch
                aria-label="Send read receipts"
                checked={receiptPolicy.sendReadReceipts}
                checkedChildren="On"
                onChange={receiptPolicy.setSendReadReceipts}
                unCheckedChildren="Off"
              />
              <Typography.Text type="secondary">
                Send a best-effort encrypted Read receipt only after a message is shown in this active chat.
              </Typography.Text>
            </Space>
          </dd>
        </div>
        <div>
          <dt>Allow contact discovery</dt>
          <dd>
            <Space direction="vertical" size={2}>
              <Switch
                aria-label="Allow contact discovery"
                checked={contactDiscoveryPolicy.allowContactDiscovery}
                checkedChildren="On"
                onChange={contactDiscoveryPolicy.setAllowContactDiscovery}
                unCheckedChildren="Off"
              />
              <Typography.Text type="secondary">
                Let a live relay forward a one-time encrypted contact-card probe for this BranchID. The relay retains neither lookup nor card.
              </Typography.Text>
            </Space>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function formatTraceTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(at);
}

function attachTagColor(status: "idle" | "attaching" | "attached" | "error"): string {
  switch (status) {
    case "attached":
      return "green";
    case "attaching":
      return "gold";
    case "error":
      return "red";
    default:
      return "default";
  }
}
