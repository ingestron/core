# Ingestron core

Shared project compiler, operation API and configuration schemas for Ingestron CLI,
MCP adapters and editor integrations. Native generators stay in separately installed
providers; this library contains no terminal UI or MCP transport.

```sh
npm install @ingestron/core
```

```ts
import { executeAsync } from "@ingestron/core";
import { validateDocument } from "@ingestron/core/schemas";
```

Use Node 22 for runtime operations. Pass the project root and explicit write,
network and execution permissions. Core is a trusted library, not a hostile-caller
sandbox. Installed command namespaces and their target selection share the same
operation API used by CLI and MCP.

`validateDocument({kind: "environment", uri: "untitled:1", content: text})`
validates unsaved YAML/JSON with structural diagnostics, JSON pointers and UTF-16
ranges. The `/schemas` export performs no filesystem, network or plugin execution.
Cross-file semantic validation belongs to the runtime. `/adapter` helpers are for
version-pinned first-party integrations.

## Development

Use Node 22 and pnpm 10.15.0. Run `pnpm install --frozen-lockfile`, then
`pnpm validate`. The archive contains built runtime/editor exports and retained
third-party assets/notices. Tests use synthetic local fixtures and need no sibling
repository. Passing them does not establish native cloud-provider acceptance.
Official provider packages remain separately qualified private previews.

## Licence

Apache-2.0 for original code, licensed by Otrera Limited. Upstream material retains
its own terms; see LICENSE, NOTICE and THIRD_PARTY_NOTICES.md.
