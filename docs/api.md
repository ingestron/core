# Integrating core

Use `@ingestron/core` in a trusted Node 22.12 or newer host such as a CLI, service worker or
editor backend. Use `@ingestron/core/schemas` for structural validation of unsaved
editor buffers; it does not load the filesystem or runtime plugin host.

## First project

After installing a published core version in your application, copy
[quickstart.mjs](../examples/quickstart.mjs) into the application and run
`node quickstart.mjs`. Until registry publication, install a locally packed archive
using the [release procedure](release.md).

The example takes less than a minute. It creates a temporary project, demonstrates
that authoring returns a proposal, rejects application without write permission,
applies the proposal with permission and validates the project and an editor
buffer. It prints:

```text
Proposal, write protection, project validation and editor validation passed.
```

The temporary directory is removed even on failure. No provider, network access or
cloud execution is required. An empty project's draft validation can succeed;
strict planning/building additionally requires configured flows and providers.

## Runtime entry point

```js
import { executeAsync, operationSchemas } from "@ingestron/core";

const result = await executeAsync(
  { root: projectDirectory, environment: "dev" },
  "inspect",
  {},
);
if (!result.ok) console.error(result.diagnostics);
```

`root` is the caller-selected project directory. `environment` defaults to `dev`.
The host must choose these values after establishing its own user and workspace
access policy. The library does not provide authentication, tenancy or isolation
between hostile users.

| Context property | Default | Enables                                                             |
| ---------------- | ------- | ------------------------------------------------------------------- |
| `allowWrite`     | false   | Applying changes, installing packages and writing generated assets  |
| `allowNetwork`   | false   | Remote package/version discovery and runtime dependency preparation |
| `allowExecute`   | false   | Explicit provider execution, together with write permission         |

Proposal operations return changes for host review. `apply` checks the proposal's
revision and original file contents before writing. `initialise` may create the
requested empty root directory, but does not write project files until application.

`executeAsync` supports every operation. `execute` is synchronous and rejects
`runtime_prepare`, `run` and `run_status`; use the async entry point for these.
Operation names and request types are exported as `OperationName`, `Context` and
`Result`. `operationSchemas` contains the authoritative Zod request schemas:

```js
const names = Object.keys(operationSchemas);
const request = operationSchemas.validate.parse({ mode: "draft" });
```

Implemented families cover project inspection/validation/planning/building,
reviewed configuration authoring, ODCS contract import/validation, package
installation, installed plugin discovery/commands, and explicit local execution.
There is no reserved-operation API for future deployment or AI features.

Every operation returns `apiVersion: "ingestron.operation/v1"`, its `operation`,
`ok`, and `diagnostics`. A successful response has `result`. Each diagnostic has
`code` and `message`, with optional `file`, `pointer` and `hint`. Do not infer
success from an HTTP status or from the absence of a thrown exception.

| Diagnostic                 | Host response                                                           |
| -------------------------- | ----------------------------------------------------------------------- |
| `SCHEMA`, `INPUT`          | Correct the request; display the diagnostic near the input              |
| `PERMISSION`               | Obtain the appropriate host authorisation before retrying               |
| `STALE`                    | Re-read changed inputs and create a new proposal or plan                |
| `OWNER`, `CONFLICT`        | Preserve existing files and ask the user to resolve the conflict        |
| `PACKAGE`, `COMPATIBILITY` | Check the exact package reference, lock/cache and required capabilities |
| `OPERATION`                | Use a name present in `operationSchemas`                                |

Native generation invokes provider hooks but does not contact target systems.
Explicit `run` currently supports the `local-python/v1` transport on POSIX. This
is a trusted process boundary, not the deterministic JavaScript VM. See
[security](../SECURITY.md) before enabling it in an application.

## Bounded file reads

`read` with only `path` retains its full-text response. To read a larger file in
bounded pages, send `slice: { offset: 0, limit: 262144 }`. Offsets and limits count
UTF-16 code units; pages never split a Unicode surrogate pair. The limit is
2–262144 units and the existing source-file limit remains 10 MiB.

A page returns `content` and `slice` metadata: `offset`, `totalCharacters`,
`totalBytes`, `sha256` for the complete text, and `nextOffset` when another page
exists. Pass the previous `sha256` with each subsequent slice. Changed content
returns `STALE`; offsets beyond the file or inside a surrogate pair are rejected.
Join pages in order and verify the final text hash before using it as review or
approval evidence. Existing project-relative path, extension and hidden-file
restrictions apply. Paging grants no write, network or execution permission.

