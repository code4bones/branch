import { useEffect } from "react";

import { loadLocalIdentity } from "./create-local-identity.js";
import { useIdentity } from "../state/hooks.js";

// Runs once on app start: try to hydrate a previously created identity from
// IndexedDB. Resolves identityStatus from "unknown" to either "ready" or
// "missing" so RequireIdentity knows whether to show a loading state or send
// the user to onboarding.
export function useIdentityBootstrap(): void {
  const { clearIdentity, setIdentity } = useIdentity();

  useEffect(() => {
    let cancelled = false;
    void loadLocalIdentity()
      .then((loaded) => {
        if (cancelled) {
          return;
        }
        if (loaded !== null) {
          setIdentity(loaded);
        } else {
          clearIdentity();
        }
      })
      .catch(() => {
        if (!cancelled) {
          clearIdentity();
        }
      });
    return () => { cancelled = true; };
  }, [clearIdentity, setIdentity]);
}
