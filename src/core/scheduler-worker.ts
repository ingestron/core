/** Durable local driver. Registration, occurrence claims and execution stay in scheduler.ts. */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { check, Problem } from "./errors.js";
import { fence } from "./packages.js";
import type { Context } from "./operations.js";
import {
  schedulerBinding,
  performScheduler,
  schedulerSchemas,
} from "./scheduler.js";
import {
  bindingDigest,
  schedulerKey,
  exactSecond,
  validateSchedulerState,
  type SchedulerState,
} from "./scheduler-state.js";
import {
  openSchedulerJournal,
  journalError,
  type SchedulerJournal,
} from "./scheduler-journal.js";
import {
  workerSchemas,
  workerRecordSchema,
  workerAlive,
  workerView,
  type WorkerRecord,
} from "./scheduler-worker-state.js";
export { workerSchemas } from "./scheduler-worker-state.js";

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const now = () => exactSecond(Date.now());
const resources = (r: WorkerRecord) =>
  r.flows.map((f) =>
    schedulerKey({ environment: r.environment, flow: f.flow }),
  );
const safeCode = (error: unknown) =>
  error instanceof Problem && /^[A-Z][A-Z0-9_]{0,50}$/.test(error.code)
    ? error.code
    : "SCHEDULE_WORKER";
const terminal = (r: WorkerRecord) =>
  r.status === "stopped" || r.status === "failed";
