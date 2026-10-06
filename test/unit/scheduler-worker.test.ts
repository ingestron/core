import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  workerRecordSchema,
  workerSchemas,
  workerView,
} from "../../src/core/scheduler-worker-state.js";
import { performSchedulerWorker } from "../../src/core/scheduler-worker.js";
import { openSchedulerJournal } from "../../src/core/scheduler-journal.js";
import { schedulerKey } from "../../src/core/scheduler-state.js";

function fixture(t: any) {
  const root = mkdtempSync(resolve(tmpdir(), "ingestron-worker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const record = workerRecordSchema.parse({
    apiVersion: "ingestron.scheduler-worker/v1",
    id: randomUUID(),
    token: randomUUID(),
    pid: process.pid,
    environment: "dev",
    status: "running",
    stopRequested: false,
    startedAt: "2026-10-05T10:00:00Z",
    updatedAt: "2026-10-05T10:00:00Z",
    pollSeconds: 5,
    limit: 1,
    flows: [{ flow: "orders", digest: "1".repeat(64) }],
    health: [],
  });
  const keys = record.flows.map((f) =>
    schedulerKey({ environment: record.environment, flow: f.flow }),
  );
  return {
    root,
    record,
    keys,
    context: { root, allowWrite: true, allowExecute: true },
  };
}
test("worker inspection is read-only, mutation needs both permissions, and callers cannot supply executors or clock", async (t) => {
  const f = fixture(t);
  assert.deepEqual(
    (await performSchedulerWorker(f.context, "scheduler_worker_status", {}))
      .workers,
    [],
  );
  for (const permissions of [{ allowWrite: false }, { allowExecute: false }]) {
    await assert.rejects(
      performSchedulerWorker(
        { ...f.context, ...permissions },
        "scheduler_worker_start",
        {},
      ),
      { code: "PERMISSION" },
    );
    await assert.rejects(
      performSchedulerWorker(
        { ...f.context, ...permissions },
        "scheduler_worker_stop",
        { id: f.record.id },
      ),
      { code: "PERMISSION" },
    );
  }
  assert.equal(existsSync(resolve(f.root, ".ingestron")), false);
  const reviewed = {
    flows: ["orders"],
    expectedDigests: { orders: "1".repeat(64) },
  };
  for (const override of [
    { root: "/tmp" },
    { entry: "source.py" },
    { now: "2099-01-01" },
    { flows: ["orders", "orders"] },
    { expectedDigests: { other: "1".repeat(64) } },
  ])
    assert.equal(
      workerSchemas.scheduler_worker_start.safeParse({
        ...reviewed,
        ...override,
      }).success,
      false,
    );
});
test("old journals can be observed without schema migration, changing bytes or creating tables", async (t) => {
  const f = fixture(t),
    directory = resolve(f.root, ".ingestron/scheduler");
  mkdirSync(directory, { recursive: true });
  const file = resolve(directory, "state.sqlite"),
    db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE registrations (id TEXT PRIMARY KEY,value TEXT); CREATE TABLE history (id TEXT PRIMARY KEY,registration TEXT,value TEXT); CREATE TABLE claims (resource TEXT PRIMARY KEY,registration TEXT,occurrence TEXT,token TEXT)",
  );
  db.close();
  const bytes = readFileSync(file);
  assert.deepEqual(
    (await performSchedulerWorker(f.context, "scheduler_worker_status", {}))
      .workers,
    [],
  );
  assert.deepEqual(readFileSync(file), bytes);
});
test("driver reservation is atomic across flows and reopens with the exact private identity", async (t) => {
  const f = fixture(t),
    one = (await openSchedulerJournal(f.root, true))!,
    two = (await openSchedulerJournal(f.root, true))!;
  try {
    assert.throws(() => one.writeWorker(f.record), { code: "PERMISSION" });
    one.transaction(() => {
      one.claimDriver(f.keys, f.record.id, f.record.token);
      one.writeWorker(f.record);
    });
    assert.deepEqual(two.worker(f.record.id), f.record);
    assert.throws(
      () =>
        two.transaction(() =>
          two.claimDriver(["other", ...f.keys], randomUUID(), randomUUID()),
        ),
      { code: "SCHEDULE_DRIVER" },
    );
    assert.equal(one.driverBusy(["other"]), false);
    assert.throws(
      () =>
        two.transaction(() =>
          two.releaseDriver(f.keys, f.record.id, randomUUID()),
        ),
      { code: "SCHEDULE_DRIVER" },
    );
    assert.equal(one.driverBusy(f.keys), true);
  } finally {
    one.close();
    two.close();
  }
});
test("explicit dead worker cleanup retains uncertain business occurrence claims and enforces environment scope", async (t) => {
  const f = fixture(t);
  f.record.pid = 2147483647; // No valid host PID; conservative process probe confirms it is absent.
  const j = (await openSchedulerJournal(f.root, true))!;
  j.transaction(() => {
    j.claimDriver(f.keys, f.record.id, f.record.token);
    j.claim(["business"], "registration", "occurrence", "retained");
    j.writeWorker(f.record);
  });
  j.close();
  await assert.rejects(
    performSchedulerWorker(
      { ...f.context, environment: "prod" },
      "scheduler_worker_stop",
      { id: f.record.id, interrupt: true },
    ),
    { code: "SCHEDULE_UNKNOWN" },
  );
  const result = await performSchedulerWorker(
    f.context,
    "scheduler_worker_stop",
    { id: f.record.id, interrupt: true },
  );
  assert.equal(result.worker?.status, "failed");
  assert.equal(result.worker?.recoveryRequired, false);
  const reopened = (await openSchedulerJournal(f.root, false))!;
  try {
    assert.equal(reopened.driverBusy(f.keys), false);
    assert.equal(
      reopened.owns(["business"], "registration", "occurrence", "retained"),
      true,
    );
  } finally {
    reopened.close();
  }
});
test("stop uses private authenticated control, persists its request and never publishes credentials", async (t) => {
  const f = fixture(t);
  let received: any;
  const server = createServer((connection) => {
    let input = "";
    connection.on("data", (bytes) => {
      input += bytes.toString();
      if (!input.includes("\n")) return;
      received = JSON.parse(input);
      connection.end(
        received.id === f.record.id && received.token === f.record.token
          ? "accepted\n"
          : "denied\n",
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  f.record.port = address.port;
  const j = (await openSchedulerJournal(f.root, true))!;
  j.transaction(() => {
    j.claimDriver(f.keys, f.record.id, f.record.token);
    j.writeWorker(f.record);
  });
  j.close();
  const result = await performSchedulerWorker(
    f.context,
    "scheduler_worker_stop",
    { id: f.record.id, interrupt: false },
  );
  assert.equal(result.controlAccepted, true);
  assert.deepEqual(received, {
    id: f.record.id,
    token: f.record.token,
    interrupt: false,
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(f.record.token), false);
  assert.equal(serialized.includes("port"), false);
  assert.equal(serialized.includes("digest"), false);
  assert.equal(result.worker?.stopRequested, true);
  assert.equal(workerView(f.record).flows[0], "orders");
});

test("read-only schedule observation waits for a real concurrent commit without abandoning its state", async (t) => {
  const f = fixture(t),
    journal = (await openSchedulerJournal(f.root, true))!;
  journal.transaction(() => journal.writeWorker(f.record));
  journal.close();
  const file = resolve(f.root, ".ingestron/scheduler/state.sqlite");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN EXCLUSIVE');process.stdout.write('held\\n');setTimeout(()=>{db.exec('COMMIT');db.close();},250);",
      file,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const exited = new Promise<void>((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? done()
        : reject(new Error("Synthetic journal holder failed")),
    );
  });
  await new Promise<void>((done, reject) => {
    child.stdout.once("data", () => done());
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code) reject(new Error("Synthetic lock was not acquired"));
    });
  });
  const observed = await performSchedulerWorker(
    f.context,
    "scheduler_worker_status",
    { id: f.record.id },
  );
  assert.equal(observed.workers?.[0]?.id, f.record.id);
  await exited;
});

test("a reader-blocked commit is reported as contention and rolls back every driver reservation", async (t) => {
  const f = fixture(t),
    journal = (await openSchedulerJournal(f.root, true))!;
  const observer = new DatabaseSync(
    resolve(f.root, ".ingestron/scheduler/state.sqlite"),
    { readOnly: true },
  );
  try {
    observer.exec("BEGIN");
    observer.prepare("SELECT value FROM workers").all();
    assert.throws(
      () =>
        journal.transaction(() => {
          journal.claimDriver(f.keys, f.record.id, f.record.token);
          journal.writeWorker(f.record);
        }),
      { code: "SCHEDULE_BUSY" },
    );
    observer.exec("COMMIT");
    assert.equal(journal.worker(f.record.id), undefined);
    assert.equal(journal.driverBusy(f.keys), false);
    journal.transaction(() => {
      journal.claimDriver(f.keys, f.record.id, f.record.token);
      journal.writeWorker(f.record);
    });
    assert.equal(journal.worker(f.record.id)?.id, f.record.id);
  } finally {
    observer.close();
    journal.close();
  }
});
