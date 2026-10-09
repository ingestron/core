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
