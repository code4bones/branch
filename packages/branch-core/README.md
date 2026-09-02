# @code4bones/branch-core

Shared browser TypeScript core for B.R.A.N.C.H. Admin and PWA surfaces.

This package owns UI-neutral protocol, discovery, connectivity, diagnostics,
and visual-carrier primitives. It must not import React, Ant Design, Zustand,
admin operator APIs, service workers, IndexedDB adapters, or application shell
state.

Admin code imports it from `web/`; client PWA code imports it from `pwa/`.
Neither app should import shared logic from the other app's source tree.
