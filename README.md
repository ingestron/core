# Ingestron core

The shared TypeScript library for Ingestron project configuration, contract
validation, planning, generation and plugin execution. Applications use the same
operation API to preserve project semantics and generated-file ownership.

Core contains the host and its contracts. Providers supply platform generators,
connector runtime assets and standards through explicit package references.

## Use the library

Requires Node 22 for runtime operations. The npm package name is `@ingestron/core`;
initial registry publication is pending. To build the public source checkout:

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