function requireWorker(j: SchedulerJournal, id: string, environment: string) {
  const r = j.worker(id);
  check(
    r && r.environment === environment,
    "SCHEDULE_UNKNOWN",
    "This environment has no such worker",
  );
  return r;
}
async function withJournal<T>(
  root: string,
  writable: boolean,
  fn: (j: SchedulerJournal) => T,
) {
  for (let attempt = 0; ; attempt++) {
    let j: SchedulerJournal | undefined;
    try {
      j = await openSchedulerJournal(root, writable);
      check(
        j,
        "SCHEDULE_UNKNOWN",
        "No schedule journal exists in this project",
      );
      return fn(j);
    } catch (error) {
      const problem = journalError(error);
      if (
        writable ||
        !(problem instanceof Problem) ||
        problem.code !== "SCHEDULE_BUSY" ||
        attempt >= 39
      )
        throw problem;
    } finally {
      j?.close();
    }
    await sleep(50);
  }
}
async function update<T>(
  root: string,
  fn: (j: SchedulerJournal) => T,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withJournal(root, true, (j) => j.transaction(() => fn(j)));
    } catch (error) {
      if (
        !(error instanceof Problem) ||
        error.code !== "SCHEDULE_BUSY" ||
        attempt >= 39
      )
        throw error;
      await sleep(50);
    }
  }
}
function finish(j: SchedulerJournal, record: WorkerRecord, errorCode?: string) {
  // Driver shutdown never releases the separately owned source occurrence claims.
  j.releaseDriver(resources(record), record.id, record.token);
  record.status = errorCode ? "failed" : "stopped";
  record.updatedAt = now();
  if (errorCode) record.errorCode = errorCode;
  delete record.port;
  j.writeWorker(record);
  return workerView(record);
}
async function sendStop(record: WorkerRecord, interrupt: boolean) {
  if (!record.port) return false;
  return await new Promise<boolean>((done) => {
    let settled = false;
    const connection = createConnection({
      host: "127.0.0.1",
      port: record.port!,
    });
    const complete = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      connection.destroy();
      done(accepted);
    };
    connection.setTimeout(2000, () => complete(false));
    connection.on("error", () => complete(false));
    connection.on("end", () => complete(false));
    let response = "";
    connection.on("data", (bytes) => {
      response += bytes.toString();
      if (response.length > 100) complete(false);
      else if (response.includes("\n")) complete(response === "accepted\n");
    });
    connection.on("connect", () =>
      connection.write(
        JSON.stringify({ id: record.id, token: record.token, interrupt }) +
          "\n",
      ),
    );
  });
}
export async function performSchedulerWorker(
  context: Context,
  operation: keyof typeof workerSchemas,
  args: any,
) {
  const root = realpathSync(context.root),
    environment = context.environment ?? "dev";
  if (operation === "scheduler_worker_status") {
    const j = await openSchedulerJournal(root, false);
    try {
      const rows = (j?.workers() ?? []).filter(
        (r) => r.environment === environment && (!args.id || r.id === args.id),
      );
      return {
        apiVersion: "ingestron.scheduler-workers/v1",
        workers: rows.map(workerView),
      };
    } finally {
      j?.close();
    }
  }
  check(
    context.allowWrite && context.allowExecute,
    "PERMISSION",
    "Worker lifecycle changes require allowWrite and allowExecute",
  );
  if (operation === "scheduler_worker_stop") {
    const record = await update(root, (j) => {
      const r = requireWorker(j, args.id, environment);
      if (terminal(r)) return r;
      if (!workerAlive(r.pid)) {
        finish(j, r, "SCHEDULE_WORKER_LOST");
        return r;
      }
      r.stopRequested = true;
      r.status = "stopping";
      r.updatedAt = now();
      j.writeWorker(r);
      return r;
    });
    const controlAccepted =
      !terminal(record) && (await sendStop(record, args.interrupt));
    return {
      apiVersion: "ingestron.scheduler-worker-stop/v1",
      worker: workerView(record),
      controlAccepted,
    };
  }
  check(
    process.platform !== "win32",
    "SCHEDULE_RUNTIME",
    "Detached local workers currently require a POSIX host",
  );
  const parsed = workerSchemas.scheduler_worker_start.parse(args);
  if (parsed.envFile) fence(root, parsed.envFile);
  // Validate all bindings before reserving any driver. No source is read by this review.
  const selected = await withJournal(root, false, (j) =>
    parsed.flows.map((flow) => {
      const state = j.read(schedulerKey({ environment, flow }));
      check(
        state,
        "SCHEDULE_UNKNOWN",
        "Register every selected flow before starting a worker",
      );
      const binding = schedulerBinding(context, {
        flow,
        from: state.binding.from,
        profile: state.binding.profile,
      });
      validateSchedulerState(state, binding);
      check(
        parsed.expectedDigests[flow] === bindingDigest(binding),
        "SCHEDULE_STALE",
        "Review the current registration before starting a worker",
      );
      return { flow, digest: state.bindingDigest };
    }),
  );
  const record = workerRecordSchema.parse({
    apiVersion: "ingestron.scheduler-worker/v1",
    id: randomUUID(),
    token: randomUUID(),
    pid: process.pid,
    environment,
    status: "starting",
    stopRequested: false,
    startedAt: now(),
    updatedAt: now(),
    pollSeconds: parsed.pollSeconds,
    limit: parsed.limit,
    flows: selected,
    health: [],
  });
  await update(root, (j) => {
    for (const f of selected)
      check(
        j.read(schedulerKey({ environment, flow: f.flow }))?.bindingDigest ===
          f.digest,
        "SCHEDULE_STALE",
        "A selected registration changed during worker review",
      );
    j.claimDriver(resources(record), record.id, record.token);
    j.writeWorker(record);
  });
  // Only this installed built-in entry point may run; workspace paths cannot select an executable.
  const entry = fileURLToPath(
    new URL("./scheduler-worker-main.js", import.meta.url),
  );
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.on("error", () => {});
  let spawned = false;
  try {
    await new Promise<void>((done, reject) => {
      child.once("spawn", done);
      child.once("error", reject);
    });
    spawned = true;
    const identity = await update(root, (j) => {
      const r = requireWorker(j, record.id, environment);
      check(
        r.token === record.token &&
          r.pid === process.pid &&
          r.status === "starting",
        "SCHEDULE_DRIVER",
        "Worker reservation changed during startup",
      );
      r.pid = child.pid!;
      r.updatedAt = now();
      j.writeWorker(r);
      return r;
    });
    child.stdin.end(
      JSON.stringify({
        root,
        environment,
        id: identity.id,
        token: identity.token,
        allowNetwork: context.allowNetwork === true,
        ...(parsed.envFile ? { envFile: parsed.envFile } : {}),
      }) + "\n",
    );
    child.unref();
    for (let attempt = 0; attempt < 100; attempt++) {
      const r = await withJournal(root, false, (j) =>
        requireWorker(j, record.id, environment),
      );
      if (r.status === "running" || r.status === "stopping")
        return {
          apiVersion: "ingestron.scheduler-worker-start/v1",
          worker: workerView(r),
        };
      if (terminal(r) || !workerAlive(r.pid)) break;
      await sleep(50);
    }
    await update(root, (j) => {
      const r = requireWorker(j, record.id, environment);
      if (!terminal(r)) {
        r.stopRequested = true;
        r.updatedAt = now();
        if (!workerAlive(r.pid)) finish(j, r, "SCHEDULE_WORKER_START");
        else j.writeWorker(r);
      }
    });
    throw new Problem(
      "SCHEDULE_WORKER_START",
      "Worker did not become ready; inspect its durable status before starting another",
    );
  } catch (error) {
    if (!spawned)
      await update(root, (j) =>
        finish(
          j,
          requireWorker(j, record.id, environment),
          "SCHEDULE_WORKER_START",
        ),
      );
    else child.stdin.end();
    child.unref();
    throw error instanceof Problem
      ? error
      : new Problem(
          "SCHEDULE_WORKER_START",
          "Worker startup failed; inspect durable status before recovery",
        );
  }
}

export const workerConfigSchema = z
  .object({
    root: z.string().min(1).max(4096),
    environment: z.string().min(1).max(100),
    id: z.string().uuid(),
    token: z.string().uuid(),
    allowNetwork: z.boolean(),
    envFile: z.string().min(1).max(4096).optional(),
  })
  .strict();
