# Durable local scheduling

Private core 0.12.29 and CLI 0.17.13 provide finite dispatch and a persistent local
worker for reviewed registrations. The installed local0.4.10/files1.5.8 route has
separate source-ingestion and process-crash evidence. These private versions are
not the published package baseline. The private shared Studio interface includes
finite dispatch, persistent-worker controls and paged registration history.

The engine uses the reviewed portable schedule and an unchanged managed build.
Registration binds the project, environment, flow, optional execution profile,
build and source inputs, package locks, prepared schedule and host clock data.
Execution uses the same preflight and local execution boundary as a direct run.
Changed inputs are refused before starting work. The caller must supply both
write and execution permission for registration, tick, pause, cancellation and
retry. Read-only status and inspection create no journal.

The local journal records each due occurrence, cursor, decision, attempt and
business run identity. Short SQLite transactions allocate exclusive resource
claims. Source execution runs outside the transaction, allowing another tick to
record overlaps. Queue preserves pending work; skip records an overlap decision.
Missed-run skip uses the explicitly reviewed registration grace period, between
zero and 3600 seconds. Latest retains the latest newly observed due occurrence and
records earlier missed occurrences as skipped. Already queued overlaps remain
queued. The first registration starts at the host's current clock, rather than
implicitly backfilling earlier history. Repeated registration of an active,
unchanged build preserves its cursor.

Each tick runs at most 20 jobs. Occurrences use the shared clock evaluator, including
reviewed daylight-saving handling and inclusive start/exclusive end bounds.
Already queued work represents an occurrence inside those bounds; an end date
stops new occurrences and does not erase that queue. A clock reversal, dispatch
gap over 366 days, more than 1000 new due occurrences or journal retention bound stops
without advancing the cursor. Explicit backfill and archive workflows remain to
be implemented; none is simulated by dropping history.

A successful occurrence releases its claim. Failed, interrupted and uncertain
work retains ownership. Retry uses the same business run identity and the core
run receipt; it repeats current preflight. A running worker cannot be displaced
while its process remains alive. A recovered worker has a new claim token, so a
late former worker cannot complete or release its occurrence. These host fences
are qualified with the tested file source's commit and output locks: a killed
caller cannot reopen a still-locked execution, and recovery after lost
acknowledgement returns the original source commit. Other sources require their
own qualification. Claim expiry alone never authorises replay.

Pause stops new starts and leaves the current run's ownership intact. Cancel
applies only to queued work. Both actions and status remain usable when project
inputs or the current build are broken. Replacing a registration requires pending
work to be resolved or explicitly canceled, and retains its previous generation
in the journal. Recovery after changed source or contract definitions still needs
a reviewed migration; unsafe abandonment is unavailable.

The versioned operations are:

- `scheduler_inspect`: inspect a selected flow and managed build, returning its
  review digest and current state.
- `scheduler_register`: supply that digest, build selection and grace period to
  register or resume reviewed work.
- `scheduler_tick`: collect due work and execute a bounded number of occurrences.
- `scheduler_status`: inspect durable state and previous generation summaries.
- `scheduler_history`: read a current or archived registration's occurrence
  history without current-build preflight. Filter by status or search, and select
  a zero-based page with 10 to 100 entries.
- `scheduler_pause`: stop new starts against the expected registration digest.
- `scheduler_cancel`: cancel one queued occurrence against that digest.
- `scheduler_retry`: explicitly recover an existing occurrence against that digest.
- `scheduler_worker_start`: start a detached driver for one to 100 registered
  flows, with one reviewed digest per flow, a polling interval of one to 60
  seconds, and a per-flow tick limit of one to 20.
- `scheduler_worker_status`: inspect this environment's workers, flow names,
  lifecycle state, bounded counts and safe health codes.
- `scheduler_worker_stop`: request authenticated interruption or drain by its
  worker ID. This operation does not require the current build to remain valid.

Starting a driver does not register flows implicitly. Each selected flow must
already have a current reviewed registration. A driver holds exclusive claims
for its selected flows and uses the existing finite scheduler tick for dispatch.
It rechecks the saved digest before each flow and the execution boundary before
starting each source run. A changed registration requires reviewing and starting
a new driver. Pausing a flow leaves its driver inspectable; resuming the same
registration lets it dispatch again.

A source failure keeps its occurrence claim and requires an explicit same-ID
retry. The driver records attention for that flow and continues checking its
other flows. It never retries failed or uncertain business work automatically.
Stop with `interrupt: false` to finish the current source run, or `interrupt: true`
to interrupt it through the existing adapter cancellation boundary. Interrupted
work keeps its occurrence claim. The stop request is durable and the loopback
control authenticates the exact worker identity; it never sends a signal to a
PID taken from a saved record. If a process is killed, inspect its recovery state,
stop the lost driver explicitly, then recover the original occurrence before
starting further dispatch. Time alone never releases either claim.

Driver records retain at most 100 worker identities. Reaching that bound requires
an explicit history archive workflow, which remains to be implemented. Worker
control uses the stable [Node TCP API](https://nodejs.org/docs/latest-v22.x/api/net.html)
on the loopback interface; private control credentials are excluded from public
operation results. All journal transactions remain synchronous and short. No
transaction is held while a source runs. Read-only observers wait at most two
seconds for a concurrent commit; writers report contention for bounded retry.
After a source returns, occurrence finalisation retries only its same claimed
transaction for at most forty attempts separated by 50 milliseconds. It does not
rerun the source. If finalisation remains uncertain, the occurrence keeps its
claim for explicit recovery.

Use `executeAsync` for these operations. The public schemas accept neither a
client-supplied clock nor an executor. The generic CLI operation boundary requires
`--allow-write --allow-execute` for mutations. MCP omits them unless both
permissions were enabled when starting the server. Read-only MCP retains
inspection and status.

History selects `current` or an exact archived generation ID returned by the
operation. It contains public run identity, time, status, attempt and safe failure
codes, rather than source bindings or claim tokens. Filtering and ordering happen
before page selection. The archive ID must belong to the selected flow and
environment. Metadata covers at most 100 archived generations; states are parsed
one at a time to bound simultaneous memory use. Historical source work stays
read-only. Larger page coverage is verified with synthetic core fixtures; actual
installed Studio/CLI/read-only MCP acceptance retains a recovered file-source
occurrence across a changed schedule registration. Actual idle daemon death is
qualified separately from active source-child daemon death.

The journal is scoped to the project folder, with at most 100 registrations,
10000 occurrences per active generation and 100 archived registration generations.
Journal records contain configuration identities, times, counts and error codes;
they do not contain source rows or credentials. The file is private and rejects
symlink escapes. This is local consistency and ownership protection, not signed
history or hostile-writer isolation.

Scheduling requires Node 22.13 or newer for its built-in SQLite interface; other
core operations keep their previous baseline. SQLite loads only when a journal
is accessed. Local source execution keeps its existing POSIX requirement. The
engine uses the synchronous, file-backed API described in the
[Node 22 SQLite documentation](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html).
Public dependency pins and the running Luna preview remain unchanged.
