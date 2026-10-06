import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Problem } from "../../src/core/errors.js";
import { spawn } from "node:child_process";
import {
  performScheduler,
  schedulerSchemas,
} from "../../src/core/scheduler.js";
import { openSchedulerJournal } from "../../src/core/scheduler-journal.js";
import {
  bindingDigest,
  schedulerKey,
  type SchedulerBinding,
} from "../../src/core/scheduler-state.js";
const binding: SchedulerBinding = {
  project: "retail",
  environment: "dev",
  flow: "bronze",
  from: "build/generated",
  fingerprint: "1".repeat(64),
  planDigest: "2".repeat(64),
  scheduleDigest: "3".repeat(64),
  resources: ["4".repeat(64)],
  definition: {
    apiVersion: "ingestron.schedule/v1",
    enabled: true,
    timeZone: "UTC",
    start: "2026-10-05T10:00:17Z",
    end: "2026-10-06T10:00:17Z",
    recurrence: { kind: "interval", minutes: 1 },
    overlap: "queue",
    missed: "skip",
  },
};
function fixture(t: any, changes: Partial<SchedulerBinding> = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "ingestron-scheduler-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = "2026-10-05T10:00:17Z";
  const actual = { ...structuredClone(binding), ...changes };
  const context = {
    root,
    allowWrite: true,
    allowExecute: true,
    allowNetwork: false,
  };
  const calls: any[] = [];
  const controls = {
    clock: () => now,
    binding: () => actual,
    run: async (_ctx: any, args: any) => {
      calls.push(args);
      return { status: "succeeded" };
    },
  };
  const op = (name: keyof typeof schedulerSchemas, args: any = {}) =>
    performScheduler(
      context,
      name,
      schedulerSchemas[name].parse({ flow: "bronze", ...args }),
      controls,
    );
  const register = () =>
    op("scheduler_register", {
      expectedDigest: bindingDigest(actual),
      graceSeconds: 3600,
    });
  return {
    root,
    actual,
    context,
    controls,
    calls,
    op,
    register,
    clock: (value: string) => {
      now = value;
    },
  };
}

test("read-only status and denied mutation create no journal; public schemas cannot spoof the clock or executor", async (t) => {
  const f = fixture(t);
  const status = await f.op("scheduler_status");
  assert.equal(status.state, null);
  assert.equal(existsSync(resolve(f.root, ".ingestron")), false);
  for (const allow of [{ allowWrite: false }, { allowExecute: false }])
    await assert.rejects(
      performScheduler(
        { ...f.context, ...allow },
        "scheduler_register",
        {
          flow: "bronze",
          from: "build/generated",
          expectedDigest: bindingDigest(f.actual),
          graceSeconds: 60,
        },
        f.controls,
      ),
      { code: "PERMISSION" },
    );
  assert.equal(existsSync(resolve(f.root, ".ingestron")), false);
  assert.equal(
    schedulerSchemas.scheduler_tick.safeParse({
      flow: "bronze",
      now: "2099-01-01T00:00:00Z",
    }).success,
    false,
  );
  assert.equal(
    schedulerSchemas.scheduler_tick.safeParse({
      flow: "bronze",
      run: "arbitrary",
    }).success,
    false,
  );
});

test("committed work survives reopen and repeat ticks preserve the same occurrence without rerunning it", async (t) => {
  const f = fixture(t);
  await f.register();
  const first = await f.op("scheduler_tick");
  assert.equal(first.outcomes.length, 1);
  assert.equal(f.calls.length, 1);
  const same = await f.op("scheduler_tick");
  assert.equal(same.outcomes.length, 0);
  assert.equal(f.calls.length, 1);
  const reopened = await f.op("scheduler_status");
  assert.equal(reopened.state.work[0].status, "succeeded");
  assert.match(reopened.state.work[0].runId, /^schedule-[a-f0-9]{64}$/);
  f.clock("2026-10-05T10:01:17Z");
  await f.op("scheduler_tick");
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0].runId, f.calls[1].runId);
});

