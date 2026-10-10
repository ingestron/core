# Reviewed local delivery

`delivery_inspect` returns declared provider actions, flow schedules and bounded,
environment-scoped run summaries. It does not execute a source, start a worker or
deploy resources. Invalid or oversized receipts produce diagnostic codes. Raw
provider output and source rows are excluded from the summaries.

`delivery_execution_review` accepts one saved flow and a generated build directory.
It reuses the existing execution boundary to bind the environment, provider commit,
build digest, operation identity and resources. Only local Python providers are
eligible. Runtime preparation discloses dependency downloads and secret lookup
names. A review alone grants no execution permission.

`delivery_execution_apply` requires write and execution permission, plus network
permission for runtime preparation. It rebuilds the review and rejects drift before
calling the existing runtime operation. Retry and recovery retain the original
receipt identity; uncertain operations are never automatically dispatched anew.

Studio retains review payloads in the trusted host and exposes expiring, scoped,
one-use tokens. Schedule edits use `schedule_propose` and `apply`; occurrence
previews use `schedule_occurrences`. Saving a schedule does not activate a worker.

Verification: the 2026-10-11 core gate passes 341 tests. Installed Studio acceptance
uses provider-local 0.4.18 and an isolated synthetic source for generation,
preparation, discovery, mapping review, approval, execution and recovery. Native
cloud execution and background schedule dispatch are outside this checkpoint.
