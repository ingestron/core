## D7 definition lifecycle — 2026-10-16

`archived: true` makes a saved definition unavailable for editing. It is an
optional availability flag, separate from draft/reviewed validation status. Review
and apply change only that flag for archive/restore; they never remove the file,
source binding, exact discovery pins, object settings or customer output. Restore
works without contacting a source. Working-copy writes to archived definitions
are refused. Connector removal still counts archived version pins as dependencies.

A duplicate uses `create: true` and `duplicateFrom: <saved-id>` in the existing
review operation. Core requires a new identity, draft status and an exact copy of
all settings/evidence except the name and availability flag. This permits copying
an existing old-version pin after a connector upgrade without silently adopting
new discovery. Subsequent editing and adoption retain the normal validation gates.

Archive reads bounded, fenced YAML under `ingestion-drafts/` and
`ingestion-handoffs/` across environments. Non-null working copies and handoffs
referencing the definition block archive. Each handoff follows
`ingestron.ingestion-handoff/v1` and belongs to the same project; malformed or
symlinked dependencies fail closed. Downstream modules must register their
references under `ingestion-handoffs/<environment>/<identity>.yaml` and remove
or revise them through their own reviewed workflow. No target configuration or
execution is introduced here. Dependencies are re-read on apply; existing reviewed
inputs are included in the write fence. Source connections and discovery remain
retained; this slice provides no source-file deletion action.

## D3 portable editor — 2026-10-16

`ingestion_editor_read` reads definitions, source choices, saved discovery and a
working copy. `ingestion_discovery_adopt` selects exact saved objects and creates
collision-free logical mappings; it performs no source access. Definition review
and apply validate immutable discovered fields and include the saved evidence hash
as an atomic write input. Create intent cannot replace existing identities.

`ingestion_draft_write` requires write permission and an expected working-copy hash.
It stores the portable definition plus base revision and object/section context in
`ingestion-drafts/<environment>/<id>.yaml`. Review can include `workingExpected` to
clear that exact working copy with the definition save. A null file is a discarded
working copy. Unknown environments, concurrent edits, forged bindings and changed
evidence fail closed. Existing required masks cannot weaken; optional masks retain
their values when disabled. Quality attributes remain opaque until D4 validation.

# Portable ingestion definitions — D0 and D2

The 2026-10-16 D0 implementation introduces draft-only portable authoring. The
compiler owns these schemas and operations. Studio and CLI use the same installed
operation boundary. There is no legacy migration framework: existing project,
contract and target-bearing flow files are left in place.

## Ownership and formats

| Version                             | Contents                                                                                                                                                                                       | Current support                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ingestron.ingestion-definition/v1` | Identity, name/purpose, optional source with exact connector version, optional discovery digest, objects and fields, mappings, quality attributes, governance/masking intent, metadata columns | Read, review, save and reopen a **draft** in `ingestions/<id>.yaml`                                                   |
| `ingestron.discovery-snapshot/v1`   | Source identity, exact connector version, collection time, scoped completeness, object kinds and declared/observed/inferred/unknown fields                                                     | D2 saved/live/import metadata; see [discovery interchange](portable-discovery.md). Adoption into definitions is D3/D5 |
| `ingestron.ingestion-draft/v1`      | Project, base revision, definition and object/section context                                                                                                                                  | Validatable working-draft interchange. No persistence service or resumable object editor is claimed in D0             |
| `ingestron.ingestion-handoff/v1`    | Project, definition digest, contract digests and required capabilities                                                                                                                         | Consumer reference shape. No target binding, generator adapter or execution is implemented here                       |

Definitions contain logical source intent. Target connections, processing modes,
physical target types, deployment details, run controls, results and operational
history belong to downstream platform/build/delivery owners. A handoff is a content
reference, not execution permission or proof of platform support.

Object kinds cover tables, views, file groups, endpoints, collections and topics.
Unknown logical types remain `unknown`; no SQL type or string fallback is invented.
Field provenance is explicit. Source-native type text is evidence, not a target
type. Missing optional metadata remains absent. D2 adds [reusable discovery](portable-discovery.md), locations, coverage, provenance
and consented transient sample previews. Samples remain separate from this envelope.

Mapping uses an explicit list of source-path to output-name pairs. A missing or
empty mapping is unconfigured, not an implicit compiler mapping. Metadata output
names must be unique against mapped outputs. Source-path enrichment requires a
file group. Masking references must resolve to declared object fields; policies
are authoring intent, not an assertion that a target implements them. Quality
records preserve custom attributes but have **no semantic quality validation** in
this slice. The checker reports `qualitySemantics: not-checked` and
`platformSupport: not-checked`; reviewed/ready status is rejected.

## Operation boundary

1. `ingestion_definition_read {}` returns definitions, file hashes and an inventory
   revision. An optional ID filters the result.
2. `ingestion_definition_review {revision, definition}` validates the draft and
   produces the exact YAML proposal. It does not write files.
3. `ingestion_definition_apply {input, proposalId}` repeats validation and verifies
   the proposal identity before using the existing fenced, revision-checked writer.
   Only this operation requires write permission. No operation requires execution.
4. `ingestion_contract_check {value}` checks a supplied envelope without saving it.

Review IDs are not durable approval credentials. Studio holds its short-lived
review token in the host, tied to session/editor, project root and environment;
client input cannot supply a filesystem path or raw write proposal. Apply consumes
that token once. Re-read/review after a stale response. The definition is project
scoped even though host access remains bound to an editor environment.

Pure schemas are exported through `@ingestron/core/schemas` from
`ingestion-definition-schema.ts`. Filesystem operations stay in
`ingestion-definition.ts`. The installed editor export test forbids Node imports.

## Bounds and evidence

A document is limited to 8 MiB, 10,000 objects, 5,000 fields/mappings per object,
100 quality records and 100 metadata columns per object. Inventory reads allow
1,000 definition files and 16 MiB aggregate input. Oversize/duplicate identities,
invalid references, path traversal, unknown envelope fields and unsupported
versions fail rather than truncate. These are parser limits, not performance or
large-estate qualification. D4 owns bulk and quality-scale acceptance.

`test/unit/ingestion-definition.test.ts` covers target-free save, write denial,
stale/forged proposals, unchanged project files, references, collisions and unknown
field types. Installed core packaging checks browser-safe schema imports. Studio's
installed CLI test adds single-use editor tokens and save/reopen parity. No customer,
remote source or native-cloud execution evidence is claimed.
