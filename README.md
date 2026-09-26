# Ingestron core

The shared TypeScript library for Ingestron project configuration, contract
validation, planning, generation and plugin execution. Applications use the same
operation API to preserve project semantics and generated-file ownership.

Core contains the host and its contracts. Providers supply platform generators,
connector runtime assets and standards through explicit package references.

## Use the library

Requires Node 22.12 or newer for runtime operations. The npm package name is
`@ingestron/core`. To build the public source checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Consumers import the runtime and editor entry points separately:

```js
import { executeAsync } from "@ingestron/core";
import { validateDocument } from "@ingestron/core/schemas";

const result = validateDocument({
  kind: "environment",
  uri: "untitled:environment",
  content: "apiVersion: ingestron.environment/v1\nvalues: {}\n",
});
console.log(result.valid); // true
```

[Run the quickstart](docs/api.md#first-project) to create and validate a temporary
project through a reviewed change proposal. It needs no provider, cloud account or
source data. Building native assets requires an installed provider and configured
flows.

In a project, `packages` maps short names to exact installed releases. The
`packages.lock.yaml` file retains each full repository reference, commit and
file hashes. An ingestion connection holds endpoint and authentication settings;
each `flow.tables` entry selects one physical source object and its ODCS contract
selects the output columns. Connector packages define the allowed table source
shape, so the same project layout works across source types. Older stream-based
connector releases remain supported.

The `contract_scaffold` operation creates a minimal draft ODCS contract from a
user-supplied first field. `connection_flow_add` accepts an optional provider
execution mapping; when omitted it authors local execution. Providers and the
compiler still validate the selected execution mode during project checks.

## Integration guides

- [Operation and editor API](docs/api.md): requests, results, permissions, errors
  and supported document kinds.
- [Plugin host contract](docs/plugins.md): package references, discovery,
  deterministic hooks, command dispatch and compatibility.
- [Security boundaries](SECURITY.md): trusted-host responsibilities and limits.
- [Contributing and releasing](CONTRIBUTING.md): checks and package preparation.

Core has no terminal UI, MCP server, editor extension, marketplace catalogue,
cloud SDK, commercial pack or telemetry. The `/adapter` export contains helpers
for first-party applications pinned to the same exact core version. Public entry
points are ESM; importing internal `dist/` paths is unsupported.

## Licence

Licensed by Otrera Limited under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) and
[third-party notices](THIRD_PARTY_NOTICES.md) for attribution and upstream terms.