test("SQLite transactions isolate workers, roll back all claims and never await source execution", async (t) => {
  const f = fixture(t);
  const one = (await openSchedulerJournal(f.root, true))!,
    two = (await openSchedulerJournal(f.root, true))!;
  try {
    assert.throws(() => one.write("test", {} as any), { code: "PERMISSION" });
    one.transaction(() =>
      assert.throws(() => two.transaction(() => undefined), {
        code: "SCHEDULE_BUSY",
      }),
    );
    assert.throws(() =>
      one.transaction(() => {
        one.claim(["5".repeat(64)], "registration", "occurrence", "token");
        throw Error("synthetic rollback");
      }),
    );
    assert.equal(two.busy(["5".repeat(64)]), false);
    assert.throws(() => one.transaction(() => Promise.resolve()), {
      code: "SCHEDULE_JOURNAL",
    });
  } finally {
    one.close();
    two.close();
  }
});

test("queue overlaps persist while another worker runs, then execute once after its claim is released", async (t) => {
  const f = fixture(t);
  await f.register();
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>((done) => (started = done)),
    blocked = new Promise<void>((done) => (release = done));
  f.controls.run = async (_ctx, args) => {
    f.calls.push(args);
    started();
    await blocked;
    return {};
  };
  const running = f.op("scheduler_tick");
  await ready;
  f.clock("2026-10-05T10:02:17Z");
  const concurrent = await f.op("scheduler_tick", { limit: 20 });
  assert.equal(f.calls.length, 1);
  assert.equal(
    concurrent.state.work.filter((v: any) => v.status === "queued").length,
    2,
  );
  release();
  await running;
  f.controls.run = async (_ctx, args) => {
    f.calls.push(args);
    return {};
  };
  const drained = await f.op("scheduler_tick", { limit: 20 });
  assert.equal(drained.outcomes.length, 2);
  assert.equal(f.calls.length, 3);
  assert.equal(new Set(f.calls.map((v) => v.runId)).size, 3);
});

test("skip overlaps and latest missed runs are distinct durable decisions", async (t) => {
  const f = fixture(t, {
    definition: { ...binding.definition, overlap: "skip" },
  });
  await f.register();
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>((done) => (started = done)),
    blocked = new Promise<void>((done) => (release = done));
  f.controls.run = async (_ctx, args) => {
    f.calls.push(args);
    started();
    await blocked;
    return {};
  };
  const active = f.op("scheduler_tick");
  await ready;
  f.clock("2026-10-05T10:02:17Z");
  const skipped = await f.op("scheduler_tick");
  assert.equal(
    skipped.state.work.filter((v: any) => v.reason === "overlap").length,
    2,
  );
  release();
  await active;
  const latest = fixture(t, {
    definition: { ...binding.definition, missed: "latest" },
  });
  await latest.register();
  latest.clock("2026-10-05T10:02:17Z");
  const caughtUp = await latest.op("scheduler_tick", { limit: 20 });
  assert.equal(caughtUp.outcomes.length, 1);
  assert.equal(
    caughtUp.state.work.filter((v: any) => v.reason === "missed").length,
    2,
  );
  assert.equal(
    caughtUp.state.work.find((v: any) => v.status === "succeeded").at,
    "2026-10-05T10:02:17Z",
  );
});

test("failed and interrupted work keeps its claim and explicit retry reuses the same business identity", async (t) => {
  const f = fixture(t);
  await f.register();
  f.controls.run = async (_ctx, args) => {
    f.calls.push(args);
    throw new Problem("INTERRUPTED", "synthetic interruption");
  };
  const failed = await f.op("scheduler_tick");
  assert.equal(failed.state.work[0].status, "interrupted");
  f.clock("2026-10-05T10:01:17Z");
  await f.op("scheduler_tick", { limit: 20 });
  assert.equal(f.calls.length, 1);
  f.controls.run = async (_ctx, args) => {
    f.calls.push(args);
    return {};
  };
  const recovered = await f.op("scheduler_retry", {
    occurrence: failed.state.work[0].id,
    expectedDigest: failed.state.bindingDigest,
  });
  assert.equal(recovered.outcomes[0].status, "succeeded");
  assert.equal(f.calls[0].runId, f.calls[1].runId);
  assert.equal(recovered.state.work[0].attempt, 2);
  await f.op("scheduler_tick");
  assert.equal(f.calls.length, 3);
});

