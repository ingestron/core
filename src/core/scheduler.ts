/** Explicit, finite local dispatch. All source execution stays behind performExecution. */
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { canonical, check, digest, Problem } from "./errors.js";
import { fence } from "./packages.js";
import { inspectProject } from "./planner.js";
import {
  executionBoundary,
  executionSchemas,
  performExecution,
} from "./execution.js";
import { validateConnectorScheduleHandover } from "./connector-schedule.js";
import { openSchedulerJournal } from "./scheduler-journal.js";
import {
  bindingDigest,
  schedulerKey,
  schedulerBindingSchema,
  collectScheduledWork,
  exactSecond,
  finishScheduledWork,
  portableSchedule,
  registerScheduler,
  startScheduledWork,
  validateScheduledWork,
  validateSchedulerState,
  type SchedulerBinding,
  type SchedulerState,
} from "./scheduler-state.js";
import type { Context } from "./operations.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
  sha = z.string().regex(/^[a-f0-9]{64}$/);
const selection = {
  flow: id,
  from: z.string().default("build/generated"),
  profile: id.optional(),
};
export const schedulerSchemas = {
  scheduler_inspect: z.object(selection).strict(),
  scheduler_status: z.object({ flow: id }).strict(),
  scheduler_history: z
    .object({
      flow: id,
      generation: z
        .string()
        .regex(/^(current|[a-f0-9]{64}-[a-f0-9-]{36})$/)
        .default("current"),
      status: z
        .enum([
          "all",
          "open",
          "queued",
          "running",
          "succeeded",
          "failed",
          "interrupted",
          "canceled",
          "skipped",
        ])
        .default("all"),
      query: z.string().max(100).default(""),
      page: z.number().int().min(0).max(999).default(0),
      pageSize: z.number().int().min(10).max(100).default(20),
    })
    .strict(),
  scheduler_register: z
    .object({
      ...selection,
      expectedDigest: sha,
      graceSeconds: z.number().int().min(0).max(3600).default(60),
    })
    .strict(),
  scheduler_tick: z
    .object({
      flow: id,
      limit: z.number().int().min(1).max(20).default(1),
      envFile: z.string().optional(),
    })
    .strict(),
  scheduler_pause: z.object({ flow: id, expectedDigest: sha }).strict(),
  scheduler_cancel: z
    .object({ flow: id, occurrence: sha, expectedDigest: sha })
    .strict(),
  scheduler_retry: z
    .object({
      flow: id,
      occurrence: sha,
      expectedDigest: sha,
      envFile: z.string().optional(),
    })
    .strict(),
};

export function schedulerBinding(
  context: Context,
  args: any,
): SchedulerBinding {
  const boundary = executionBoundary(context, { ...args, action: "run" });
  check(
    boundary.manifest.platform === "local" &&
      boundary.capability.transport === "local-python/v1",
    "SCHEDULE_UNSUPPORTED",
    "Portable dispatch requires an installed local execution adapter",
  );
  const inspected = inspectProject(context.root, context.environment ?? "dev", {
    flow: args.flow,
    profile: args.profile,
    draft: true,
  });
  const flow = inspected.flows.find((f) => f.id === args.flow);
  check(
    flow?.schedule,
    "SCHEDULE_UNSUPPORTED",
    "Review a schedule on the selected flow first",
  );
  portableSchedule(flow.schedule);
  const file = fence(boundary.packageRoot, `flows/${args.flow}/connector.json`);
  const config = JSON.parse(readFileSync(file, "utf8"));
  const owner = {
    project: boundary.build.project,
    environment: boundary.build.environment,
    flow: args.flow,
    connection: String(flow.ingestion?.connection),
  };
  check(
    config.projectLock &&
      ["project", "environment", "flow", "connection"].every(
        (k) => config.projectLock[k] === owner[k as keyof typeof owner],
      ),
    "SCHEDULE_STALE",
    "Prepared connector does not match this project, environment and flow",
  );
  const capability =
    boundary.manifest.connectorRuntimes?.[config.projectLock.runtimeContract]
      ?.scheduling;
  check(
    capability?.clock === "portable",
    "SCHEDULE_UNSUPPORTED",
    "This connector adapter has no portable scheduling handover",
  );
  const handover = validateConnectorScheduleHandover(
    config.projectLock.schedule,
    capability,
    owner,
    flow.schedule,
  );
  return schedulerBindingSchema.parse({
    project: owner.project,
    environment: owner.environment,
    flow: args.flow,
    from: relative(resolve(context.root), boundary.directory),
    ...(args.profile ? { profile: args.profile } : {}),
    fingerprint: boundary.fingerprint,
    planDigest: boundary.build ? digest(canonical(boundary.build)) : "",
    scheduleDigest: handover.digest,
    definition: handover.definition,
    resources: boundary.resources,
  });
}

