# B.R.A.N.C.H. Foundation Status

Status: local repository scaffold for T-BRANCH-013.

This file tracks what the current bootstrap repository enforces before
production relay or PWA implementation begins. It does not replace Marrow tasks
or decisions.

## Implemented Gates

- Go module scaffold with draft `protocol/v0`.
- Shared `testdata/vectors/protocol-v0` fixtures read by Go and TypeScript.
- Structural valid and invalid draft envelope conformance checks.
- Hostile-input baseline: unknown fields, missing required fields, expired
  timestamps, negative timestamps, unsafe JavaScript integer timestamps,
  trailing JSON, and oversized inputs.
- Go unit tests, race tests, vet, gofmt/goimports check, staticcheck,
  govulncheck, and bounded fuzzing in CI.
- TypeScript strict mode, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, ESLint, and Node test runner conformance checks.
- GitHub Actions and GitLab CI definitions.
- Initial T-BRANCH-014 observability scaffold: typed Go event and reason-code
  registry, no-op sink, bounded metric label registry, protected admin response
  contracts, TypeScript bounded diagnostic journal, manual redacted export, and
  optional local compose observability profile.

## Explicit Scaffold Limits

- `branch/connectivity/0` is the accepted draft identifier used by test
  fixtures, not a published immutable wire version.
- Canonical serialization, signature input bytes, encryption payload format,
  algorithm choices, and relay frame format remain open.
- Integration and Playwright critical-path gates are documented but not active
  yet because production relay/PWA runtime is intentionally blocked until
  T-BRANCH-013 is accepted.
- Observability implementation is blocked behind T-BRANCH-013 and tracked by
  T-BRANCH-014. The current implementation remains a foundation scaffold, not a
  relay/PWA runtime integration.

## Next Foundation Work

- Add canonical and non-canonical encoding vectors after the encoding decision.
- Add signature input and signature vectors after cryptographic constructions
  are selected.
- Add integration and Playwright gates with the first real runtime surfaces,
  without adding durable relay storage or mandatory project infrastructure.
