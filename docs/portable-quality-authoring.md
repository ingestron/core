# Portable ingestion quality authoring

D4 · 2026-10-16. Authoring only; no source access, target configuration or execution.

`ingestion_quality_preview` accepts a portable `definition`, optional `object` ID
and optional `bulk` request. It returns definition issues, explicit warnings for
unsupported records, and effective object rules when requested. Bulk requests
freeze an explicit object-ID array, `preserve` or `replace`, and one setting. The
response includes the proposed definition and an outcome for every selected ID.
It performs no writes. Use `ingestion_definition_review` and the existing apply
operation to save; the writer revalidates both policy protection and input revision.

Portable rules use `ingestron.quality-rule/v1`. The supported condition union is
not-null, uniqueness, range, allowed-values, pattern, length, freshness, row-count
and relationship. Field references name logical mapped outputs or additional
metadata columns, evaluated before masking by a future qualified runtime. Pattern
validation accepts a deliberately bounded ASCII subset without groups, alternation,
backreferences or stacked quantifiers; it compiles syntax but never evaluates data.
Allowed values retain scalar types. A relationship targets ordered keys on another
selected object in the same ingestion. Cross-source execution is not claimed.

Rules carry null handling, a minimum pass-rate percentage or maximum failing count,
severity and failure intent. Row-count conditions are object aggregates and permit
only report-only or reject-object intent. Definition validity says nothing about
quality results or a target's ability to enforce an intent. Disabled optional
rules are retained and must still have valid definitions/references.

Defaults are inherited by ID; local overrides replace optional defaults. Mandatory
rules carry a policy reference and reason. They must remain enabled and unchanged
for retained objects. The reviewed writer compares effective rules against the
saved definition, preventing alternate clients from weakening constraints. Policy
authoring/distribution is separate; this operation protects constraints declared
in portable definitions. Removing an object is an explicit ingestion scope change.

Rule-set versions are embedded in `qualityRuleSets`, with per-object `qualitySets`
bindings. Field slots require exact logical-type matches. Saved versions cannot be
mutated or deleted; a new version does not move consumers. Unknown custom quality
records and unknown portable-rule extension attributes are preserved, with explicit
unsupported-semantic warnings. Existing ODCS/provider quality compilation remains
separate; the JSON-only ODCS editor is not a second portable editor.

Limits include 10,000 objects, 5,000 fields per object, 100 local rules, 100 fields
per composite rule, 100 field slots per reusable set, 200 set versions per definition
and 20 bindings per object. The authoring request and saved document remain bounded
at 8 MiB. Secrets auditing applies before preview returns content. CLI/MCP and Studio
consume this same operation; no client implements condition validation independently.
