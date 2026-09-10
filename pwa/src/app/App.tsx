import { ConfigProvider, theme } from "antd";
import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./AppShell.js";
import { inboundAttachmentCompletionHandler } from "./transient-attachment-presentation.js";
import { EmptyChatPane } from "./EmptyChatPane.js";
import { RequireIdentity } from "./RequireIdentity.js";
import { RequireRoute } from "./RequireRoute.js";
import { setInboundAttachmentPresentationHandler } from "../connectivity/attachment-runtime.js";
import { useRelayTransport } from "../connectivity/use-relay-transport.js";
import { useIdentityBootstrap } from "../identity/use-identity-bootstrap.js";
import { ChatPage } from "../pages/ChatPage.js";
import { DiscoveryPage } from "../pages/DiscoveryPage.js";
import { OnboardingPage } from "../pages/OnboardingPage.js";
import { MessageRequestsPage } from "../pages/MessageRequestsPage.js";
import { SettingsPage } from "../pages/SettingsPage.js";
import { useThemeControls } from "../state/hooks.js";
import { AppStoreProvider, useAppStoreApi } from "../state/StoreProvider.js";
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
  const storeApi = useAppStoreApi();
  useIdentityBootstrap();
  useConversationsBootstrap();
  useRelayTransport();
  useEffect(() => {
    const handler = inboundAttachmentCompletionHandler(storeApi);
    const unregister = setInboundAttachmentPresentationHandler(handler);
    return () => {
      unregister();
      handler.clear();
    };
  }, [storeApi]);

  return (
    <ConfigProvider
      theme={{
        algorithm: themeControls.mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: "#1a272b",
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
            darkItemSelectedBg: "#1a272b",
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
            <Route path="requests" element={<MessageRequestsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate replace to="chats" />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  );
}
