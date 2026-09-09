import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { DISCOVERY_PATH } from "./paths.js";
import { useConnection } from "../state/hooks.js";

// Discovery always runs before the messenger interface appears: any route
// this wraps redirects to /discovery until a relay route has been found.
export function RequireRoute({ children }: { readonly children: ReactNode }): ReactNode {
  const connection = useConnection();
  if (connection.routeStatus !== "found") {
    return <Navigate replace to={DISCOVERY_PATH} />;
  }
  return children;
}
