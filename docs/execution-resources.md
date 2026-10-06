# Inspect the destinations a run reserves

The private core0.12.31/local0.4.11 candidate lets an installed provider declare
the physical resources selected by a compiled flow. Core validates the declaration
and returns opaque keys. Target paths, credentials and source rows are omitted.
This candidate was tested with private CLI0.17.14; public dependency pins remain
unchanged.

From the prepared synthetic acceptance project, inspect its compiled provider:

```sh
printf '%s' '{"from":"build/resources","provider":"local"}' |
  ingestron --project . --json --no-input operation execution_resources
```

The result has `coverage: provider-declared`, the selected flow IDs and their
resource keys. To inspect one flow, replace `provider` with `flow`. Selecting both
is refused. The operation needs no write, execute or network permission. It does
not prepare dependencies, read sources, create run receipts or register a schedule.
The read-only MCP tool `ingestron_execution_resources` returns the same result.

Local0.4.11 declares the exact compiled `data/<flow>` directory. Selecting that
flow from the complete package retains its identity. Compiling a separate package
directory declares a different output namespace. Existing source-owned output,
checkpoint, commit and retry semantics continue to apply.

## What protection is verified

The portable scheduler uses the provider's selected resource keys in its existing
project journal. The managed-build execution guard refuses different flows when
their declared keys overlap. An independent declared resource can execute while
another flow owns its build claim. Claims retain exact run/token ownership; a
changed resource set cannot take over an existing claim.

These claims currently coordinate one project journal or one managed build.
They do not establish a shared reservation service across build directories,
projects, machines or remote destinations. The declaration contract is the input
to that further work. Providers without this capability report `legacy-flow` and
retain the earlier project/environment/flow key; that key is not a physical
destination declaration.

Installed acceptance verifies the local resource identities, scheduler parity,
SDK/terminal/read-only MCP inspection and an actual three-row local/files commit
and same-ID retry. Shared-target refusal and independent-resource access have
separate core ownership fixture evidence. Other providers, residual source-parent
death, cross-project reservations and native execution remain unqualified.

## Provider contract

An execution provider opts in through `execution.resources`:

```yaml
resources:
  apiVersion: ingestron.execution-resources/v1
  command: execution resources
```

Declare `provider-execution-resources` in `compatibility.requiredFeatures` and
declare that command in the provider's offline command catalogue. Core passes
the validated compiled `packageRoot` and exact selected `flows`. The command must
return `ingestron.execution-resources/v1` with one entry per selected flow:

```json
{
  "apiVersion": "ingestron.execution-resources/v1",
  "flows": [
    {
      "flow": "bronze",
      "resources": [
        {
          "namespace": "local-filesystem",
          "identity": "/synthetic/build/data/bronze"
        }
      ]
    }
  ]
}
```

The provider owns canonical identity semantics. Name the same physical resource
consistently across flow selections and provider versions; do not include a run
ID, build digest or package version to make a shared destination appear unique.
Core hashes the namespace and identity, without interpreting a connector protocol.
Namespaces are bounded lowercase identifiers. Identities cannot contain control
characters. Foreign or missing flow entries, duplicate flow/resource entries and
unknown properties are refused with bounded diagnostics that omit identity values.

The declaration allows at most100 selected flows,128 resources per flow and500
distinct resources in total. Each identity is at most4096 characters. Private
managed-build ownership records are bounded to64KiB and excluded from Studio asset
inspection. This contract does not authorise a provider to access a destination.
