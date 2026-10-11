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

### Execution profiles

An ingestion flow may declare `executionProfiles` keyed by profile name. Each
binding specifies `provider`, a complete `ingestion` implementation, and `source`
defaults for that runtime. Tables and contracts remain shared. Source binding
defaults replace the flow defaults for the selected profile; table settings win.
Profiles cannot replace dataset schema/table identities. Select one flow with a
profile in build, validate, plan or resolve operations. Environment is independent.
The build records the selection; execution rejects a different profile. Use a
separate output directory per profile. Local evidence does not qualify a cloud target.

## Portable schedule clock preview

The read-only `schedule_occurrences` operation accepts `schedule`, exact UTC
`from` and `to` bounds, and an optional `limit` (default20, maximum1000).
The window must be positive and no longer than366 elapsed days. It calculates
interval, daily, weekly and monthly occurrences without reading the current clock,
accessing sources, registering a daemon or executing work. Paused definitions can
be inspected. Start/from are inclusive; end/to are exclusive. Interval occurrences
retain the exact seconds of the reviewed UTC start. Calendar slots remain paired;
missing month dates are skipped rather than rolled into the following month.

Optional calendar `daylightSaving` choices are `gap: skip | shift-forward` and
`fold: earlier | later | both`. Without a reviewed choice, an encountered ambiguous
or nonexistent wall time returns `SCHEDULE_DST_REVIEW`. Forward shifting retains
minutes within the actual offset jump, including half-hour and whole-date jumps.
Colliding slots are merged into one UTC occurrence, retaining every requested slot.
A definition with native missed-run/clock behaviour returns
`SCHEDULE_NATIVE_CLOCK`: portable previews do not promise native platform timing.
Elapsed UTC intervals and native-clock definitions reject portable DST overrides.

Results include exact UTC instants, actual local times/offsets, requested slots,
resolution, truncation, capped skipped-slot details, and the host time-zone database
version. Occurrence IDs bind the definition digest, database version and instant.
They do not authorise execution or replace reviewed project/plan identity.
Portable overlap, missed-run dispatch and durable recovery remain separate work.

Reviewed programme-to-project resource bindings are described in
[programme definitions](docs/programme-definitions.md). They preserve explicit
project/shared environment mappings and verify pinned inputs before a build.

Reviewed native source handoff is available through `connection_flow_review` and
`connection_flows_review`: an explicit `bridge` request composes a declared native
landing source, an isolated publication configuration and a snapshot-history
consumer. It preserves the metadata connection, requires reviewed required keys
and a frozen-source declaration, and rejects conflicting or shared environment
storage. The proposal uses the normal stale-input and apply guards. This authors
local definitions only; provider validation and generated assets do not prove
cloud deployment or data execution.
