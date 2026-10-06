/** Atomic local state and claims. No transaction is held across source execution. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { check, Problem } from "./errors.js";
import { fence } from "./packages.js";
import {
  workerRecordSchema,
  type WorkerRecord,
} from "./scheduler-worker-state.js";
import {
  schedulerStateSchema,
  type SchedulerState,
} from "./scheduler-state.js";

export class SchedulerJournal {
  private mutating = false;
  constructor(
    private readonly db: DatabaseSync,
    private readonly writable: boolean,
  ) {}
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    check(
      this.writable,
      "PERMISSION",
      "Journal mutation requires write permission",
    );
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch {
      throw new Problem(
        "SCHEDULE_BUSY",
        "Another worker is updating the schedule journal; retry this tick",
      );
    }
    this.mutating = true;
    try {
      const value = fn();
      check(
        !(value && typeof value === "object" && "then" in value),
        "SCHEDULE_JOURNAL",
        "Journal transactions cannot await execution",
      );
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw journalError(error);
    } finally {
      this.mutating = false;
    }
  }
  /** Retry only a short rolled-back transaction, never the source operation. */
  async retryTransaction<T>(fn: () => T): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return this.transaction(fn);
      } catch (error) {
        if (
          !(error instanceof Problem) ||
          error.code !== "SCHEDULE_BUSY" ||
          attempt >= 39
        )
          throw error;
        await new Promise<void>((done) => setTimeout(done, 50));
      }
    }
  }
  read(key: string): SchedulerState | undefined {
    const row = this.db
      .prepare("SELECT value FROM registrations WHERE id=?")
      .get(key);
    if (!row) return undefined;
    check(
      typeof row.value === "string" && row.value.length <= 10_000_000,
      "SCHEDULE_JOURNAL",
      "Schedule state exceeds its bound",
    );
    return schedulerStateSchema.parse(JSON.parse(row.value));
  }
  write(key: string, state: SchedulerState) {
    check(
      this.writable && this.mutating,
      "PERMISSION",
      "Journal mutation requires an active write transaction",
    );
    schedulerStateSchema.parse(state);
    const value = JSON.stringify(state);
    check(
      value.length <= 10_000_000,
      "SCHEDULE_JOURNAL",
      "Schedule state exceeds its bound",
    );
    if (!this.read(key)) {
      const count = this.db
        .prepare("SELECT count(*) AS total FROM registrations")
        .get()!.total;
      check(
        typeof count === "number" && count < 100,
        "SCHEDULE_LIMIT",
        "Review a journal archive before registering more than 100 flows",
      );
    }
    this.db
      .prepare(
        "INSERT INTO registrations (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  archive(key: string, state: SchedulerState) {
    check(
      this.writable && this.mutating,
      "PERMISSION",
      "Archiving requires an active write transaction",
    );
    const total = this.db
      .prepare("SELECT count(*) AS total FROM history")
      .get()!.total;
    check(
      typeof total === "number" && total < 100,
      "SCHEDULE_HISTORY",
      "Review a history archive before retaining more than 100 registration generations",
    );
    this.db
      .prepare("INSERT INTO history (id,registration,value) VALUES (?,?,?)")
      .run(key + "-" + randomUUID(), key, JSON.stringify(state));
  }
  history(key: string) {
    return this.db
      .prepare(
        "SELECT id FROM history WHERE registration=? ORDER BY rowid DESC LIMIT 100",
      )
      .all(key)
      .map((identity) => {
        // Fetch/parse one generation at a time rather than retaining 100 large states.
        const row = this.db
          .prepare("SELECT id,value FROM history WHERE registration=? AND id=?")
          .get(key, identity.id)!;
        check(
          typeof row.value === "string" && row.value.length <= 10_000_000,
          "SCHEDULE_JOURNAL",
          "Archived state exceeds its bound",
        );
        const state = schedulerStateSchema.parse(JSON.parse(row.value));
        return {
          id: String(row.id),
          bindingDigest: state.bindingDigest,
          from: state.binding.from,
          occurrences: state.work.length,
          succeeded: state.work.filter((v) => v.status === "succeeded").length,
          failed: state.work.filter(
            (v) => v.status === "failed" || v.status === "interrupted",
          ).length,
          cursor: state.cursor,
        };
      });
  }
  generation(key: string, id: string): SchedulerState {
    const row = this.db
      .prepare("SELECT value FROM history WHERE registration=? AND id=?")
      .get(key, id);
    check(
      row && typeof row.value === "string" && row.value.length <= 10000000,
      "SCHEDULE_HISTORY",
      "Choose an archived registration belonging to this flow",
    );
    return schedulerStateSchema.parse(JSON.parse(row.value));
  }
  workers(): WorkerRecord[] {
    // Old read-only journals are observable without a schema migration or any write.
    if (
      !this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='workers'",
        )
        .get()
    )
      return [];
    return this.db
      .prepare("SELECT value FROM workers ORDER BY id LIMIT 100")
      .all()
      .map((row) => {
        check(
          typeof row.value === "string" && row.value.length <= 100000,
          "SCHEDULE_JOURNAL",
          "Worker state exceeds its bound",
        );
        return workerRecordSchema.parse(JSON.parse(row.value));
      });
  }
  worker(id: string) {
    return this.workers().find((v) => v.id === id);
  }
  writeWorker(record: WorkerRecord) {
    check(
      this.writable && this.mutating,
      "PERMISSION",
      "Worker mutation requires an active write transaction",
    );
    workerRecordSchema.parse(record);
    check(
      this.worker(record.id) || this.workers().length < 100,
      "SCHEDULE_LIMIT",
      "Review a worker history archive before creating more than 100 workers",
    );
    const value = JSON.stringify(record);
    check(
      value.length <= 100000,
      "SCHEDULE_JOURNAL",
      "Worker state exceeds its bound",
    );
    this.db
      .prepare(
        "INSERT INTO workers (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(record.id, value);
  }
  driverBusy(resources: string[]) {
    return resources.some(
      (resource) =>
        !!this.db
          .prepare("SELECT resource FROM drivers WHERE resource=?")
          .get(resource),
    );
  }
  claimDriver(resources: string[], worker: string, token: string) {
    check(
      this.writable && this.mutating && !this.driverBusy(resources),
      "SCHEDULE_DRIVER",
      "A background worker already owns one of these flows; inspect and stop that worker first",
    );
    for (const resource of resources)
      this.db
        .prepare("INSERT INTO drivers (resource,worker,token) VALUES (?,?,?)")
        .run(resource, worker, token);
  }
  ownsDriver(resources: string[], worker: string, token: string) {
    return resources.every((resource) => {
      const row = this.db
        .prepare("SELECT worker,token FROM drivers WHERE resource=?")
        .get(resource);
      return row?.worker === worker && row.token === token;
    });
  }
  releaseDriver(resources: string[], worker: string, token: string) {
    check(
      this.writable &&
        this.mutating &&
        this.ownsDriver(resources, worker, token),
      "SCHEDULE_DRIVER",
      "Stopping requires the exact background worker claims",
    );
    for (const resource of resources)
      this.db
        .prepare(
          "DELETE FROM drivers WHERE resource=? AND worker=? AND token=?",
        )
        .run(resource, worker, token);
  }
  busy(resources: string[]) {
    return resources.some(
      (resource) =>
        !!this.db
          .prepare("SELECT resource FROM claims WHERE resource=?")
          .get(resource),
    );
  }
  claim(
    resources: string[],
    registration: string,
    occurrence: string,
    token: string,
  ) {
    check(
      this.writable && this.mutating && !this.busy(resources),
      "SCHEDULE_CLAIM",
      "Scheduled resources are already claimed",
    );
    for (const resource of resources)
      this.db
        .prepare(
          "INSERT INTO claims (resource,registration,occurrence,token) VALUES (?,?,?,?)",
        )
        .run(resource, registration, occurrence, token);
  }
  owns(
    resources: string[],
    registration: string,
    occurrence: string,
    token: string,
  ) {
    return resources.every((resource) => {
      const row = this.db
        .prepare(
          "SELECT registration,occurrence,token FROM claims WHERE resource=?",
        )
        .get(resource);
      return (
        row?.registration === registration &&
        row.occurrence === occurrence &&
        row.token === token
      );
    });
  }
  release(
    resources: string[],
    registration: string,
    occurrence: string,
    token: string,
  ) {
    check(
      this.writable &&
        this.mutating &&
        this.owns(resources, registration, occurrence, token),
      "SCHEDULE_CLAIM",
      "This worker does not own every resource claim",
    );
    for (const resource of resources)
      this.db
        .prepare("DELETE FROM claims WHERE resource=? AND token=?")
        .run(resource, token);
  }
  replaceClaim(
    resources: string[],
    registration: string,
    occurrence: string,
    previous: string,
    token: string,
  ) {
    check(
      this.writable &&
        this.mutating &&
        this.owns(resources, registration, occurrence, previous),
      "SCHEDULE_CLAIM",
      "Recovery requires the exact existing occurrence claim",
    );
    for (const resource of resources)
      this.db
        .prepare("UPDATE claims SET token=? WHERE resource=? AND token=?")
        .run(token, resource, previous);
  }
}

