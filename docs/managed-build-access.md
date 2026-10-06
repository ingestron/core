# Recover a run before rebuilding its files

An active source run owns the managed build it uses. Ingestron refuses generation
into that directory and another operation on an overlapping flow until the run
releases ownership. The `EXECUTION_ACTIVE` diagnostic names the original run.
This guide describes the private core0.12.30/CLI0.17.14 candidate.

Generation and execution preflight use the same short guard. Execution records
its source process group before sending a request; generation cannot replace
the files that group is using. The guard is released before source work begins,
so independent flows in the same build can execute without holding a generator
lock throughout ingestion. Any active flow prevents generation of the whole
managed build. An independent output directory can still be generated offline.

## Recover ordinary local runs

Start with the same project, environment, provider versions, build directory and
flow selection that created the run. Replace `YOUR_RUN_ID` with the ID in the
diagnostic. The following normal CLI commands are qualified against the installed
local/files route:

```sh
ingestron --project ./retail --json --no-input run status YOUR_RUN_ID
ingestron --project ./retail --json --no-input run --retry YOUR_RUN_ID
```

A live caller or source process group refuses recovery. Wait for that work to
finish. If the caller died, its source may still be writing; an absent caller PID
does not release ownership. Even after the source exits, uncertain ownership
remains until explicit recovery of the original run. Retry requires its unchanged
build and selection. The qualified source returns an existing committed run
without rereading changed source data or creating a second commit. Once recovery
finishes and the source group is gone, rebuild that directory.

For scheduled work, use the original occurrence through `schedule history` and
`schedule retry`, as described in the CLI worker guide. This updates the scheduler's
business claim and history as well as its execution receipt. Releasing a lost
background driver is separate from recovering its source occurrence.

Do not delete ownership state to force a rebuild: a source process can commit
after its caller has been killed. Correct a known source failure, then recover
through the recorded run or scheduled occurrence. Build and process-group state
is internal; Studio's generated-asset list and file reader exclude it.

## Scope of qualification

Core tests use a real competing process to verify generation/preflight exclusion,
independent flow access, exact ownership transfer, stale execution-preflight
recovery and retention of a crashed generator's guard. A crashed generator's
partial writes are not treated as a recoverable source run; inspect the managed
file differences before restoring generation.

Installed local0.4.10/files1.5.8 acceptance holds real source processes while
attempting a rebuild and a second flow run, then kills only the confirmed test
daemon. Recovery retains the original 200000-order/3-customer commit and leaves
its output and source review unchanged. Shared Studio host acceptance additionally
qualifies the bounded failed build job and refusal to read internal ownership
files. These checks do not qualify shared physical targets across builds or
projects, other source routes, native deployment, browser clicks or power loss.
