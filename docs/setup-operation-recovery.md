# Recover an original setup operation

The private core 0.12.36 candidate provides `execution_recover` for original
`prepare`, `catalogue`, `discover`, `review` and `approve` operations. It requires
an installed provider declaring `provider-journal/v1` acknowledgement and the
`provider-execution-acknowledgement` host feature. Providers without that capability
return `NOT_IMPLEMENTED`; their uncertain build ownership remains protected.

Read the original receipt with `run_status` first. Recovery takes only its `id`.
It checks the original environment, profile, provider, locked commit, managed build
fingerprint and flow selection. It cannot select another flow, build or action.
Write and execution authority are required. Dependency-network authority is not
required: this operation asks the provider to acknowledge completed original work.
It does not prepare dependencies or repeat source access.

```javascript
const recovered = await executeAsync(
  {
    root: projectDirectory,
    environment: "dev",
    allowWrite: true,
    allowExecute: true,
    allowNetwork: false,
  },
  "execution_recover",
  { id: originalOperationId },
);
```

If no matching durable acknowledgement exists, recovery retains uncertainty and
build ownership. Absence of a caller or child process is insufficient. Once the
provider acknowledges the original result, its receipt retains the same ID and
action, records `acknowledgedOriginalOperation: true`, and clears
`recoveryRequired`. An acknowledged failed operation remains failed. The operation
API reports a successful acknowledgement through `ok: true`; inspect the original
receipt's `status` to distinguish its result.

Data ingestion runs retain their separate, same-ID `run` retry path. This new
operation cannot turn a setup operation into a data run. The shared Studio and
editor host provide scoped status and acknowledgement controls; browser-button
interaction, legacy receipt migration and reviewed abandonment remain unfinished.

Read-only `execution_features` accepts an empty request and returns
`apiVersion: ingestron.execution-features/v1` with `runtimePrepareRunId: true`.
This advertises host API support, not provider acknowledgement. A client can then
persist a bounded `runtime_prepare.runId` before dispatch. Older hosts or malformed
feature responses must not receive unsupported identity arguments. Provider
acknowledgement still comes from the exact installed manifest and locked commit.
