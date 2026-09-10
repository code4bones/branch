import { CopyOutlined, DownloadOutlined, SaveOutlined, UploadOutlined } from "@ant-design/icons";
import { Button, Input, Modal, Segmented, Space, Switch, Tag, Typography } from "antd";
import { useRef, useState } from "react";

import { DetailHeader } from "../app/DetailHeader.js";
import { pwaReleaseVersion } from "../app/pwa-release.js";
import { useBranchID } from "../identity/use-branch-id.js";
import { updateLocalIdentityDisplayName } from "../identity/create-local-identity.js";
import { decryptPortableProfile, encryptPortableProfile, maxPortableProfileFileBytes } from "../profile/profile-bundle.js";
import { useContactDiscoveryPolicy, useIdentity, useReceiptPolicy, useThemeControls, useTransportStatus } from "../state/hooks.js";
import type { ThemeMode } from "../state/slices/ui-slice.js";
import { loadPortableProfileSnapshot, replacePortableProfileSnapshot } from "../storage/profile-migration-store.js";

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
  const [exportPassword, setExportPassword] = useState("");
  const [exportPasswordConfirmation, setExportPasswordConfirmation] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [exportingProfile, setExportingProfile] = useState(false);
  const [importingProfile, setImportingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const profileFileRef = useRef<HTMLInputElement>(null);

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

  const exportProfile = (): void => {
    if (exportPassword !== exportPasswordConfirmation) {
      setProfileError("The export passwords do not match.");
      return;
    }
    setExportingProfile(true);
    setProfileError(null);
    void (async () => {
      const snapshot = await loadPortableProfileSnapshot();
      const bundle = await encryptPortableProfile(snapshot, exportPassword);
      const objectUrl = URL.createObjectURL(new Blob([bundle], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `branch-profile-${new Date().toISOString().slice(0, 10)}.branch-profile`;
      link.click();
      window.setTimeout(() => { URL.revokeObjectURL(objectUrl); }, 0);
      setExportPassword("");
      setExportPasswordConfirmation("");
    })().catch((cause: unknown) => {
      setProfileError(cause instanceof Error ? cause.message : "failed to export profile");
    }).finally(() => { setExportingProfile(false); });
  };

  const requestProfileImport = (): void => {
    const file = profileFileRef.current?.files?.[0];
    if (file === undefined) {
      setProfileError("Choose an encrypted profile file first.");
      return;
    }
    if (file.size > maxPortableProfileFileBytes) {
      setProfileError("Profile file exceeds the encrypted-file limit.");
      return;
    }
    setProfileError(null);
    Modal.confirm({
      title: "Replace this local profile?",
      content: "This permanently replaces this device’s identity, contacts and message history. Contact folders, discovery settings and other device-local preferences stay on this device. Stop using the old device after a successful migration.",
      okText: "Replace profile",
      okButtonProps: { danger: true },
      cancelText: "Cancel",
      onOk: async () => {
        setImportingProfile(true);
        try {
          const bundle = await file.text();
          const snapshot = await decryptPortableProfile(bundle, importPassword);
          await replacePortableProfileSnapshot(snapshot);
          window.location.reload();
        } catch (cause: unknown) {
          setProfileError(cause instanceof Error ? cause.message : "failed to import profile");
        } finally {
          setImportingProfile(false);
        }
      }
    });
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
        <div className="pwa-settings-profile-migration">
          <dt>Profile migration</dt>
          <dd>
            <Space direction="vertical" size="small">
              <Typography.Text type="secondary">
                Export is an encrypted recovery/migration file, not multi-device sync. It includes this identity, contacts, local chat history, read state and pending message requests.
              </Typography.Text>
              <Input.Password
                aria-label="Export profile password"
                autoComplete="new-password"
                onChange={(event) => { setExportPassword(event.currentTarget.value); }}
                placeholder="Export password (12+ characters)"
                value={exportPassword}
              />
              <Input.Password
                aria-label="Confirm export profile password"
                autoComplete="new-password"
                onChange={(event) => { setExportPasswordConfirmation(event.currentTarget.value); }}
                placeholder="Confirm export password"
                value={exportPasswordConfirmation}
              />
              <Button icon={<DownloadOutlined />} loading={exportingProfile} onClick={exportProfile}>
                Export encrypted profile
              </Button>
              <Typography.Text type="secondary">
                Import replaces the portable profile data on this device. Contact folders, discovery data, read-receipt preference and current chat stay device-local and are not transferred.
              </Typography.Text>
              <input accept=".branch-profile,application/json" aria-label="Encrypted profile file" ref={profileFileRef} type="file" />
              <Input.Password
                aria-label="Import profile password"
                autoComplete="current-password"
                onChange={(event) => { setImportPassword(event.currentTarget.value); }}
                placeholder="Password used for export"
                value={importPassword}
              />
              <Button danger icon={<UploadOutlined />} loading={importingProfile} onClick={requestProfileImport}>
                Import and replace profile
              </Button>
              {profileError !== null && <Typography.Text type="danger">{profileError}</Typography.Text>}
            </Space>
          </dd>
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
                Send an encrypted Read receipt after a message is shown in this active chat. Turn this off to keep read state on this device.
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