export async function runSchedulerWorker(
  config: z.infer<typeof workerConfigSchema>,
) {
  const root = realpathSync(config.root),
    context: Context = {
      root,
      environment: config.environment,
      allowWrite: true,
      allowExecute: true,
      allowNetwork: config.allowNetwork,
    };
  let stopping = false,
    failed: string | undefined,
    server: Server | undefined;
  const connections = new Set<Socket>();
  const stop = () => {
    stopping = true;
  };
  const owned = (j: SchedulerJournal) => {
    const r = requireWorker(j, config.id, config.environment);
    check(
      r.token === config.token &&
        r.pid === process.pid &&
        !terminal(r) &&
        j.ownsDriver(resources(r), r.id, r.token),
      "SCHEDULE_DRIVER",
      "This process no longer owns the background worker",
    );
    return r;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await withJournal(root, false, owned);
    server = createServer((connection) => {
      connections.add(connection);
      connection.on("close", () => connections.delete(connection));
      let input = "";
      connection.setTimeout(2000, () => connection.destroy());
      connection.on("error", () => {});
      connection.on("data", (bytes) => {
        input += bytes.toString();
        if (input.length > 1024) {
          connection.destroy();
          return;
        }
        if (!input.includes("\n")) return;
        try {
          const request = z
            .object({
              id: z.literal(config.id),
              token: z.literal(config.token),
              interrupt: z.boolean(),
            })
            .strict()
            .parse(JSON.parse(input));
          stopping = true;
          connection.end("accepted\n");
          if (request.interrupt) process.emit("SIGTERM", "SIGTERM");
        } catch {
          connection.destroy();
        }
      });
    });
    server.maxConnections = 8;
    await new Promise<void>((done, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", done);
    });
    server.on("error", () => {
      failed = "SCHEDULE_CONTROL";
      stopping = true;
    });
    const address = server.address();
    check(
      address && typeof address !== "string",
      "SCHEDULE_CONTROL",
      "Worker control could not listen locally",
    );
    await update(root, (j) => {
      const r = owned(j);
      r.port = address.port;
      r.status = r.stopRequested ? "stopping" : "running";
      r.updatedAt = now();
      j.writeWorker(r);
    });
    while (!stopping) {
      const record = await withJournal(root, false, owned);
      if (record.stopRequested) break;
      for (const selection of record.flows) {
        const reviewed = await withJournal(root, false, (j) => {
          const r = owned(j);
          return {
            stop: r.stopRequested,
            state: j.read(
              schedulerKey({
                environment: r.environment,
                flow: selection.flow,
              }),
            ),
          };
        });
        if (stopping || reviewed.stop) {
          stopping = true;
          break;
        }
        let errorCode: string | undefined,
          state = reviewed.state;
        try {
          check(
            state && state.bindingDigest === selection.digest,
            "SCHEDULE_STALE",
            "Worker registration changed; review and restart the driver",
          );
          if (state.enabled) {
            const result = await performScheduler(
              context,
              "scheduler_tick",
              schedulerSchemas.scheduler_tick.parse({
                flow: selection.flow,
                limit: record.limit,
                ...(config.envFile ? { envFile: config.envFile } : {}),
              }),
            );
            if ("outcomes" in result)
              errorCode = result.outcomes?.find(
                (v) => v.status !== "succeeded",
              )?.errorCode;
            state = await withJournal(root, false, (j) =>
              j.read(
                schedulerKey({
                  environment: config.environment,
                  flow: selection.flow,
                }),
              ),
            );
          }
        } catch (error) {
          errorCode = safeCode(error);
        }
        await update(root, (j) => {
          const r = owned(j),
            health: WorkerRecord["health"][number] = {
              flow: selection.flow,
              checkedAt: now(),
              status: errorCode
                ? "attention"
                : !state?.enabled
                  ? "paused"
                  : "idle",
              counts: counts(state),
              ...(errorCode ? { errorCode } : {}),
            };
          // A retained failure is attention even on later ticks with no new outcomes.
          if (
            !errorCode &&
            state?.work.some(
              (v) => v.status === "failed" || v.status === "interrupted",
            )
          ) {
            health.status = "attention";
            health.errorCode = "SCHEDULE_PENDING";
          }
          r.health = [
            ...r.health.filter((v) => v.flow !== selection.flow),
            health,
          ];
          r.updatedAt = now();
          j.writeWorker(r);
        });
      }
      for (let second = 0; second < record.pollSeconds && !stopping; second++) {
        if ((await withJournal(root, false, owned)).stopRequested) {
          stopping = true;
          break;
        }
        await sleep(1000);
      }
    }
  } catch (error) {
    failed = safeCode(error);
  } finally {
    if (server) {
      server.close();
      for (const connection of connections) connection.destroy();
    }
    try {
      await update(root, (j) => finish(j, owned(j), failed));
    } catch {
      /* Claims remain if ownership or durable storage is unavailable. */
    }
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
function counts(state: SchedulerState | undefined) {
  const result = {
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    interrupted: 0,
    canceled: 0,
    skipped: 0,
  };
  for (const work of state?.work ?? []) result[work.status]++;
  return result;
}
