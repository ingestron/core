# Integrating core

Use `@ingestron/core` in a trusted Node 22 host such as a CLI, service worker or
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
