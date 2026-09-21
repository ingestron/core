# Ingestron core

Reusable project compiler and operation library for Ingestron CLI, MCP adapters
and editor integrations. This is the new `ingestron-io/core` repository; it is
separate from the older `ingestron-core` API runtime.

```ts
import { executeAsync } from "@ingestron-io/core";
import { validateDocument } from "@ingestron-io/core/schemas";
```

The Node runtime owns project loading, planning, generation, package resolution
and explicit execution boundaries. Pass a project root and explicit write/network/
execution permissions. It is a trusted library, not a hostile-caller sandbox.
Native generator logic stays in installed providers. There is no CLI or MCP SDK.

`validateDocument({kind: "environment", uri: "untitled:1", content: text})`
validates unsaved YAML/JSON and returns structural diagnostics with JSON pointers,
zero-based UTF-16 ranges and one-based line/column. The `/schemas` export performs
no filesystem, network or plugin execution. Cross-file semantic validation belongs
to the runtime. `/adapter` helpers are for first-party version-pinned integrations.

Use Node 22 and pnpm 10.15.0. Run `pnpm install --frozen-lockfile`, `pnpm validate`,
and `pnpm pack`. Build assets and declarations are in `dist`; source is not copied
from a sibling checkout at build time. Tests use synthetic local fixtures only.

Otrera Limited is the intended Ingestron product owner. Public Apache-2.0 and npm release
are planned; current original code remains UNLICENSED until the legal licensor and
rights are confirmed. See [licensing status](licensing/README.md) and
[extraction provenance](docs/extraction-provenance.json). Private Git distribution
is an interim dependency route, not public npm availability.
