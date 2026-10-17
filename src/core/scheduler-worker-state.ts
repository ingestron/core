/** Private worker identities and bounded public health, independent of source protocols. */
import { z } from "zod";
import { scheduleInstantSchema } from "./schedule-schema.js";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,50}$/);
export const workerStartSchema = z
  .object({
    flows: z
      .array(id)
      .min(1)
      .max(100)
      .refine((v) => new Set(v).size === v.length),
    expectedDigests: z.record(id, sha),
    pollSeconds: z.number().int().min(1).max(60).default(5),
    limit: z.number().int().min(1).max(20).default(1),
    envFile: z.string().min(1).max(4096).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.flows.length === Object.keys(v.expectedDigests).length &&
      v.flows.every((f) => v.expectedDigests[f]),
    { message: "Review exactly one digest for every selected flow" },
  );
export const workerSchemas = {
  scheduler_worker_start: workerStartSchema,
  scheduler_worker_status: z
    .object({ id: z.string().uuid().optional() })
    .strict(),
  scheduler_worker_stop: z
    .object({ id: z.string().uuid(), interrupt: z.boolean().default(true) })
    .strict(),
};
export const workerRecordSchema = z
  .object({
    apiVersion: z.literal("ingestron.scheduler-worker/v1"),
    id: z.string().uuid(),
    token: z.string().uuid(),
    pid: z.number().int().positive(),
    port: z.number().int().min(1).max(65535).optional(),
    environment: id,
    status: z.enum(["starting", "running", "stopping", "stopped", "failed"]),
    stopRequested: z.boolean(),
    startedAt: scheduleInstantSchema,
    updatedAt: scheduleInstantSchema,
    pollSeconds: z.number().int().min(1).max(60),
    limit: z.number().int().min(1).max(20),
    flows: z
      .array(z.object({ flow: id, digest: sha }).strict())
      .min(1)
      .max(100)
      .refine((v) => new Set(v.map((f) => f.flow)).size === v.length),
    health: z
      .array(
        z
          .object({
            flow: id,
            checkedAt: scheduleInstantSchema,
            status: z.enum(["idle", "paused", "attention"]),
            counts: z.record(
              z.enum([
                "queued",
                "running",
                "succeeded",
                "failed",
                "interrupted",
                "canceled",
                "skipped",
              ]),
              z.number().int().min(0).max(10000),
            ),
            errorCode: code.optional(),
          })
          .strict(),
      )
      .max(100)
      .refine((v) => new Set(v.map((f) => f.flow)).size === v.length),
    errorCode: code.optional(),
  })
  .strict();
export type WorkerRecord = z.infer<typeof workerRecordSchema>;
export function workerAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export function workerView(record: WorkerRecord) {
  const alive = workerAlive(record.pid);
  return {
    apiVersion: record.apiVersion,
    id: record.id,
    pid: record.pid,
    environment: record.environment,
    status: record.status,
    stopRequested: record.stopRequested,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    pollSeconds: record.pollSeconds,
    limit: record.limit,
    flows: record.flows.map((v) => v.flow),
    health: record.health,
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    alive,
    recoveryRequired:
      ["starting", "running", "stopping"].includes(record.status) && !alive,
  };
}
