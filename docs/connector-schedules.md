# Connector schedule handover

Private core 0.12.24 adds an explicit connector scheduling protocol. A native
provider's `capabilities.schedules` describes its flow renderer; it does not
authorise scheduled connector preparation.

An adapter opts in under its exact `connectorRuntimes` entry:

```yaml
scheduling:
  apiVersion: ingestron.connector-schedule/v1
  clock: platform-native
  recurrences: [interval, daily, weekly, monthly]
```

It must also declare `connector-schedule-handover` in
`compatibility.requiredFeatures`. A host without this feature refuses it before
command execution. The adapter remains responsible for refusing unsupported
platform-specific slots, timing, resource limits and execution settings.

`connection_prepare` attaches a `schedule` envelope only when the selected flow
has a schedule. Its owner records project, environment, flow and connection. Its
definition retains every reviewed slot, enabled flag, time zone, exact bounds,
overlap, missed-run and daylight-saving policy. Its boundaries contain the same
host-resolved local timestamps, offsets, ambiguities and clock provenance used
by compiled plans. Its digest covers the complete envelope, and the containing
connection specification digest covers this schedule together with source
settings, contracts, runtime assets and immutable package references.

A `platform-native` adapter requires explicit `native` overlap and missed-run
policies. A `portable` adapter requires portable policies. Neither kind can
silently discard the other kind's semantics. Paused schedules still require a
compatible adapter; removing a schedule restores the original manual request
shape. Discovery remains independent of the flow's execution schedule.

The Node adapter export provides `connectorScheduleHandover` and
`validateConnectorScheduleHandover`. Validation takes the authoritative reviewed
definition and expected owner, rather than trusting an incoming envelope's own
hash. Altered scope, shifted bounds, missing fields, changed host clock data and a
fully rehashed replacement definition are refused. Native sandbox adapters
receive the host-resolved JSON and implement their platform rendering in their
own repository; they do not resolve time zones or call a platform during build.

This is a preparation contract. No production adapter opts into it yet. Existing
local, ADF and Databricks connector adapters continue to refuse scheduled flows.
It creates no dispatcher, background process, trigger, execution permission or
activation approval. Portable dispatch and native connector jobs must implement
and qualify this handover before claiming scheduled ingestion support. Public
dependency pins and the verified Luna preview remain unchanged.
