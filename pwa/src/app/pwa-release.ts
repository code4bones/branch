declare const __BRANCH_PWA_VERSION__: string;

// Replaced from package.json by scripts/build-static.mjs for every static PWA build.
// The static build replaces this symbol. The fallback keeps pure module tests
// independent of the bundler and is never emitted by the production build.
export const pwaReleaseVersion = typeof __BRANCH_PWA_VERSION__ === "string" ? __BRANCH_PWA_VERSION__ : "0.0.0-beta.0";
