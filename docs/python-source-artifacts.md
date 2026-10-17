# Reviewed Python source artefacts

Private core 0.12.47 supplies literal Python source and published output columns to
an installed provider. It parses configuration and verifies planned file hashes;
it does not import the source module or run its functions. The provider owns native
generation and syntax checks.

`flow_create` and `flow_add` accept `language: "sql" | "python"` for transformation
authoring. The installed provider must declare Python in
`capabilities.transformationLanguages` and require `python-source-artifacts`.
Ingestion language options and unsupported provider languages are refused before
authoring. Omitting the language preserves the provider's existing default.

Providers can declare `authoring.transformationSettingsSchema` with bounded JSON
Schema and require `transformation-authoring-settings`. `flow_create` and
`flow_add` accept provider-owned `transformationSettings`; core validates them
before requesting a proposal. These options are refused for ingestion or an
undeclared provider. Studio renders supported declared fields without assuming a
platform's destination format.

`flow_create` can select an existing output `contract`. Its resolved contents go
to the installed provider's authoring boundary, and the proposal records every
read contract file hash. Apply refuses a changed input. Databricks authors a
separate output-contract copy; the selected original remains untouched. Flow
creation refuses any existing file that the provider would author in that flow.

For a `pythonFile`, the renderer receives the exact planned text as `node.python`
and typed columns from the consistent contract published by that step's
`outputs.result`. Conflicting output contracts are refused. A file changed after
planning fails with `STALE`; generated-file ownership checks still govern writes.

Providers can declare `quality.transformations.python` with library, SQL and engine
enforcement modes. This requires `published-transformation-quality`. Strict
validation and project-build metadata include the corresponding published rules.
An explicit error rule without supported enforcement blocks the build unless the
project selects `defaults.quality.unsupported: report`.

The Databricks candidate implements this boundary with reviewed batch
materialised views and committed-version checks after refresh. Native execution,
arbitrary Python dependency compatibility and other providers require their own
qualification.

Providers can opt into typed SQL outputs using
`capabilities.typedTransformationLanguages: ["sql"]` and the required feature
`typed-transformation-outputs`. Core then requires the step's consistent published
output contract and supplies its reviewed columns, as it does for Python. Legacy
SQL providers retain their existing contract boundary.

Strict planning and generation read source through the configuration boundary,
verify its recorded hash and set `sourceFilesChecked: true` in the provider request.
Metadata-only validation leaves this flag false. Providers own dialect parsing,
template expansion and declared-input validation; core never executes customer
SQL. Generation still runs the provider validation gate before rendering.

`quality.transformations.sql` declares enforcement for published typed SQL outputs.
Strict validation and project-build reports select the transformation declaration
instead of borrowing ingestion coverage. Native SQL expression typing and vendor
execution remain provider qualification work.
