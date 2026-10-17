# Reviewed local presentation generation

2026-10-11 · PB-060 · Local candidate; no cloud deployment.

`presentation_catalogue` reads configured offline reporting providers, installed
report/model packs, successful local snapshot receipts and saved presentation
definitions. It does not execute sources or report runtimes. Snapshots live under
`snapshots/<name>/receipt.json`, with their named Parquet files beside the receipt.
The inventory is bounded to 100 receipts and 16 MiB of receipt metadata.

`presentation_review` selects a compatible configured provider and exact report
pack, snapshot receipt, presentation/release identifiers, branding and factual
lineage. It supports the provider's declared `report build` or `report delivery`
command. The existing offline provider boundary owns generation and report/model
schema compatibility; this workflow does not duplicate native generators.

Review verifies each snapshot hash, up to 100 files and 64 MiB in total. It binds
snapshot and package bytes to the existing atomic `apply` proposal. Saved files
use `presentations/<environment>/<name>/releases/<release>/`; an existing release
is never overwritten. The latest authoring definition is stored beside releases.
A provenance file records selected packages, provider commit, snapshot hashes and
the review's verification limits. Synthetic receipts require synthetic lineage.

`apply` retains its normal explicit write permission, revision check, stale-file
checks and rollback behaviour. Changes to receipt, data, packages or project inputs
require a new review. Existing saved provider command exports also reuse the same
artifact-name/content validation and now bind their source envelope to the review.

Verification: `test/unit/presentation.test.ts`, `test/integration/report-packs.test.ts`
and `test/unit/package-library.test.ts` pass; the full 335-test core gate and
installed package/export/permission checks pass. Studio's installed acceptance
uses real Power BI 0.2.1 and Streamlit 0.3.1 packages with synthetic Parquet data.
Power BI desktop rendering, customer source evidence and cloud execution are
separate qualification gates. Larger snapshots need a separately designed bounded
verification path; no limits are silently bypassed.
