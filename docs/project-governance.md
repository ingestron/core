# Project governance

`governance_check` inspects current project definitions without reading sources or
running providers. It lists contract owners, stewards, declared required quality
rules, delivery work ownership, missing definition targets and baseline changes.
Future appointments and expired team memberships do not count as current owners.
Published transformation outputs appear alongside ingestion contracts.

A project can save an `ingestron.policy/v1` policy inline in `project.yaml`, or
through `policy: { $resolve: ./governance/policy.yaml }`. Its `id`, `version` and
`owner` identify the locally authored policy. `rules` supports:

- `contractOwner`: `active-only` (default) or `required` for every contract.
- `contractSteward`: `optional` (default) or `required`.
- `minimumRequiredQualityRules`: 0–100, including primary-key checks.
- `allowedContractStatuses`: an optional nonempty list of permitted statuses.
- `workOwnersRequired`, `acceptedRequirementsAssigned`,
  `definitionTargetsRequired`, `reviewedBaselineRequired`: false by default.

Strict inspection, planning and preparation check saved policy before provider
planning. Draft inspection stays available to correct gaps. Flow selection scopes
contract checks to that flow; delivery definitions describe the whole project.
Delivery rules use `delivery-plan.yaml` and `delivery-plan.baseline.yaml`. A current
baseline has the same revision and planning content. Source, runtime, flow and
contract targets must resolve to current project definitions.

`policy_propose` returns a reviewable change; `apply` requires local-write access.
It updates an existing inline or referenced policy in its current location. A new
policy creates `governance/policy.yaml` and its project reference atomically. An
unrelated existing destination is preserved. Changed project inputs invalidate the
proposal. Report digests include the evaluation date and all inspected input hashes.

`policyReady: null` means no policy is configured. A true value means the selected
project definitions satisfy that saved policy. Authored owners and saved planning
baselines are not authenticated approvals, runtime quality results or deployment
proof. Actual runtime quality coverage and results remain separate. Projects
without policy retain existing active-contract ownership and runtime checks.