## Editor entry point

`validateDocument({ kind, uri, content })` validates YAML or JSON supplied in
memory. Supported kinds are `project`, `flow`, `step` and `environment`.
`uri` is copied into diagnostic `file` fields; it is not opened.

The result has `apiVersion: "ingestron.document-validation/v1"`, `valid` and
`diagnostics`. Diagnostics include a JSON `pointer`, a zero-based UTF-16
`range.start`/`range.end` (end exclusive), and one-based `line`/`column`.

This is structural validation. It does not resolve `$resolve` files, check an
installed provider, validate cross-flow dependencies or execute code. Use runtime
`validate` for project semantics. The exported `documentSchemas` also exposes the
four Zod schemas for completion or integration work.

## Version boundaries

Pin applications using `/adapter` to an exact core version. Prefer the operation
API over adapter helpers for new integrations. Schema/protocol `apiVersion` fields
and package semver are separate boundaries; do not rewrite either automatically.

## Private candidate connection authoring

The candidate provides three offline operations for portable connections:

- `connection_add` creates a connection using a configured connector package alias.
- `connection_setup` registers an exact installed connector reference and creates the connection in one proposal. Supply `package` as the alias and `reference` as the installed reference, alongside the usual connection fields.
- `connection_configure` reviews `id`, `sourceId`, `tenantId` and `settings` for an existing inline connection. It preserves package, connector, route, binding and neighbouring definitions.

All three validate effective settings against the installed connector schema in the selected environment before returning a proposal. Environment bindings override shared settings. Normal value placeholders are resolved for validation; the proposed document retains the supplied settings and references. Credential values are not looked up. Runtime `$secret` environment references remain references, and compiler `$env` lookups are refused even when reached through a value placeholder.

```js
const reviewed = await executeAsync(
  { root: projectDirectory, environment: "dev", allowWrite: false },
  "connection_configure",
  {
    id: "orders",
    sourceId: "erp",
    tenantId: "local",
    settings: {
      connection: {
        host: "db.example.invalid",
        database: "retail",
        user: "reader",
        password: { $secret: { env: "PG_PASSWORD" } },
      },
    },
  },
);
```

The example requires an existing PostgreSQL connection and its exact installed package. Review `result.changes` before applying the complete returned proposal. Retain `inputs`: newly referenced configuration files are hashed into the proposal, so changing them before approval produces `STALE`. A proposal does not write files, access the source or grant execution permission. Schema failures use a fixed diagnostic without setting values.

Native and bridge settings belong to their platform provider and are not validated against a portable connector schema by these operations. Referenced whole connections require editing their owning definition. Older published CLI/core builds may lack the new operations; callers must report that capability gap instead of substituting an unchecked edit.

Run `scripts/connection-authoring-acceptance.mjs` against an installed private CLI archive with `INGESTRON_ACCEPTANCE_CLI_PACKAGE`, a passed all-source configuration report in `INGESTRON_ACCEPTANCE_FIXTURE`, an isolated output directory in `INGESTRON_ACCEPTANCE_OUTPUT`, and a report path in `INGESTRON_ACCEPTANCE_PROOF`. The harness copies immutable package inputs into its own synthetic project and verifies SDK/CLI/read-only MCP parity, invalid-settings denial, reviewed configuration/setup and source-access/offline-preparation parity for all16 sources. It does not execute sources or qualify vendor access.

### Indexed connection metadata

A source runtime and its selected provider adapter must both explicitly declare `metadataDocuments: ingestron.metadata-documents/v1` to use indexed project tables. Core stores each complete resolved table (source, reviewed contract and compiled columns) in a content-addressed generated document. The project specification binds the complete index; source-boundary identity still excludes contract changes. Compilation receives only the source/column projection and the exact index. Core adds the original document bytes to the unapplied provider proposal and rejects provider collisions with those paths. Legacy runtimes retain inline tables. The existing 2 MB command limit is unchanged; each document is bounded to 2 MB, the collection to 100 documents / 7 MB. Native or installed runtime qualification is separate from this encoding capability.

Indexed project assembly explicitly declares the same capability. Core keeps complete metadata documents outside the assembly command, then attaches their exact original bytes only at safe, separate provider-declared flow roots. The assembled connection assets must remain byte-identical; missing roots, changed runners, colliding document paths and path escapes are refused before managed output is written. Existing command and VM limits remain unchanged.
