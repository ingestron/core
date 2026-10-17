# Recover a run whose source outlives its parent

Private core0.12.33, tested with unchanged CLI0.17.14 and local0.4.10/files1.5.8,
keeps a managed build protected when its source outcome is uncertain. A provider
can die while its separately grouped source process continues writing. The absence
of that provider process does not prove that the source stopped.

A missing, malformed or contradictory provider acknowledgement leaves the run
`indeterminate`. Its read-only receipt reports `outcome: "uncertain"` and
`recoveryRequired: true`. Interruption also retains uncertainty. A failed recovery
attempt keeps the original claim; it cannot permit rebuilding. A confirmed first
failure without inherited uncertainty remains repairable. Read-only source
inspection has no ingestion commit to recover and retains its repeatable source
access error instead.

Inspect the original run ID with `ingestron run status <id>`. Use `--json` to read
its outcome fields. Recover a direct run with `ingestron run --retry <id>`. For
scheduled work, recover its original occurrence with `ingestron schedule retry`;
the command's help describes the flow, occurrence and reviewed digest selections.
Retain the original run identity, build and review. Rebuilding identifies the run
that still owns the managed build.

The qualified source owns its output writer lock and stable-run commit semantics.
If it remains active, replacement execution fails and the build stays protected.
After the source commits, successful same-run recovery acknowledges the existing
commit. Its receipt reports `succeeded`, `outcome: "succeeded"` and
`recoveryRequired: false`; rebuilding is then permitted. Recovery waits for the
original caller to finish finalising or exit and for its provider group to exit.
An old owner cannot release a replacement claim. Ingestron does not expire claims
or choose a new business identity automatically.

Installed acceptance holds an actual200000-order file source and kills only its
provider parent while the caller remains alive. Both the initial failure and a
failed retry retain uncertainty and refuse rebuilding without changing managed
files or review. The source then commits. Retrying the same run after its CSV
becomes malformed returns that unchanged commit and permits rebuilding. The
separate caller-and-provider death route and normal CLI/shared Studio host source
regressions also pass against the immutable candidate archive.

This qualification covers those synthetic local/files routes. Fuller CLI/Studio
recovery presentation, reviewed abandonment and checkpoint migration remain
required. It does not establish a global target reservation service, recovery for
every remote connector, native deployment or safe manual claim removal. See
[execution resources](execution-resources.md) for the provider declaration and
current coordination boundaries.
