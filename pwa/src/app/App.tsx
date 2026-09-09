import { ConfigProvider, theme } from "antd";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./AppShell.js";
import { EmptyChatPane } from "./EmptyChatPane.js";
import { RequireIdentity } from "./RequireIdentity.js";
import { RequireRoute } from "./RequireRoute.js";
import { useRelayTransport } from "../connectivity/use-relay-transport.js";
import { useIdentityBootstrap } from "../identity/use-identity-bootstrap.js";
import { ChatPage } from "../pages/ChatPage.js";
import { DiscoveryPage } from "../pages/DiscoveryPage.js";
import { EchoChatPage } from "../pages/EchoChatPage.js";
import { OnboardingPage } from "../pages/OnboardingPage.js";
import { MessageRequestsPage } from "../pages/MessageRequestsPage.js";
import { SettingsPage } from "../pages/SettingsPage.js";
import { useThemeControls } from "../state/hooks.js";
import { AppStoreProvider } from "../state/StoreProvider.js";
import { useConversationsBootstrap } from "../storage/use-conversations-bootstrap.js";

export function PwaApp(): React.JSX.Element {
  return (
    <AppStoreProvider>
      <ThemedApp />
    </AppStoreProvider>
  );
}

// Reading theme mode via useThemeControls() (rather than a prop from PwaApp)
// keeps ConfigProvider in sync with Settings without threading state through
// the component tree.
function ThemedApp(): React.JSX.Element {
  const themeControls = useThemeControls();
  useIdentityBootstrap();
  useConversationsBootstrap();
  useRelayTransport();

  return (
    <ConfigProvider
      theme={{
        algorithm: themeControls.mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: "#57d2c6",
          colorBgBase: "#0a0d11",
          colorBgContainer: "#12171d",
          colorBorder: "#2d3845",
          borderRadius: 8,
          fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
        },
        components: {
          Layout: {
            bodyBg: "#0a0d11",
            headerBg: "#0a0d11",
            siderBg: "#0f141a"
          },
          Menu: {
            darkItemBg: "#0f141a",
            darkSubMenuItemBg: "#0f141a",
            darkItemSelectedBg: "#164b48",
            darkItemSelectedColor: "#f4f7fb"
          }
        }
      }}
    >
      <BrowserRouter basename="/pwa">
        <Routes>
          <Route path="onboarding" element={<OnboardingPage />} />
          <Route
            element={(
              <RequireIdentity>
                <DiscoveryPage />
              </RequireIdentity>
            )}
            path="discovery"
          />
          <Route
            element={(
              <RequireIdentity>
                <RequireRoute>
                  <AppShell />
                </RequireRoute>
              </RequireIdentity>
            )}
          >
            <Route index element={<Navigate replace to="chats" />} />
            <Route path="chats" element={<EmptyChatPane />} />
            <Route path="chats/:contactId" element={<ChatPage />} />
            <Route path="echo" element={<EchoChatPage />} />
            <Route path="requests" element={<MessageRequestsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate replace to="chats" />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  );
}
