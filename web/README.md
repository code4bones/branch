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

The local nginx deployment expects the built files to be installed into
`/var/www/branch`.
