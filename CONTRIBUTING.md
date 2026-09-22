# Contributing to core

Core owns shared project semantics, schemas, diagnostics, package integrity and
plugin hosting. Keep terminal/MCP/editor UI, product catalogues, provider
implementations and commercial material in their owning repositories.

Use Node 22.12 or newer and pnpm 10.15.0. Install with `pnpm install --frozen-lockfile` and run
`pnpm validate`. The gate formats, builds, tests, scans for recognised secret
patterns, verifies release metadata/notices and exercises the installed archive.
Tests use synthetic local packages and require Git; they need no cloud credentials.

Useful individual commands are `pnpm build`, `pnpm test`, `pnpm format` and
`pnpm package:check`. Dependency changes require `pnpm licences:inventory` and review
of the updated notices. Build output and archives stay ignored. There is no install
lifecycle build; `prepack` builds before an archive is created.

Add regression coverage for changed behaviour and preserve editor import isolation,
operation permissions, immutable package resolution and generated-file ownership.
The [quickstart](examples/quickstart.mjs) is executed against the packed dependency
by the package check. Follow the [release procedure](docs/release.md) to publish.
