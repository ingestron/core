# Plugin host contract

Core validates and orchestrates plugin contracts. Plugin packages own platform
behaviour, generators, standards and connector runtime assets. No plugin is bundled
or treated as installed because it appears in an external catalogue.

## Package references and discovery

Install a provider through `packages_install` with an explicit
`owner/repository@1.2.3`, or use
`owner/repository/path/manifest.yaml@1.2.3` for another manifest location.
The default manifest is `plugin/provider.yaml`. An exact 40-character commit is
also accepted. A `v` prefix on a full semantic version is normalised. Legacy `v1`
tags remain accepted for existing locks; new integrations should use an exact
semantic version or commit. `latest` and product short aliases are not resolved.

Installation requires write permission and, for remote Git sources, network
permission. `fromGit` selects a local Git repository; without network permission
it must be inside the project. `frozen` requires an existing lock. `update`
explicitly resolves the selector again. `tagPrefix` supports independently tagged
packages in one repository and must be supplied for the initial version lookup
and install. A frozen existing lock does not need a new version lookup.

`plugin_versions` takes an explicit `provider` repository, optional `fromGit` and
`tagPrefix`. It lists Git tags; listing is not compatibility verification.

`plugin_browse` and `plugin_show` read installed, integrity-checked package
metadata. An empty lock gives an empty list. Select an exact reference when two
installed packages share an ID. The `catalogue` operation lists installed provider
standards and activities. Marketplace curation and aliases belong to applications
or a separately released registry, not core.

Packages are stored under `.ingestron/packages/`. `packages.lock.yaml` records the
repository, manifest, commit and file digests. Changed cached bytes fail validation.
Installation does not run package hooks. Derived licence/source information is
stored separately under `.ingestron/plugin-info/`.

## Provider manifests

The provider manifest uses `ingestron.provider/v1` and declares `id`, `version`,
`platform` and `activities`. Optional capabilities declare the hooks and contracts
implemented by that provider. Inspect the complete current schema with the `schema`
operation and `{ name: "provider" }`; activity and extension schemas are available
through the same operation. Schema validation rejects unknown fields.

| Hook        | Entry function                      | Purpose                                                                 |
| ----------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `planner`   | `expand`                            | Expand an ingestion standard into steps and recovery metadata           |
| `renderer`  | `validate`, `render`                | Validate a plan and return native file envelopes                        |
| `lifecycle` | `author`, `model`, `validateOutput` | Propose configuration, model resources and validate generated documents |
| `commands`  | `command`                           | Execute a declared, bounded JSON operation                              |

Each hook module runs in an isolated QuickJS process with JSON inputs and outputs.
Imports, filesystem/network access, clocks, random output and asynchronous results
are unavailable. The VM has a 64 MiB memory limit, a 512 KiB stack limit and a
2-second execution budget; its host process has a 30-second timeout. These are
compiler-hook limits, not row-processing guarantees. Connector data execution uses
its separately declared execution transport.

Rendering returns a map from safe relative paths to
`{ format: "json" | "yaml" | "text", value }`. Core validates paths and file syntax,
then writes through generated-file ownership checks. Use `provider_scaffold` to
obtain a reviewable proposal for a small synthetic provider and local tests;
`provider_check` checks repeated rendering for deterministic output.

## Commands and namespaces

`plugin_commands` discovers configured, locked providers without executing hooks.
A commands manifest may declare `namespace`; otherwise the provider ID is used.
Definitions use space-separated `name` paths, a description and an `inputSchema`.
Optional `examples` describe use; `resultSchema` validates returned JSON.

`plugin_command` accepts `{ namespace, target?, command, input }`. `target` names a
project provider configuration and is required when multiple configurations match.
The compatibility `provider_commands` and `provider_command` operations address a
configuration directly and use the same validation/execution path.

Core/app command namespaces are reserved. Different exact package references
cannot share a namespace. A command cannot also be a parent group. Unknown targets
fail. Discovery provides the locked reference and commit; it does not authenticate
to a cloud or install anything.

Command schemas allow `type`, `oneOf`, `properties`, `items`, `required`,
`additionalProperties`, `enum`, and numeric/string/array bounds. References, regex
patterns and executable validators are unsupported. Schemas are limited to
64 KB, 1,000 nodes and 20 levels; `oneOf` accepts 2–4 alternatives.

## Compatibility

`compatibility.minimumCli` is the existing plugin ABI field, retained for manifest
compatibility even when core is hosted without a CLI. The current compatibility
level is `4.2.0`; it is independent of core package semver. `requiredFeatures` must
contain only host-supported features. Do not interpret a successful compatibility
check as proof of native platform support or permission to execute a workload.
