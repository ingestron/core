import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import { scheduleSchema } from "../../src/core/schedule-schema.js";
import { execute } from "../../src/core/operations.js";
import { planProject } from "../../src/core/planner.js";
import { fixture } from "../support/project.js";
const schedule = {
  apiVersion: "ingestron.schedule/v1",
  enabled: false,
  timeZone: "UTC",
  start: "2026-10-05T00:00:00Z",
  recurrence: { kind: "daily", times: ["09:15", "17:45"] },
};
test("schedules validate real UTC boundaries and explicit calendar selections", () => {
  for (const recurrence of [
    { kind: "interval", minutes: 15 },
    { kind: "daily", times: ["09:00"] },
    {
      kind: "weekly",
      weekDays: ["Monday", "Friday"],
      times: ["09:00", "17:30"],
    },
    { kind: "monthly", monthDays: [1, 31], times: ["09:00"] },
  ])
    assert.ok(scheduleSchema.safeParse({ ...schedule, recurrence }).success);
  for (const change of [
    { start: "2026-02-30T00:00:00Z" },
    { end: schedule.start },
    { timeZone: "not/a-zone" },
    { recurrence: { kind: "daily", times: ["24:00"] } },
    { recurrence: { kind: "daily", times: ["09:00", "09:00"] } },
    {
      recurrence: {
        kind: "weekly",
        weekDays: ["Monday", "Monday"],
        times: ["09:00"],
      },
    },
    { recurrence: { kind: "monthly", monthDays: [0], times: ["09:00"] } },
    { recurrence: { kind: "interval", minutes: 1.5 } },
    { recurrence: { kind: "interval", minutes: 0 } },
    {
      recurrence: { kind: "interval", minutes: 15 },
      timeZone: "Pacific/Auckland",
    },
    { recurrence: { kind: "daily", times: ["09:00"], cron: "* * * * *" } },
  ])
    assert.equal(
      scheduleSchema.safeParse({ ...schedule, ...change }).success,
      false,
      JSON.stringify(change),
    );
  assert.ok(
    scheduleSchema.safeParse({ ...schedule, timeZone: "Pacific/Auckland" })
      .success,
  );
});
test("reviewed schedule edits preserve comments and persist after reopening; stale or read-only apply is denied", (t) => {
  const { root } = fixture(t),
    file = resolve(root, "flows/source/flow.yaml");
  writeFileSync(
    file,
    "# Keep engineering notes\n" + readFileSync(file, "utf8"),
  );
  const context = { root, environment: "dev", allowWrite: true };
  const checked = execute(context, "schedule_check", { schedule });
  assert.equal(checked.ok, true);
  assert.equal(checked.result.executionEnabled, false);
  const proposed = execute(context, "schedule_propose", {
    flow: "source",
    schedule,
  });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  assert.equal(parse(readFileSync(file, "utf8")).schedule, undefined);
  assert.equal(
    execute({ ...context, allowWrite: false }, "apply", {
      proposal: proposed.result,
    }).diagnostics[0].code,
    "PERMISSION",
  );
  assert.equal(
    execute(context, "apply", { proposal: proposed.result }).ok,
    true,
  );
  assert.match(readFileSync(file, "utf8"), /^# Keep engineering notes/);
  const reopened = execute({ root }, "schedule_inspect", { flow: "source" });
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  assert.deepEqual(reopened.result.schedule, checked.result.schedule);
  const pending = execute(context, "schedule_propose", {
    flow: "source",
    schedule: { ...schedule, enabled: true },
  });
  assert.equal(pending.ok, true);
  writeFileSync(file, readFileSync(file, "utf8") + "# external edit\n");
  assert.equal(
    execute(context, "apply", { proposal: pending.result }).diagnostics[0].code,
    "STALE",
  );
  const remove = execute(context, "schedule_propose", {
    flow: "source",
    schedule: null,
  });
  assert.equal(remove.ok, true);
  assert.equal(execute(context, "apply", { proposal: remove.result }).ok, true);
  assert.equal(
    execute(context, "schedule_inspect", { flow: "source" }).result.schedule,
    null,
  );
});
test("schedule authoring supports inline flow locations without rewriting unrelated project fields", (t) => {
  const { root, project, flow } = fixture(t);
  for (const [name, table] of Object.entries(flow.tables) as [string, any][]) {
    table.contract = { $resolve: `./flows/source/contracts/${name}.yaml` };
  }
  project.flows = [flow];
  writeFileSync(
    resolve(root, "project.yaml"),
    "# Project notes\n" + stringify(project),
  );
  const proposed = execute({ root }, "schedule_propose", {
    flow: "source",
    schedule,
  });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  assert.equal(proposed.result.changes[0].path, "project.yaml");
  assert.equal(
    execute({ root, allowWrite: true }, "apply", { proposal: proposed.result })
      .ok,
    true,
  );
  assert.match(
    readFileSync(resolve(root, "project.yaml"), "utf8"),
    /^# Project notes/,
  );
  const saved = parse(readFileSync(resolve(root, "project.yaml"), "utf8"));
  assert.deepEqual(saved.flows[0].tables, flow.tables);
  assert.equal(saved.flows[0].schedule.enabled, false);
});
test("providers without schedule capability fail closed for scheduled generation even when paused", (t) => {
  const { root, flow, put } = fixture(t);
  flow.schedule = schedule;
  put("flows/source/flow.yaml", flow);
  assert.throws(
    () => planProject(root, "dev"),
    (error: any) => error.code === "SCHEDULE_UNSUPPORTED",
  );
});

test("schedule-capable providers declare the host ABI and older hosts reject unknown features", async () => {
  const { checkProviderCompatibility, checkPluginCompatibility } =
    await import("../../src/plugins/compatibility.js");
  const manifest = (schedules: string[], requiredFeatures: string[]) => ({
    compatibility: { minimumCli: "4.2.0", requiredFeatures },
    capabilities: {
      schedules,
      artifactKinds: [],
      delivery: false,
      handovers: [],
      packContracts: {},
    },
  });
  assert.throws(
    () => checkProviderCompatibility(manifest(["daily"], [])),
    /flow-schedules/,
  );
  assert.doesNotThrow(() =>
    checkProviderCompatibility(manifest(["daily"], ["flow-schedules"])),
  );
  assert.doesNotThrow(() => checkProviderCompatibility(manifest([], [])));
  assert.throws(
    () => checkPluginCompatibility(undefined, ["future-schedule-execution"]),
    /Unsupported provider host feature/,
  );
});

test("native scheduling policies are explicit and never replace portable defaults", () => {
  const ordinary = scheduleSchema.parse(schedule);
  assert.equal(ordinary.overlap, "skip");
  assert.equal(ordinary.missed, "skip");
  for (const overlap of ["skip", "queue", "native"])
    for (const missed of ["skip", "latest", "native"])
      assert.deepEqual(scheduleSchema.parse({ ...schedule, overlap, missed }), {
        ...schedule,
        overlap,
        missed,
      });
  assert.equal(
    scheduleSchema.safeParse({ ...schedule, overlap: "ignore" }).success,
    false,
  );
  assert.equal(
    scheduleSchema.safeParse({ ...schedule, missed: "catch-up-all" }).success,
    false,
  );
  assert.equal(
    scheduleSchema.parse({ ...schedule, timeZone: "US/Eastern" }).timeZone,
    "US/Eastern",
  );
});
