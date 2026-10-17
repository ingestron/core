/** Portable dispatch state transitions. No live clocks, files or source access. */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { canonical, check, digest } from "./errors.js";
import {
  scheduleInstantSchema,
  scheduleSchema,
  type Schedule,
} from "./schedule-schema.js";
import { scheduleOccurrences } from "./schedule-clock.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const schedulerBindingSchema = z
  .object({
    project: z.string().min(1),
    environment: z.string().min(1),
    flow: z.string().min(1),
    from: z.string().min(1),
    profile: z.string().optional(),
    fingerprint: sha,
    planDigest: sha,
    scheduleDigest: sha,
    definition: scheduleSchema,
    resources: z
      .array(sha)
      .min(1)
      .max(128)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();
export type SchedulerBinding = z.infer<typeof schedulerBindingSchema>;
const workSchema = z
  .object({
    id: sha,
    at: scheduleInstantSchema,
    runId: z.string().regex(/^schedule-[a-f0-9]{64}$/),
    status: z.enum([
      "queued",
      "running",
      "succeeded",
      "failed",
      "interrupted",
      "canceled",
      "skipped",
    ]),
    reason: z.enum(["missed", "overlap", "user"]).optional(),
    attempt: z.number().int().min(0).max(1000),
    token: z.string().uuid().optional(),
    workerPid: z.number().int().positive().optional(),
    startedAt: scheduleInstantSchema.optional(),
    finishedAt: scheduleInstantSchema.optional(),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,50}$/)
      .optional(),
  })
  .strict();
export const schedulerStateSchema = z
  .object({
    apiVersion: z.literal("ingestron.scheduler-state/v1"),
    binding: schedulerBindingSchema,
    bindingDigest: sha,
    enabled: z.boolean(),
    cursor: scheduleInstantSchema,
    graceSeconds: z.number().int().min(0).max(3600),
    work: z
      .array(workSchema)
      .max(10000)
      .refine(
        (values) => new Set(values.map((v) => v.id)).size === values.length,
      ),
  })
  .strict();
export type SchedulerState = z.infer<typeof schedulerStateSchema>;
export type SchedulerWork = z.infer<typeof workSchema>;
export const schedulerKey = ({
  environment,
  flow,
}: Pick<SchedulerBinding, "environment" | "flow">) =>
  digest(canonical({ environment, flow }));
export const bindingDigest = (binding: SchedulerBinding) =>
  digest(canonical(schedulerBindingSchema.parse(binding)));
export const exactSecond = (millis: number) =>
  new Date(Math.floor(millis / 1000) * 1000)
    .toISOString()
    .replace(".000Z", "Z");
export function registerScheduler(
  binding: SchedulerBinding,
  now: string,
  graceSeconds: number,
): SchedulerState {
  return schedulerStateSchema.parse({
    apiVersion: "ingestron.scheduler-state/v1",
    binding,
    bindingDigest: bindingDigest(binding),
    enabled: true,
    cursor: now,
    graceSeconds,
    work: [],
  });
}

export function validateSchedulerState(
  state: SchedulerState,
  binding: SchedulerBinding,
) {
  schedulerStateSchema.parse(state);
  check(
    state.bindingDigest === bindingDigest(binding) &&
      state.bindingDigest === bindingDigest(state.binding),
    "SCHEDULE_STALE",
    "The registered build, source, package, schedule or clock changed; review registration again",
  );
}

function occurrenceIdentity(
  state: SchedulerState,
  at: string,
  clockId: string,
) {
  return digest(canonical({ binding: state.bindingDigest, at, clockId }));
}

export function validateScheduledWork(
  state: SchedulerState,
  work: SchedulerWork,
  now: string,
) {
  check(
    work.at <= now,
    "SCHEDULE_CLOCK",
    "Scheduled work cannot run before its due instant",
  );
  const preview = scheduleOccurrences({
    schedule: state.binding.definition,
    from: work.at,
    to: exactSecond(Date.parse(work.at) + 1000),
    limit: 1,
  });
  const occurrence = preview.occurrences[0];
  check(
    occurrence &&
      occurrence.at === work.at &&
      work.id === occurrenceIdentity(state, work.at, occurrence.id) &&
      work.runId === `schedule-${work.id}`,
    "SCHEDULE_WORK",
    "Work does not match this registered schedule occurrence",
  );
}

/** Latest applies to newly discovered missed occurrences, not a previously queued overlap. */
export function collectScheduledWork(
  state: SchedulerState,
  now: string,
  resourceBusy: boolean,
) {
  check(
    Date.parse(now) + 1000 >= Date.parse(state.cursor),
    "SCHEDULE_CLOCK",
    "Host clock moved backwards; keep the existing cursor and inspect clock synchronisation",
  );
  if (!state.enabled || !state.binding.definition.enabled) {
    state.cursor = now;
    return;
  }
  const end = exactSecond(Date.parse(now) + 1000);
  if (end <= state.cursor) return;
  check(
    Date.parse(end) - Date.parse(state.cursor) <= 366 * 86400000,
    "SCHEDULE_BACKLOG",
    "The dispatch gap exceeds 366 days; review an explicit backfill before moving the cursor",
  );
  const preview = scheduleOccurrences({
    schedule: state.binding.definition,
    from: state.cursor,
    to: end,
    limit: 1000,
  });
  check(
    !preview.truncated,
    "SCHEDULE_BACKLOG",
    "More than 1000 occurrences are due; review a bounded backfill without discarding the cursor",
  );
  check(
    state.work.length + preview.occurrences.length <= 10000,
    "SCHEDULE_HISTORY",
    "The journal reached 10000 occurrences; review a history archive before continuing",
  );
  const latest = preview.occurrences.at(-1)?.id;
  const definition = state.binding.definition;
  for (const occurrence of preview.occurrences) {
    const id = occurrenceIdentity(state, occurrence.at, occurrence.id);
    if (state.work.some((v) => v.id === id)) continue;
    const missed =
      definition.missed === "latest"
        ? occurrence.id !== latest
        : Date.parse(now) - Date.parse(occurrence.at) >
          state.graceSeconds * 1000;
    const overlap = resourceBusy && definition.overlap === "skip";
    state.work.push({
      id,
      at: occurrence.at,
      runId: `schedule-${id}`,
      attempt: 0,
      status: missed || overlap ? "skipped" : "queued",
      ...(missed || overlap
        ? { reason: missed ? ("missed" as const) : ("overlap" as const) }
        : {}),
    });
  }
  state.cursor = end;
}

export function startScheduledWork(
  work: SchedulerWork,
  now: string,
  pid: number,
) {
  check(
    work.attempt < 1000,
    "SCHEDULE_ATTEMPTS",
    "Review recovery after 1000 attempts",
  );
  work.status = "running";
  work.attempt++;
  work.token = randomUUID();
  work.workerPid = pid;
  work.startedAt = now;
  delete work.errorCode;
  delete work.finishedAt;
  return work.token;
}

export function finishScheduledWork(
  work: SchedulerWork,
  token: string,
  now: string,
  errorCode?: string,
) {
  check(
    work.status === "running" && work.token === token,
    "SCHEDULE_CLAIM",
    "This worker no longer owns the occurrence",
  );
  work.status = errorCode
    ? errorCode === "INTERRUPTED"
      ? "interrupted"
      : "failed"
    : "succeeded";
  work.finishedAt = now;
  if (errorCode) work.errorCode = errorCode;
}

export function portableSchedule(definition: Schedule) {
  check(
    definition.overlap !== "native" && definition.missed !== "native",
    "SCHEDULE_POLICY",
    "Portable dispatch cannot implement native clock policies",
  );
}
