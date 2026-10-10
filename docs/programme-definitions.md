# Programme definition inspection and stable identities

Local candidate 0.12.56 retains the `ingestron.programme/v1` JSON representation.
`programme_definition_inspect {id}` returns shared platform configuration, programme
project identities, work-item count, raw source digest and canonical definition
digests. It does not open project folders, resolve credentials or infer bindings.

A programme project can declare `compilerId`, its explicit logical connection to
an `ingestron.project/v1` definition. The programme project's existing `id` remains
the reference used by requirements and work items. Compiler IDs must be distinct.
Hosts must verify the chosen project definition separately within their authorised
root before presenting this mapping; the operation accepts no filesystem paths.

`programme_registration_propose {id, project, compilerId, expectedDigest}` returns
a read-only review with `document` and `expectedDigest`. Apply those two fields with
`programme_save {id, document, expectedDigest}` and explicit write permission.
Stale reviews fail. A registered compiler identity cannot be removed or reassigned
through an ordinary save; a future deliberate relocation/migration contract is
required for that operation. Legacy projects without compilerId continue to work.

No environment/provider binding, YAML representation, migration or generation is
implemented by these identity operations. Source digests detect changes in storage;
canonical digests identify the resolved logical document independently of JSON
whitespace. Existing schema validation, bounded files, symlink denial and programme
write locking still apply.

## Reviewed platform bindings

Local candidate 0.12.58 adds three operations. Each uses the selected compiler
project root and environment from the operation context. `programme: {id, root}`
is an explicit, absolute authorised shared root supplied by the CLI user or host;
project YAML cannot grant access to another folder.

- `platform_binding_inspect {programme, project}` returns registered identity,
  shared environments, target profiles, installed compatible provider choices and
  binding status. `project` is the existing programme plan ID.
- `platform_binding_propose {programme, project, sharedEnvironment, target,
reference, configuration, resources}` reviews an explicit mapping. `reference`
  must identify an installed provider with the binding capability. Missing shared
  resource fields may be supplied; existing shared values cannot be replaced.
- `platform_binding_apply {programme, proposal}` takes the entire returned review
  and requires write permission. It re-derives the review under the programme
  write lock, then uses the normal atomic project authoring transaction. Changes
  to source intent, project files, package lock or cached package content invalidate
  the review. External editors do not participate in the programme lock; a build
  rechecks the source again.

Only the selected project environment receives a resource binding. No default
provider is selected and no other environment is populated. Configuration aliases
are dedicated to that project/environment. Existing configuration aliases,
resource bindings and unowned binding files cannot be replaced. Shared YAML aliases
or fragments coupling environments must be separated before materialisation.

The reviewed writes add an exact installed package reference, provider options,
the selected environment's resource references and a `platformBindings` entry.
The latter resolves a `platform-bindings/<configuration>.yaml` record and a bounded
programme snapshot at `platform-bindings/snapshots/<definition-digest>.json`.
Records pin the installed commit and package file inventory digest. Snapshots stay
inside the project include fence and are immutable. Refresh retains earlier
snapshots; it never writes shared programme definitions.

The shared build path requires `build {programme: {id, root}, ...}` for an
environment with bindings. It verifies current programme intent, materialised
inputs and installed package integrity, and refuses a project quality gate that
weakens shared `qualityFailure: block`. Explicit capability/policy constraints and
exception policies without an enforcement adapter block binding. Provider-specific
translation belongs in the installed provider's `platform_binding` authoring
operation, with resource and configuration schema validation. Naming and flow
standards remain pending intent in the review; resource materialisation does not
claim to apply those preferences or prove a deliverable.

This increment retains JSON programme storage. It does not migrate programme or
platform definitions to YAML, deploy resources, resolve credentials or execute
cloud work. The Databricks candidate supports explicit CLI authentication and
non-production bindings without secret references; other authentication methods,
production settings and secret adapters fail closed until implemented.

A copied environment cannot build with a provider configuration reviewed for a
different project environment. Each selected configuration needs a binding for
that environment; matching or copied resource references do not transfer consent.

## Reviewed local generation

`build_review` accepts the same authorised programme source and selected environment
as `build`, with optional flow, provider and profile selection. It renders through
the shared project compiler without writing output. Its versioned review lists
included flows, data contracts, pinned packages, file changes and digests. Empty
projects fail with `BUILD`; they do not produce a successful empty deliverable.

`build_apply` requires write permission, the entire returned proposal and the
host-supplied programme source again. Programme root authority is never taken from
the review. Apply re-renders and rejects changed definitions, compiler, packages,
environment, root or output. It checks output again under the generation guard,
then uses the existing managed-output ownership and rollback path. Edited,
unowned, retained and team-maintained output remains protected. The review reads
at most 12,000 output entries and 32 MiB and rejects symlinks and special files.