type Controls = {
  clock?: () => string;
  binding?: (context: Context, args: any) => SchedulerBinding;
  run?: (context: Context, args: any) => Promise<any>;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const requireState = (state: SchedulerState | undefined) => {
  check(state, "SCHEDULE_UNKNOWN", "Register this flow's reviewed build first");
  return state;
};

/** Controls are internal test seams; the public operation schema exposes no clock or executor. */
export async function performScheduler(
  context: Context,
  operation: keyof typeof schedulerSchemas,
  args: any,
  controls: Controls = {},
) {
  const root = resolve(context.root),
    environment = context.environment ?? "dev";
  const clock = controls.clock ?? (() => exactSecond(Date.now()));
  const bind = controls.binding ?? schedulerBinding;
  const key = schedulerKey({ environment, flow: args.flow });
  const write = ![
    "scheduler_inspect",
    "scheduler_status",
    "scheduler_history",
  ].includes(operation);
  if (write)
    check(
      context.allowWrite && context.allowExecute,
      "PERMISSION",
      "Scheduling changes require allowWrite and allowExecute",
    );
  const current =
    operation === "scheduler_inspect" || operation === "scheduler_register"
      ? bind(context, args)
      : undefined;
  if (operation === "scheduler_register") {
    check(
      args.expectedDigest === bindingDigest(current!),
      "SCHEDULE_STALE",
      "Review the current build and schedule before registering",
    );
    check(
      current!.definition.enabled,
      "SCHEDULE_PAUSED",
      "Enable the reviewed flow schedule before registering dispatch",
    );
  }
  const journal = await openSchedulerJournal(root, write);
  try {
    if (operation === "scheduler_inspect")
      return {
        apiVersion: "ingestron.scheduler-inspection/v1",
        binding: current,
        digest: bindingDigest(current!),
        state: journal?.read(key) ?? null,
        executionEnabled: false,
      };
    if (operation === "scheduler_status")
      return {
        apiVersion: "ingestron.scheduler-status/v1",
        state: journal?.read(key) ?? null,
        history: journal?.history(key) ?? [],
      };
    if (operation === "scheduler_history") {
      const active = journal?.read(key),
        history = journal?.history(key) ?? [];
      const state =
        args.generation === "current"
          ? active
          : journal?.generation(key, args.generation);
      check(
        args.generation === "current" || state,
        "SCHEDULE_HISTORY",
        "Choose an archived registration belonging to this flow",
      );
      const counts: Record<string, number> = {};
      for (const work of state?.work ?? [])
        counts[work.status] = (counts[work.status] ?? 0) + 1;
      const open = new Set(["queued", "running", "failed", "interrupted"]),
        query = args.query.toLowerCase();
      const filtered = (state?.work ?? [])
        .filter(
          (work) =>
            (args.status === "all" ||
              (args.status === "open"
                ? open.has(work.status)
                : work.status === args.status)) &&
            (!query ||
              work.runId.toLowerCase().includes(query) ||
              work.id.includes(query) ||
              work.at.includes(query) ||
              work.errorCode?.toLowerCase().includes(query)),
        )
        .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
      return {
        apiVersion: "ingestron.scheduler-history/v1",
        flow: args.flow,
        generation: args.generation,
        page: args.page,
        pageSize: args.pageSize,
        total: filtered.length,
        pages: Math.max(1, Math.ceil(filtered.length / args.pageSize)),
        counts,
        generations: [
          {
            id: "current",
            cursor: active?.cursor ?? null,
            occurrences: active?.work.length ?? 0,
          },
          ...history.map(({ id, cursor, occurrences }) => ({
            id,
            cursor,
            occurrences,
          })),
        ],
        entries: filtered
          .slice(args.page * args.pageSize, (args.page + 1) * args.pageSize)
          .map(
            ({
              id,
              at,
              runId,
              status,
              attempt,
              errorCode,
              startedAt,
              finishedAt,
              reason,
            }) => ({
              id,
              at,
              runId,
              status,
              attempt,
              ...(errorCode ? { errorCode } : {}),
              ...(startedAt ? { startedAt } : {}),
              ...(finishedAt ? { finishedAt } : {}),
              ...(reason ? { reason } : {}),
            }),
          ),
      };
    }
    check(journal, "SCHEDULE_JOURNAL", "Schedule journal could not open");
    if (operation === "scheduler_register")
      return journal.transaction(() => {
        check(
          args.expectedDigest === bindingDigest(current!),
          "SCHEDULE_STALE",
          "Review the current build and schedule before registering",
        );
        check(
          current!.definition.enabled,
          "SCHEDULE_PAUSED",
          "Enable the reviewed flow schedule before registering dispatch",
        );
        const previous = journal.read(key);
        check(
          !journal.busy(current!.resources),
          "SCHEDULE_CLAIM",
          "Resolve the existing run claim before re-registering this flow",
        );
        const same = previous?.bindingDigest === bindingDigest(current!);
        if (previous && !same) {
          check(
            !previous.work.some(
              (v) =>
                v.status === "queued" ||
                v.status === "running" ||
                v.status === "failed" ||
                v.status === "interrupted",
            ),
            "SCHEDULE_PENDING",
            "Resolve or cancel pending work before replacing this registration",
          );
          journal.archive(key, previous);
        }
        const state = same
          ? previous!
          : registerScheduler(current!, clock(), args.graceSeconds);
        if (same) {
          if (!state.enabled) state.cursor = clock();
          state.enabled = true;
          state.graceSeconds = args.graceSeconds;
        }
        journal.write(key, state);
        return state;
      });
    const state = requireState(journal.read(key));
    if (operation === "scheduler_pause" || operation === "scheduler_cancel")
      return journal.transaction(() => {
        const latest = requireState(journal.read(key));
        check(
          args.expectedDigest === latest.bindingDigest,
          "SCHEDULE_STALE",
          "The schedule registration changed since review",
        );
        if (operation === "scheduler_pause") latest.enabled = false;
        else {
          const work = latest.work.find((v) => v.id === args.occurrence);
          check(
            work?.status === "queued",
            "SCHEDULE_ACTIVE",
            "Only queued work can be canceled; running or uncertain work keeps its claim",
          );
          work.status = "canceled";
          work.reason = "user";
          work.finishedAt = clock();
        }
        journal.write(key, latest);
        return latest;
      });
    const binding = bind(context, {
      flow: args.flow,
      from: state.binding.from,
      profile: state.binding.profile,
    });
    validateSchedulerState(state, binding);
    if (operation === "scheduler_tick")
      journal.transaction(() => {
        const latest = requireState(journal.read(key));
        validateSchedulerState(latest, binding);
        collectScheduledWork(latest, clock(), journal.busy(binding.resources));
        journal.write(key, latest);
      });
    const outcomes = [];
    for (
      let index = 0;
      index < (operation === "scheduler_retry" ? 1 : args.limit);
      index++
    ) {
      const work = journal.transaction(() => {
        const latest = requireState(journal.read(key));
        validateSchedulerState(latest, binding);
        let next =
          operation === "scheduler_retry"
            ? latest.work.find((v) => v.id === args.occurrence)
            : latest.enabled && latest.binding.definition.enabled
              ? latest.work.find((v) => v.status === "queued")
              : undefined;
        if (!next) return undefined;
        if (operation === "scheduler_retry") {
          check(
            args.expectedDigest === latest.bindingDigest,
            "SCHEDULE_STALE",
            "Review this registration before recovery",
          );
          check(
            ["failed", "interrupted", "running"].includes(next.status),
            "SCHEDULE_RETRY",
            "Only failed, interrupted or indeterminate work can be retried",
          );
          if (next.status === "running")
            check(
              next.workerPid && !alive(next.workerPid),
              "SCHEDULE_ACTIVE",
              "The original worker is still active; no claim was stolen",
            );
          check(
            next.token,
            "SCHEDULE_CLAIM",
            "The failed occurrence has no durable claim token",
          );
          const previous = next.token;
          validateScheduledWork(latest, next, clock());
          const token = startScheduledWork(next, clock(), process.pid);
          journal.replaceClaim(
            binding.resources,
            key,
            next.id,
            previous,
            token,
          );
        } else {
          if (journal.busy(binding.resources)) return undefined;
          validateScheduledWork(latest, next, clock());
          const token = startScheduledWork(next, clock(), process.pid);
          journal.claim(binding.resources, key, next.id, token);
        }
        journal.write(key, latest);
        return structuredClone(next);
      });
      if (!work) break;
      let errorCode: string | undefined;
      try {
        // Fresh preflight immediately before each start. performExecution repeats it,
        // including managed output, source inputs, package locks and policy.
        validateSchedulerState(
          requireState(journal.read(key)),
          bind(context, {
            flow: args.flow,
            from: binding.from,
            profile: binding.profile,
          }),
        );
        check(
          journal.owns(binding.resources, key, work.id, work.token!),
          "SCHEDULE_CLAIM",
          "This worker lost its durable claim",
        );
        const file = fence(root, `.ingestron/runs/${work.runId}.json`);
        const retry = existsSync(file);
        const request = {
          from: binding.from,
          ...(binding.profile ? { profile: binding.profile } : {}),
          action: "run",
          ...(args.envFile ? { envFile: args.envFile } : {}),
          ...(retry
            ? { retry: work.runId }
            : { flow: args.flow, runId: work.runId }),
        };
        await (
          controls.run ??
          ((ctx, a) =>
            performExecution(ctx, "run", executionSchemas.run.parse(a)))
        )(context, request);
      } catch (error) {
        errorCode =
          error instanceof Problem && /^[A-Z][A-Z0-9_]{0,50}$/.test(error.code)
            ? error.code
            : "EXECUTION";
      }
      await journal.retryTransaction(() => {
        const latest = requireState(journal.read(key)),
          entry = latest.work.find((v) => v.id === work.id);
        check(
          entry,
          "SCHEDULE_WORK",
          "Occurrence disappeared during execution",
        );
        finishScheduledWork(entry, work.token!, clock(), errorCode);
        // Uncertain/failed work retains ownership until the same business run succeeds.
        if (!errorCode)
          journal.release(binding.resources, key, work.id, work.token!);
        journal.write(key, latest);
      });
      outcomes.push({
        occurrence: work.id,
        runId: work.runId,
        status:
          errorCode === "INTERRUPTED"
            ? "interrupted"
            : errorCode
              ? "failed"
              : "succeeded",
        ...(errorCode ? { errorCode } : {}),
      });
      if (errorCode) break;
    }
    return {
      apiVersion: "ingestron.scheduler-tick/v1",
      outcomes,
      state: journal.read(key),
    };
  } finally {
    journal?.close();
  }
}
