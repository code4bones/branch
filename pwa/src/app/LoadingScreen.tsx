import { Spin } from "antd";

export function LoadingScreen(): React.JSX.Element {
  return (
    <div className="pwa-loading-screen" aria-label="Loading">
      <Spin size="large" />
    </div>
  );
}