Direct `build` remains supported and uses the same renderer. The new operations
prove offline generation only; neither operation authorises deployment, source
access or execution. User interfaces should retain the complete proposal in their
trusted host and expose only an expiring, project/environment-scoped review token.

## Optional split YAML storage (local candidate 0.12.60)

Legacy `programme.json` remains readable and writable without migration. The
optional `programme.yaml` manifest uses `ingestron.programme/v2`, with explicit
`requirements: {$resolve: ./planning/requirements.yaml}` and platform entries
`{id: PLAT-1, definition: ./platforms/PLAT-1/platform.yaml}`. Project registrations
remain inline logical IDs and compiler IDs; they do not grant access to project
folders. The registered programme root does not move.

The requirements file wraps the complete existing list in
`{apiVersion: ingestron.requirements/v1, requirements: [...]}`. Each platform uses
`ingestron.platform/v1` with its existing `id`, `name` and optional `configuration`.
The configuration retains the shared environment catalogue and target settings.
Each target's `environments` becomes an array of `{$resolve: ./environments/<provider>/<name>.yaml}`.
Each referenced profile uses `ingestron.platform-environment/v1`, its `provider`,
and the existing profile fields. Shared catalogues do not create missing target
profiles or project environments. Only secret references enter these documents.

`programme_read`, `programme_save`, definition inspection, platform configuration,
bindings and generation still consume the canonical v1 document. YAML saves use a
digest over all referenced paths and raw file hashes, so editing any fragment
invalidates a stale save. No-op saves preserve raw bytes; edited saves reconcile
YAML document nodes to retain comments and ordering on surviving fields. Deleting
an item deletes its associated comments. Existing reference paths are retained;
new profile paths derive from stable platform/provider/environment identities.

All references must be explicit local `./` YAML paths beneath the registered root.
Traversal, remote references, symbolic links (including dangling links), duplicate
file identities, duplicate mapping keys, aliases, anchors and explicit tags are
rejected. The aggregate definition limit is 512 KiB, with bounded references and
structure. Unsupported legacy fields fail validation; they are never silently
removed during migration. Competing JSON/YAML authorities or `programme.yml` fail
with `AMBIGUOUS`.

### Review, apply and exact rollback

Run these through `ingestron --project <programme-root> --json --no-input operation
<operation>`, passing the input JSON on stdin. Only apply requires `--allow-write`.

- `programme_storage_inspect {id}` lists active files, their digests, the storage
  format and eligible rollback receipts.
- `programme_migration_review {id, direction: "to-yaml"}` returns an
  `ingestron.programme-migration-review/v1` proposal. It lists preserved IDs and
  work-item count, file changes, input hashes, minimum core version and backup path.
- `programme_migration_apply {id, proposal}` re-derives and compares the complete
  review under the programme write lock, stages all writes, checks current bytes,
  applies the changes and verifies the resolved document is unchanged.
- `programme_migration_review {id, direction: "restore-json", migration: <source-hash>}`
  reviews restoration of the exact original JSON bytes. Apply this proposal through
  the same operation. Rollback refuses to discard any later YAML edit, including
  comments or whitespace. Use Git to deliberately reconcile later edits.

The original is retained at `.programme-migrations/<source-hash>/programme.json`
alongside a receipt. Commit both with the migrated definitions. A caught I/O failure
restores changed files, and readers reject another process's active write lock.
This is not a crash-recovery journal: process termination or persistent filesystem
failure requires operator recovery from the backup/Git and inspection of the lock.
Do not claim cross-process filesystem atomicity against arbitrary external editors.

A storage-only migration preserves the canonical digest used by platform bindings.
A logical shared-definition edit still makes those bindings stale. Studio must hold
raw proposals in its trusted host, bind one-use tokens to the programme/editor,
and refuse to migrate an unsaved draft. Existing CLI installations need core
0.12.60 or later to read this YAML; do not migrate shared repositories before their
other editors and automation are upgraded. Public dependency pins are unchanged.

## Reviewed target profile parameter sets

`programme_platform_catalogue` exposes `profileDefaults` version 1 for each target.
The core catalogue owns workload suggestions, shared/project naming layouts and
review-policy defaults. Clients may preview these values and submit the resulting
ordinary target definition through `programme_save`; YAML uses the existing
`generation`, `capabilities`, `policies` and `naming` fields, without a second format.

Suggestions are shared planning intent. They do not discover tenant capabilities,
install packages or activate enforcement. Source connectivity, change semantics,
compute and access choices are deliberately not inferred. Preserve non-empty
settings and environment bindings when filling defaults; explicitly disallowed
capabilities must not be overwritten by a suggested workload. Shared definition
changes retain the existing project-binding freshness checks.
