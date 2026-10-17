# Portable discovery adoption and definition review

D5, 2026-10-16. These operations author portable files; they do not configure a
target, execute ingestion, evaluate sample rows or upgrade a connector.

`ingestion_discovery_update` accepts the current inventory revision, an in-memory
definition, a saved snapshot ID and its exact wrapper SHA-256. It returns a proposed
definition, per-object impact, portable findings, additional available object IDs,
coverage and the exact before/after saved snapshot text. The operation never writes.

Objects are reconciled by stable ID, never guessed from similar names. Complete
object metadata replaces its field evidence while preserving all authored settings.
New fields are unmapped. Missing/incomplete objects and changed object kinds retain
their previous evidence via an optional object-level `discovery` reference. A user
may also retain a changed object's previous evidence. That reference must match the
existing object's pin; arbitrary historical snapshots cannot be substituted.

A changed top-level pin requires `adoptDiscovery` on the ordinary definition review.
It must equal the proposed pin, match the unchanged exact connector and be current
for the source. Required masks, mandatory quality rules and immutable reusable rule
sets retain their existing protections. Partial scope never implies deletion.

`ingestion_definition_review` returns the atomic proposal and portable findings.
`saveWithFindings: true` permits a structurally valid `draft` with reference/quality
findings; it does not bypass identity, duplicate, secret, policy or evidence checks.
Reusable rule-set versions must be valid before saving because saved versions are
immutable. Keep an unfinished reusable version in the working copy instead.
A `reviewed` definition must pass portable static checks and contain source objects.
Custom rules and target capabilities remain unqualified. `ingestion_contract_check`
continues to report invalid references as errors.

Apply re-runs review and compares the proposal ID. Project revisions, exact snapshot
hashes, current files and working-copy hashes participate in the review. Comparison
text is never a client-supplied write payload. Optional samples are not included in
saved discovery or comparison files. Snapshot persistence and definition adoption
remain separate operations.

Tests in `test/unit/ingestion-editor.test.ts` cover 480 objects, retained settings,
partial scope, incomplete metadata, exact file bytes, draft findings, reviewed
readiness, working-copy and concurrent-edit conflicts, and altered snapshot rejection.
