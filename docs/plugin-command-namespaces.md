# Installed command namespaces

`plugin_commands` discovers configured, locked providers without executing guest code.
`plugin_command` accepts `{ namespace, target?, command, input }` and resolves to the
same handler as the compatibility `provider_command` operation. The existing
`provider_commands` operation still inspects one configuration.

A v1 commands manifest may declare `namespace`; otherwise its provider ID is used.
Definitions retain space-separated `name` paths and their required `inputSchema`.
Optional `examples` enrich help; optional `resultSchema` validates the guest result.
Both schemas use the existing bounded JSON Schema subset. Discovery reports the
locked reference/commit, environment, configuration, implemented availability and
`offline-json` effects. These are host-enforced semantics, not plugin permission claims.

Core command names are reserved. Two different exact package references cannot
share a namespace. A command cannot also be a parent group. Multiple configurations
of one exact package are allowed, but execution requires an explicit target unless
only one binding matches. Unknown targets fail. Project YAML and lock identities
are unchanged; no installation or cloud authentication occurs during discovery.

Adapters must use these shared operations, preserving input validation, immutable
package checks and the bounded offline VM. This API does not implement deployment
or arbitrary provider-specific process execution. Old manifests and the generic
configuration-based route remain supported.
