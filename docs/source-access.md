# Source access operations — local candidate

Core 0.12.15 adds a shared source-access operation boundary. It is unpublished.
The installed local qualification uses a temporary archive override; published
CLI dependencies remain unchanged.

`connection_access` reads the installed connector declaration, fingerprint and
selected source-access executor. It runs no connector code. Native and bridge
routes require a platform adapter or an imported metadata export; they are not
silently treated as portable connections.

The async operations are `connection_runtime_prepare`, `connection_test`,
`connection_inventory` and `connection_metadata`. Each requires explicit write
and execution authority; dependency preparation also requires network authority.
A flow, contract, delivery target and provider configuration are not prerequisites.
The exact locked connector and execution provider must declare compatible
`ingestron.source-access/v1` and `ingestron.source-access-host/v1` ports. Python
preparation uses the selected provider's hash-locked environment.

Inventory returns 50 objects by default, at most 200 per page. Metadata reads at
most 100 explicitly selected objects. Results contain metadata, columns and keys;
these operations do not request business rows. Credentials resolve from named
secret environment bindings supplied by the authorised host. They are not copied
into results or contracts. Receipts are private project files and bind source
settings, environment and locked packages. Failed and interrupted tasks remain
failed or interrupted; edited definitions invalidate earlier evidence.

`connection_contracts` is an offline write operation. It checks a current metadata
receipt and writes separate ODCS drafts under `contracts/discovery/`, reports
unsupported fields and accepts inferred keys only when explicitly requested.
It does not replace reviewed contracts, change flows or publish anything.

Qualification includes the installed Files → header metadata → ODCS journey,
permission denial without execution authority and installed CLI/MCP parity.
The Studio acceptance records the existing authorised Northwind read-only path.
Provider-specific live discovery remains qualified separately.

## Review an ingestion flow

`connection_flow_review` returns one offline authoring proposal for up to 100
selected source objects. Supply the current metadata receipt, a new flow ID,
a local provider configuration and `{id,table,contract}` selections. Physical
source mappings come from the saved receipt. Each contract must be an isolated
draft for that source and environment, with the selected output table name.
The operation validates contracts and preserves their draft status and key choices.

Tables share the flow's connection and execution binding; each retains its own
physical source mapping, ODCS contract and output. Supply `executor` when more
than one source-access provider is installed, using the same exact reference as
the metadata receipt. A reviewed flow does not guess between installed adapters.

If no provider configuration exists, explicitly select an installed local runtime
and a new configuration name. Its existing authoring port proposes the package
alias and environment defaults together with the flow. No installation, source
read, generation or publication occurs in this operation. Existing configurations
are reused without replacement. Native and bridge routes remain outside this
portable handoff, even when a connector package is also present.

Apply the reviewed proposal separately. It records digests for the receipt and
contract inputs; changed drafts, metadata, project definitions or locks reject
application. Preparation validates and generates assets only after the saved
flow exists. Studio's source workspace uses this same operation.

## Bounded source samples — private candidate

`connection_sample` is an explicit execution operation for one connector-defined
source object, with 1–50 rows (default 20) and up to 100 selected scalar fields.
Only installed connectors declaring `sample` are eligible. Database adapters
quote identifiers and apply a server-side row bound; API adapters request bounded
pages and stop extraction after the preview. This is a data read, unlike metadata.

Sample rows are returned immediately and never stored in source-access receipts.
Receipts retain field names, row count and truncation status. Invalid response
shapes, row limits, action mismatches and changed source definitions fail closed.
The local provider validates the same response bound. Qualification uses synthetic
protocol tests and installed Files/CLI/MCP acceptance; it is not live vendor proof.
