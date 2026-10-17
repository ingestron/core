# Delivery planning contract — local candidate

The owner-directed PB-060 slice separates reviewed intent from technical
definitions and runtime evidence. `ingestron.delivery-plan/v1` records requirements
and work packages in `delivery-plan.yaml`, alongside `project.yaml`. It is a local
core candidate. CLI 0.17.9 and Studio consume it in the isolated local candidate
using core 0.12.15. Published pins remain unchanged; no release is included.

```yaml
apiVersion: ingestron.delivery-plan/v1
project: retail
revision: 1
requirements:
  - id: R_sales
    title: Daily sales
    description: Finance needs daily sales by store.
    disposition: accepted
    acceptance:
      - Approved totals reconcile to the reviewed source scope.
    owner: Finance
work:
  - id: W_raw
    title: Review source scope and raw contracts
    stage: contracts
    requirements: [R_sales]
    owner: Ingestion team
    targets:
      - kind: source
        id: retail_sql
  - id: W_verify
    title: Reconcile the finance output
    stage: verification
    requirements: [R_sales]
    dependsOn: [W_raw]
    owner: Finance data team
```

The schema limits plans to 500 requirements and 1000 work packages, rejects
unknown fields, duplicate IDs/references, missing references, self-dependencies
and dependency cycles. Acceptance criteria are explicit. Owners and ISO due dates
are optional; their presence does not establish approval or a schedule forecast.
Targets are symbolic source/runtime/flow/contract identities: this first slice
checks their shape, not their resolution or delivery semantics.

The editor-safe `/schemas` export supports `validateDocument` with kind
`delivery-plan`. `schema` with name `delivery-plan` supplies JSON Schema; semantic
cross-reference/cycle checks still require the shared validator. No compiler
execution, provider import or source read is needed.

The read-only `delivery_plan_check` operation accepts `path` (default
`delivery-plan.yaml`) and an optional `baseline` file inside the project. It checks
project identity, reports accepted requirements without work and work without an
owner, and returns a canonical plan digest. With a baseline it reports added,
removed and changed requirement/work IDs and transitively affected work. It flags
content changes and whether the authored revision advanced. Ordering changes can
change the digest; ID-based differences do not label reordered entries changed.
Files stay unchanged, and execution/network/write permissions are unnecessary.

The existing generic CLI `operation` transport can expose the operation when
consuming this core candidate. Qualification must use installed archives, not
sibling-source imports or a persistent local dependency override. Published CLI
0.17.8 retains its immutable core pin. Studio continues to show observed technical
work and an explicit missing requirements baseline until a qualified shared
operation is adopted.

A disposition of `accepted` is an authored assertion. Plan checks are not business
acceptance, source access, completed work, publication proof or verified scheduling.
There are no manually writable completion percentages. Follow-up work must bind
acceptance evidence to requirement/plan/definition revisions, resolve target
identities, fence baseline approval and support a reviewed Studio authoring
experience before presenting plan conformance or “on track” status.

## Local qualification — 2026-10-02

Core's Node 22 full gate passes 94 tests, formatting/build, example execution,
secret-pattern scan, release metadata and installed package checks. Five focused
planning tests cover cross-reference/cycle validation, baseline impact, fenced
read-only operation behaviour and editor diagnostics.

A separate synthetic temporary project installs archives of this core candidate
and the unchanged CLI 0.17.8. Only that temporary project's override points to the
unreleased core archive. The editor schema accepts its plan; the CLI generic
`operation delivery_plan_check` output matches core exactly and leaves plan bytes
unchanged. Adding a requirement criterion affects raw work and its dependent gold
verification package. [Sanitised installed receipt](evidence/delivery-plan-20261002.json).
This verifies command-boundary parity, not adoption by published CLI/Studio or
business acceptance. No package is published and no persistent CLI pin changes.

## Reviewed authoring and Studio adoption — 2026-10-02

`delivery_plan_propose` validates intent and produces a fenced authoring proposal.
`delivery_plan_baseline` produces a separate baseline proposal; changed scope
requires an advanced revision. The standard authoring apply boundary performs the
write. Proposal revisions include the default intent/baseline file digests, so
concurrent changes invalidate approval. `delivery_plan_check` now also returns
the validated plan for the shared Studio work table. These operations remain
planning evidence, not business acceptance or completion. The full candidate
gate passes 99 tests and installed-package checks.
