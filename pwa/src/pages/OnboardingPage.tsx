import { BranchesOutlined } from "@ant-design/icons";
import { Alert, Button, Input, Space, Typography } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { createLocalIdentity } from "../identity/create-local-identity.js";
import { DISCOVERY_PATH } from "../app/paths.js";
import { useIdentity } from "../state/hooks.js";

export function OnboardingPage(): React.JSX.Element {
  const navigate = useNavigate();
  const identity = useIdentity();
  const [creating, setCreating] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleCreateIdentity = (): void => {
    setCreating(true);
    setError(null);
    createLocalIdentity(displayName)
      .then((created) => {
        identity.setIdentity(created);
        void navigate(DISCOVERY_PATH, { replace: true });
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "identity creation failed");
      })
      .finally(() => { setCreating(false); });
  };

  return (
    <section className="pwa-onboarding" aria-label="Local identity onboarding">
      <BranchesOutlined aria-hidden="true" className="pwa-onboarding-mark" />
      <Typography.Title level={2}>Create your local identity</Typography.Title>
      <Typography.Paragraph>
        Your B.R.A.N.C.H. identity is two device-held key pairs: an Ed25519 key that
        authenticates this device to a relay, and an HPKE key that lets contacts seal
        messages for you. Both are generated on this device and kept in your browser —
        no account, email, or B.R.A.N.C.H.-owned server is required. Contacts, discovery,
        and message sealing are not wired up yet in this beta scaffold.
      </Typography.Paragraph>
      {error !== null && <Alert message={error} showIcon type="error" />}
      <Space direction="vertical">
        <Input onChange={(event) => { setDisplayName(event.currentTarget.value); }} placeholder="Display name (optional)" value={displayName} />
        <Button loading={creating} onClick={handleCreateIdentity} type="primary">Create local identity</Button>
      </Space>
    </section>
  );
}
