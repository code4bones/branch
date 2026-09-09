import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { LoadingScreen } from "./LoadingScreen.js";
import { useConversationsLoaded, useIdentity } from "../state/hooks.js";

// Route guard expressed purely through hooks: no ancestor needs to pass
// identity or hydration state down as props.
export function RequireIdentity({ children }: { readonly children: ReactNode }): ReactNode {
  const identity = useIdentity();
  const conversationsLoaded = useConversationsLoaded();
  if (identity.status === "unknown" || !conversationsLoaded) {
    return <LoadingScreen />;
  }
  if (identity.status === "missing") {
    return <Navigate replace to="/onboarding" />;
  }
  return children;
}
