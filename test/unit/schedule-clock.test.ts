import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleOccurrences } from "../../src/core/schedule-clock.js";
import { scheduleSchema } from "../../src/core/schedule-schema.js";
import { execute } from "../../src/core/operations.js";
const base = {
  apiVersion: "ingestron.schedule/v1" as const,
  enabled: false,
  timeZone: "UTC",
  start: "2026-01-01T00:00:00Z",
  recurrence: { kind: "daily" as const, times: ["09:15", "17:45"] },
};
const policy = { gap: "skip" as const, fold: "both" as const };
const preview = (schedule: any, from: string, to: string, limit = 1000) =>
  scheduleOccurrences({ schedule, from, to, limit });
const at = (result: ReturnType<typeof preview>) =>
  result.occurrences.map((item) => item.at);

test("intervals retain their exact start-second phase and exclusive end; paused intent does not execute", () => {
  const schedule = {
    ...base,
    start: "2026-10-05T00:00:17Z",
    end: "2026-10-05T01:00:17Z",
    recurrence: { kind: "interval", minutes: 15 },
  };
  const result = preview(
    schedule,
    "2026-10-05T00:15:18Z",
    "2026-10-06T00:00:00Z",
  );
  assert.deepEqual(at(result), [
    "2026-10-05T00:30:17Z",
    "2026-10-05T00:45:17Z",
  ]);
  assert.equal(result.enabled, false);
  assert.equal(result.executionEnabled, false);
  assert.deepEqual(
    at(preview(schedule, schedule.start, schedule.end))[0],
    schedule.start,
  );
});
test("calendar slots stay paired, ordered and bounded instead of producing a Cartesian product", () => {
  const result = preview(
    { ...base, recurrence: { kind: "daily", times: ["17:45", "09:15"] } },
    "2026-10-05T09:15:00Z",
    "2026-10-06T09:15:00Z",
  );
  assert.deepEqual(at(result), [
    "2026-10-05T09:15:00Z",
    "2026-10-05T17:45:00Z",
  ]);
  assert.equal(new Set(result.occurrences.map((item) => item.id)).size, 2);
});
test("weekly selections use the local weekday with quarter-hour offsets", () => {
  assert.deepEqual(
    at(
      preview(
        {
          ...base,
          timeZone: "Pacific/Chatham",
          recurrence: {
            kind: "weekly",
            weekDays: ["Monday"],
            times: ["09:15"],
          },
        },
        "2026-10-04T00:00:00Z",
        "2026-10-06T00:00:00Z",
      ),
    ),
    ["2026-10-04T19:30:00Z"],
  );
});
test("monthly dates skip missing days and include leap day without rolling into another month", () => {
  const schedule = {
    ...base,
    start: "2024-01-01T00:00:00Z",
    recurrence: { kind: "monthly", monthDays: [31, 29], times: ["09:15"] },
  };
  assert.deepEqual(
    at(preview(schedule, "2024-02-01T00:00:00Z", "2024-03-02T00:00:00Z")),
    ["2024-02-29T09:15:00Z"],
  );
  assert.deepEqual(
    at(preview(schedule, "2025-02-01T00:00:00Z", "2025-03-02T00:00:00Z")),
    [],
  );
});
test("spring gaps require review and support skip or exact forward shift", () => {
  for (const [zone, slot, from, to, expected, local] of [
    [
      "America/New_York",
      "02:30",
      "2026-03-08T00:00:00Z",
      "2026-03-09T00:00:00Z",
      "2026-03-08T07:30:00Z",
      "2026-03-08T03:30:00",
    ],
    [
      "Pacific/Auckland",
      "02:30",
      "2026-09-26T12:00:00Z",
      "2026-09-27T12:00:00Z",
      "2026-09-26T14:30:00Z",
      "2026-09-27T03:30:00",
    ],
    [
      "Australia/Lord_Howe",
      "02:15",
      "2026-10-03T14:00:00Z",
      "2026-10-04T14:00:00Z",
      "2026-10-03T15:45:00Z",
      "2026-10-04T02:45:00",
    ],
  ]) {
    const schedule = {
      ...base,
      timeZone: zone,
      recurrence: { kind: "daily", times: [slot] },
    };
    assert.throws(
      () => preview(schedule, from!, to!),
      (error: any) => error.code === "SCHEDULE_DST_REVIEW",
    );
    const skipped = preview(
      { ...schedule, daylightSaving: policy },
      from!,
      to!,
    );
    assert.deepEqual(at(skipped), []);
    assert.equal(skipped.skipped.length, 1);
    const shifted = preview(
      { ...schedule, daylightSaving: { ...policy, gap: "shift-forward" } },
      from!,
      to!,
    );
    assert.deepEqual(at(shifted), [expected]);
    assert.equal(shifted.occurrences[0]!.localTime, local);
    assert.equal(shifted.occurrences[0]!.resolution, "shift-forward");
  }
});
test("repeated wall times resolve to earlier, later or both exact instants including half-hour folds", () => {
  for (const [zone, slot, from, to, earlier, later] of [
    [
      "US/Eastern",
      "01:30",
      "2026-11-01T00:00:00Z",
      "2026-11-02T00:00:00Z",
      "2026-11-01T05:30:00Z",
      "2026-11-01T06:30:00Z",
    ],
    [
      "Pacific/Auckland",
      "02:30",
      "2026-04-04T12:00:00Z",
      "2026-04-05T12:00:00Z",
      "2026-04-04T13:30:00Z",
      "2026-04-04T14:30:00Z",
    ],
    [
      "Australia/Lord_Howe",
      "01:45",
      "2026-04-04T13:00:00Z",
      "2026-04-05T13:00:00Z",
      "2026-04-04T14:45:00Z",
      "2026-04-04T15:15:00Z",
    ],
  ]) {
    const schedule = {
      ...base,
      timeZone: zone,
      recurrence: { kind: "daily", times: [slot] },
    };
    assert.throws(
      () => preview(schedule, from!, to!),
      (error: any) => error.code === "SCHEDULE_DST_REVIEW",
    );
    for (const fold of ["earlier", "later", "both"]) {
      const result = preview(
        { ...schedule, daylightSaving: { ...policy, fold } },
        from!,
        to!,
      );
      assert.deepEqual(
        at(result),
        fold === "both"
          ? [earlier, later]
          : [fold === "earlier" ? earlier : later],
      );
      assert.equal(result.timeZone, zone);
    }
  }
});
test("a skipped whole calendar date shifts once and merges colliding slots into one occurrence", () => {
  const result = preview(
    {
      ...base,
      start: "2011-12-29T00:00:00Z",
      timeZone: "Pacific/Apia",
      recurrence: { kind: "daily", times: ["12:00"] },
      daylightSaving: { gap: "shift-forward", fold: "both" },
    },
    "2011-12-30T10:00:00Z",
    "2011-12-31T10:00:00Z",
  );
  assert.deepEqual(at(result), ["2011-12-30T22:00:00Z"]);
  assert.deepEqual(result.occurrences[0]!.requestedSlots, [
    "2011-12-30T12:00:00",
    "2011-12-31T12:00:00",
  ]);
});
test("boundary filtering cannot replace the reviewed fold with the other fold", () => {
  const schedule = {
    ...base,
    timeZone: "America/New_York",
    start: "2026-11-01T06:00:00Z",
    recurrence: { kind: "daily", times: ["01:30"] },
  };
  const range = ["2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z"] as const;
  assert.deepEqual(
    at(
      preview(
        { ...schedule, daylightSaving: { ...policy, fold: "earlier" } },
        ...range,
      ),
    ),
    [],
  );
  assert.deepEqual(
    at(
      preview(
        { ...schedule, daylightSaving: { ...policy, fold: "both" } },
        ...range,
      ),
    ),
    ["2026-11-01T06:30:00Z"],
  );
});
test("occurrence IDs are deterministic and change with a schedule edit; pagination signals more results", () => {
  const args = {
    schedule: base,
    from: "2026-10-05T00:00:00Z",
    to: "2026-10-08T00:00:00Z",
    limit: 2,
  };
  const result = scheduleOccurrences(args);
  assert.equal(result.truncated, true);
  assert.equal(result.occurrences.length, 2);
  assert.deepEqual(scheduleOccurrences(args), result);
  assert.notEqual(
    scheduleOccurrences({ ...args, schedule: { ...base, enabled: true } })
      .occurrences[0]!.id,
    result.occurrences[0]!.id,
  );
  const interval = preview(
    { ...base, recurrence: { kind: "interval", minutes: 1 } },
    args.from,
    args.to,
    2,
  );
  assert.equal(interval.truncated, true);
  assert.equal(interval.occurrences.length, 2);
});
test("preview operations remain read-only and reject native clock promises and unbounded requests", () => {
  const context = {
    root: "/tmp",
    allowWrite: false,
    allowNetwork: false,
    allowExecute: false,
  };
  const args = {
    schedule: base,
    from: "2026-10-05T00:00:00Z",
    to: "2026-10-06T00:00:00Z",
  };
  const result = execute(context, "schedule_occurrences", args);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.executionEnabled, false);
  assert.equal(
    execute(context, "schedule_occurrences", {
      ...args,
      schedule: { ...base, missed: "native" },
    }).diagnostics[0]!.code,
    "SCHEDULE_NATIVE_CLOCK",
  );
  for (const change of [
    { to: args.from },
    { to: "2028-01-01T00:00:00Z" },
    { limit: 0 },
    { limit: 1001 },
    { from: "2026-02-30T00:00:00Z" },
    { execute: true },
  ])
    assert.equal(
      execute(context, "schedule_occurrences", { ...args, ...change })
        .diagnostics[0]!.code,
      "SCHEMA",
    );
  assert.equal(
    scheduleSchema.safeParse({
      ...base,
      missed: "native",
      daylightSaving: policy,
    }).success,
    false,
  );
  assert.equal(
    scheduleSchema.safeParse({
      ...base,
      recurrence: { kind: "interval", minutes: 1 },
      daylightSaving: policy,
    }).success,
    false,
  );
});