test("an active worker cannot be stolen; queued cancellation and pause still work with a broken current build", async (t) => {
  const f = fixture(t);
  await f.register();
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>((done) => (started = done)),
    blocked = new Promise<void>((done) => (release = done));
  f.controls.run = async (_ctx, args) => {
    f.calls.push(args);
    started();
    await blocked;
    return {};
  };
  const active = f.op("scheduler_tick");
  await ready;
  f.clock("2026-10-05T10:01:17Z");
  const queued = await f.op("scheduler_tick");
  await assert.rejects(
    f.op("scheduler_retry", {
      occurrence: queued.state.work[0].id,
      expectedDigest: queued.state.bindingDigest,
    }),
    { code: "SCHEDULE_ACTIVE" },
  );
  f.controls.binding = () => {
    throw new Problem("STALE", "synthetic changed build");
  };
  const canceled = await f.op("scheduler_cancel", {
    occurrence: queued.state.work[1].id,
    expectedDigest: queued.state.bindingDigest,
  });
  assert.equal(canceled.work[1].status, "canceled");
  const paused = await f.op("scheduler_pause", {
    expectedDigest: queued.state.bindingDigest,
  });
  assert.equal(paused.enabled, false);
  const status = await f.op("scheduler_status");
  assert.equal(status.state.enabled, false);
  release();
  await active;
});

test("changed bindings, future work and excessive missed history stop before execution or cursor advancement", async (t) => {
  const f = fixture(t);
  await f.register();
  f.actual.fingerprint = "9".repeat(64);
  await assert.rejects(f.op("scheduler_tick"), { code: "SCHEDULE_STALE" });
  assert.equal(f.calls.length, 0);
  f.actual.fingerprint = binding.fingerprint;
  f.clock("2026-10-05T09:59:00Z");
  await assert.rejects(f.op("scheduler_tick"), { code: "SCHEDULE_CLOCK" });
  f.clock("2026-10-06T10:00:17Z");
  await assert.rejects(f.op("scheduler_tick"), { code: "SCHEDULE_BACKLOG" });
  assert.equal(f.calls.length, 0);
  const before = (await f.op("scheduler_status")).state;
  assert.equal(before.cursor, "2026-10-05T10:00:17Z");
  const journal = (await openSchedulerJournal(f.root, true))!;
  try {
    journal.transaction(() => {
      const key = schedulerKey(f.actual),
        state = journal.read(key)!;
      state.work.push({
        id: "8".repeat(64),
        runId: "schedule-" + "8".repeat(64),
        at: "2026-10-05T11:00:17Z",
        status: "queued",
        attempt: 0,
      });
      journal.write(key, state);
    });
  } finally {
    journal.close();
  }
  f.clock("2026-10-05T10:00:17Z");
  await assert.rejects(f.op("scheduler_tick"), { code: "SCHEDULE_CLOCK" });
  assert.equal(f.calls.length, 0);
});

test("a changed registration retains history and cannot silently discard queued occurrences", async (t) => {
  const f = fixture(t);
  await f.register();
  f.clock("2026-10-05T10:02:17Z");
  const tick = await f.op("scheduler_tick");
  assert.equal(
    tick.state.work.filter((v: any) => v.status === "queued").length,
    2,
  );
  f.actual.fingerprint = "9".repeat(64);
  await assert.rejects(f.register(), { code: "SCHEDULE_PENDING" });
  for (const work of tick.state.work.filter((v: any) => v.status === "queued"))
    await f.op("scheduler_cancel", {
      occurrence: work.id,
      expectedDigest: tick.state.bindingDigest,
    });
  await f.register();
  const status = await f.op("scheduler_status");
  assert.equal(status.history.length, 1);
  assert.equal(status.history[0].bindingDigest, tick.state.bindingDigest);
  assert.equal(status.history[0].occurrences, 3);
  assert.equal(status.history[0].succeeded, 1);
  assert.equal(status.state.work.length, 0);
});

