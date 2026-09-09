import { Outlet, useLocation } from "react-router-dom";

import { ChatListSidebar } from "./ChatListSidebar.js";
import { CHATS_PATH } from "./paths.js";
import { useIsMobile } from "./use-media-query.js";

// On desktop both panes render together, Telegram-style. On mobile only one
// screen shows at a time: the chat list, or whatever detail route matched
// (a chat or settings) — each detail page's DetailHeader carries the back
// button that returns here.
export function AppShell(): React.JSX.Element {
  const location = useLocation();
  const isMobile = useIsMobile();
  const isListRoute = location.pathname === CHATS_PATH;
  const showSidebar = !isMobile || isListRoute;
  const showDetail = !isMobile || !isListRoute;

  return (
    <div className="pwa-shell">
      {showSidebar && <ChatListSidebar />}
      {showDetail && (
        <div className="pwa-detail">
          <Outlet />
        </div>
      )}
    </div>
  );
}
