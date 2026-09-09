import { ArrowLeftOutlined } from "@ant-design/icons";
import { Button, Typography } from "antd";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { CHATS_PATH } from "./paths.js";
import { useIsMobile } from "./use-media-query.js";

export interface DetailHeaderProps {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly avatar?: ReactNode;
  readonly extra?: ReactNode;
}

// Shared by every detail-pane page so the mobile-only back button and the
// title/avatar layout stay consistent without each page re-implementing it.
export function DetailHeader({ title, subtitle, avatar, extra }: DetailHeaderProps): React.JSX.Element {
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  return (
    <header className="pwa-detail-header">
      {isMobile && (
        <Button
          aria-label="Back to chats"
          className="pwa-detail-back"
          icon={<ArrowLeftOutlined />}
          onClick={() => { void navigate(CHATS_PATH); }}
          type="text"
        />
      )}
      {avatar}
      <div className="pwa-detail-header-text">
        <Typography.Text className="pwa-detail-header-title">{title}</Typography.Text>
        {subtitle !== undefined && (
          <Typography.Text className="pwa-detail-header-subtitle" type="secondary">{subtitle}</Typography.Text>
        )}
      </div>
      {extra !== undefined && <div className="pwa-detail-header-extra">{extra}</div>}
    </header>
  );
}