export async function openSchedulerJournal(root: string, writable: boolean) {
  const path = fence(root, ".ingestron/scheduler/state.sqlite");
  if (!writable && !existsSync(path)) return undefined;
  // This API was unflagged in22.13; other core operations retain their22.12 baseline.
  const [major, minor] = process.versions.node.split(".").map(Number);
  check(
    major! > 22 || (major === 22 && minor! >= 13),
    "SCHEDULE_RUNTIME",
    "Local scheduling requires Node 22.13 or newer",
  );
  if (writable) {
    mkdirSync(fence(root, ".ingestron/scheduler"), {
      recursive: true,
      mode: 0o700,
    });
  }
  const { DatabaseSync } = await import("node:sqlite");
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: !writable });
    // Read-only observers tolerate a short commit; writers retain explicit contention.
    db.exec(`PRAGMA busy_timeout=${writable ? 0 : 2000}`);
    if (writable) {
      chmodSync(path, 0o600);
      db.exec("PRAGMA synchronous=FULL");
      db.exec(
        "CREATE TABLE IF NOT EXISTS registrations (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, registration TEXT NOT NULL, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS claims (resource TEXT PRIMARY KEY, registration TEXT NOT NULL, occurrence TEXT NOT NULL, token TEXT NOT NULL); CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS drivers (resource TEXT PRIMARY KEY, worker TEXT NOT NULL, token TEXT NOT NULL)",
      );
    }
    return new SchedulerJournal(db, writable);
  } catch (error) {
    db?.close();
    throw journalError(error);
  }
}
/** Normalise transient SQLite contention at begin, commit, constructor and query boundaries. */
export function journalError(error: unknown) {
  if (
    (error as NodeJS.ErrnoException)?.code === "ERR_SQLITE_ERROR" &&
    /locked|busy/i.test(String((error as Error).message))
  )
    return new Problem(
      "SCHEDULE_BUSY",
      "Another worker is updating the schedule journal; retry this operation",
    );
  return error;
}
