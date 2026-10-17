# Controlled connector upgrades

`connector_change_review` selects an exact newer release for one registration in
one project. It verifies the connector source and manifest version and validates
all connections using that registration in every configured environment. It does
not qualify target support, install runtime dependencies, access source data or
execute ingestion.

Review returns settings compatibility, configured consumers, portable definitions,
saved discovery and working copies across environments. Portable input hashes and
the entire inventory membership contribute to the proposal fingerprint. Apply
repeats the package and project review; edits, additions, deletions or changed tags
invalidate it. Limits are 4,000 portable YAML files, four nested directories and
64 MiB in the dependency inventory. Malformed or unsafe inputs fail closed.

`files` contains exact proposed project and package-lock writes.
`comparisonFiles` contains the current and candidate connector manifest bytes for
read-only comparison. The package content digest pins the complete package, while
the manifest diff exposes settings, source capabilities and runtime declarations.
No version change is inferred to be metadata-compatible.

Installation may succeed while registration fails (for example another authoring
operation holds the write guard). The operation then reports
`outcome: installed-not-applied` and `changed: false`. Refresh and request a new
review; the already installed candidate can complete the registration update.
Never automatically remove the candidate, roll back to an older release or retry
an old proposal. If a process ends without a response, inspect the library and
registration before starting a new review. Saved portable files are never written
by this operation.

The previous connector is retained. Removal is blocked while any saved definition,
working copy or discovery snapshot still pins its exact source/version. Existing
portable definitions remain editable against their original snapshot evidence.
After importing or collecting discovery with the registered connector version,
`ingestion_discovery_update` can propose explicit adoption from the same source.
The proposed definition is a draft; all settings survive, and absent/incomplete
objects retain their previous snapshot pin. Review and save are separate steps.