test("the journal stays private and refuses symbolic-link escapes before writing state", async (t) => {
  const f = fixture(t);
  await f.register();
  const { statSync, symlinkSync, mkdirSync } = await import("node:fs");
  assert.equal(
    statSync(resolve(f.root, ".ingestron/scheduler/state.sqlite")).mode & 0o777,
    0o600,
  );
  const other = fixture(t);
  mkdirSync(resolve(other.root, ".ingestron"));
  symlinkSync(
    resolve(f.root, ".ingestron/scheduler"),
    resolve(other.root, ".ingestron/scheduler"),
  );
  await assert.rejects(openSchedulerJournal(other.root, true));
  assert.equal((await f.op("scheduler_status")).state.work.length, 0);
});

test("post-execution commit contention retries only exact-token finalisation, preserving source success or failure", async (t) => {
  for (const failure of [false, true]) {
    const f = fixture(t);
    await f.register();
    let exited: Promise<void>;
    f.controls.run = async (_ctx, args) => {
      f.calls.push(args);
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN');db.prepare('SELECT value FROM registrations').all();process.stdout.write('held\\n');setTimeout(()=>{db.exec('COMMIT');db.close();},250);",
          resolve(f.root, ".ingestron/scheduler/state.sqlite"),
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      exited = new Promise<void>((done, reject) => {
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 ? done() : reject(new Error("Journal holder failed")),
        );
      });
      await new Promise<void>((done, reject) => {
        child.stdout.once("data", () => done());
        child.once("error", reject);
      });
      if (failure) throw new Problem("SOURCE", "Synthetic source failure");
      return {};
    };
    const tick = await f.op("scheduler_tick");
    await exited!;
    assert.equal(f.calls.length, 1);
    assert.equal(tick.outcomes[0].status, failure ? "failed" : "succeeded");
    assert.equal(tick.state.work[0].attempt, 1);
    const journal = (await openSchedulerJournal(f.root, false))!;
    try {
      assert.equal(journal.busy(f.actual.resources), failure);
    } finally {
      journal.close();
    }
  }
});

test("complete paged history includes archived registrations, strict flow ownership and public-only fields", async (t) => {
  const f = fixture(t);
  await f.register();
  f.clock("2026-10-05T10:02:17Z");
  await f.op("scheduler_tick", { limit: 20 });
  const journal = (await openSchedulerJournal(f.root, true))!;
  try {
    journal.transaction(() => {
      const key = schedulerKey(f.actual),
        state = journal.read(key)!;
      for (let i = 0; i < 45; i++)
        state.work.push({
          ...state.work[0]!,
          id: i.toString(16).padStart(64, "0"),
          runId: "schedule-" + i.toString(16).padStart(64, "0"),
          status: i % 2 ? "succeeded" : "failed",
          errorCode: i % 2 ? undefined : "SOURCE",
        });
      journal.archive(key, state);
      journal.archive(
        schedulerKey({ ...f.actual, flow: "another-flow" }),
        state,
      );
    });
  } finally {
    journal.close();
  }
  const first = await f.op("scheduler_history", { pageSize: 10 });
  const archived = first.generations.find((v: any) => v.id !== "current");
  assert.ok(archived);
  const all = await f.op("scheduler_history", {
    generation: archived.id,
    pageSize: 10,
  });
  assert.equal(all.total, 48);
  assert.equal(all.pages, 5);
  assert.equal(all.entries.length, 10);
  const entries = [];
  for (let page = 0; page < all.pages; page++)
    entries.push(
      ...(
        await f.op("scheduler_history", {
          generation: archived.id,
          pageSize: 10,
          page,
        })
      ).entries,
    );
  assert.equal(new Set(entries.map((v: any) => v.id)).size, 48);
  const failed = await f.op("scheduler_history", {
    generation: archived.id,
    status: "failed",
    query: "source",
  });
  assert.equal(failed.total, 23);
  assert.equal(JSON.stringify(failed).includes('"token"'), false);
  assert.equal(JSON.stringify(failed).includes('"binding"'), false);
  assert.equal(JSON.stringify(failed).includes('"workerPid"'), false);
  const other = (await openSchedulerJournal(f.root, false))!;
  const foreign = other.history(
    schedulerKey({ ...f.actual, flow: "another-flow" }),
  )[0]!.id;
  other.close();
  await assert.rejects(f.op("scheduler_history", { generation: foreign }), {
    code: "SCHEDULE_HISTORY",
  });
});
