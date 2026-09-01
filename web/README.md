# B.R.A.N.C.H. Web Scaffold

This directory contains the TypeScript side of the T-BRANCH-013 foundation
scaffold.

The current code is not a production PWA. It exists to prove that TypeScript
strict mode, linting, shared protocol-vector checks, and local static serving
are wired before the relay or browser application implementation expands.

Build the static shell with:

~~~sh
npm run build
~~~

The open `/admin/` surface is now scaffolded from React and TypeScript under
`web/src/admin`. The current Ribbon Image and GitHub tool behaviour remains in
`web/public/admin/admin.js` as a temporary legacy adapter until the follow-up
module migration moves that logic into typed source modules.
