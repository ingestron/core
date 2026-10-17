import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { resolveScheduleBoundaries } from "../../src/core/schedule-boundaries.js";
import { scheduleOccurrences } from "../../src/core/schedule-clock.js";
import { scheduleSchema } from "../../src/core/schedule-schema.js";
import { planProject } from "../../src/core/planner.js";
import { deliveryExports } from "../../src/core/delivery-exports.js";
import { verifyPlan } from "../../src/core/generate.js";
import { generateProvider } from "../../src/plugins/generation.js";
import { canonical, digest } from "../../src/core/errors.js";
import { fixture } from "../support/project.js";
const base = {
  apiVersion: "ingestron.schedule/v1" as const,
  enabled: false,
  timeZone: "UTC",
  start: "2026-10-05T00:00:17Z",
  recurrence: { kind: "daily" as const, times: ["09:15", "17:45"] },
  overlap: "native" as const,
  missed: "native" as const,
};
const setup = (t: any) => {
  const f = fixture(t);
  const file = "fixture-origin/plugin/provider.yaml";
  const manifest = parse(readFileSync(resolve(f.root, file), "utf8"));
  manifest.compatibility.requiredFeatures = [
    "flow-schedules",
    "resolved-schedule-boundaries",
    "delivery-exports",
  ];
  manifest.capabilities = {
    schedules: ["interval", "daily", "weekly", "monthly"],
    artifactKinds: ["native-notebook"],
    delivery: true,
    handovers: [],
    packContracts: {},
  };
  f.put(file, manifest);
  // A local synthetic fixture avoids mutating an immutable installed package.
  f.project.providers.packages.dbx.source = "./" + file;
  f.put("project.yaml", f.project);
  return f;
};

test("UTC and non-UTC bounds preserve seconds, independent end offsets and reviewed identity", () => {
  const utc = resolveScheduleBoundaries(base);
  assert.deepEqual(utc.start, {
    instant: base.start,
    localTime: "2026-10-05T00:00:17",
    offset: "+00:00",
    ambiguous: false,
    possibleInstants: [{ instant: base.start, offset: "+00:00" }],
  });
  assert.equal(Object.hasOwn(utc, "end"), false);
  const schedule = {
    ...base,
    timeZone: "Pacific/Auckland",
    start: "2026-09-26T13:30:17Z",
    end: "2026-09-26T14:30:17Z",
  };
  const resolved = resolveScheduleBoundaries(schedule);
  assert.equal(resolved.start.localTime, "2026-09-27T01:30:17");
  assert.equal(resolved.start.offset, "+12:00");
  assert.equal(resolved.end!.localTime, "2026-09-27T03:30:17");
  assert.equal(resolved.end!.offset, "+13:00");
  assert.equal(
    resolved.definitionDigest,
    digest(canonical(scheduleSchema.parse(schedule))),
  );
  assert.deepEqual(resolved, resolveScheduleBoundaries(schedule));
  assert.deepEqual(
    resolved.clock,
    scheduleOccurrences({
      schedule: { ...base, missed: "skip" },
      from: base.start,
      to: "2026-10-06T00:00:00Z",
    }).clock,
  );
});

test("both New York fold instants retain their own offset and the complete ambiguity", () => {
  const possibilities = [
    { instant: "2026-11-01T05:30:17Z", offset: "-04:00" },
    { instant: "2026-11-01T06:30:17Z", offset: "-05:00" },
  ];
  for (const selected of possibilities) {
    const result = resolveScheduleBoundaries({
      ...base,
      timeZone: "US/Eastern",
      start: selected.instant,
    });
    assert.equal(result.timeZone, "US/Eastern");
    assert.equal(result.start.localTime, "2026-11-01T01:30:17");
    assert.equal(result.start.instant, selected.instant);
    assert.equal(result.start.offset, selected.offset);
    assert.equal(result.start.ambiguous, true);
    assert.deepEqual(result.start.possibleInstants, possibilities);
  }
});

test("half-hour folds, quarter-hour offsets and skipped dates are resolved from exact instants", () => {
  const lordHowe = resolveScheduleBoundaries({
    ...base,
    timeZone: "Australia/Lord_Howe",
    start: "2026-04-04T15:15:00Z",
  });
  assert.equal(lordHowe.start.localTime, "2026-04-05T01:45:00");
  assert.deepEqual(lordHowe.start.possibleInstants, [
    { instant: "2026-04-04T14:45:00Z", offset: "+11:00" },
    { instant: "2026-04-04T15:15:00Z", offset: "+10:30" },
  ]);
  const chatham = resolveScheduleBoundaries({
    ...base,
    timeZone: "Pacific/Chatham",
  });
  assert.equal(chatham.start.localTime, "2026-10-05T13:45:17");
  assert.equal(chatham.start.offset, "+13:45");
  assert.equal(chatham.start.ambiguous, false);
  const apia = resolveScheduleBoundaries({
    ...base,
    timeZone: "Pacific/Apia",
    start: "2011-12-30T09:59:59Z",
    end: "2011-12-30T10:00:00Z",
  });
  assert.equal(apia.start.localTime, "2011-12-29T23:59:59");
  assert.equal(apia.end!.localTime, "2011-12-31T00:00:00");
  assert.equal(apia.start.ambiguous, false);
  assert.equal(apia.end!.ambiguous, false);
});

test("an ambiguous end preserves forward UTC order when local time goes backwards", () => {
  const result = resolveScheduleBoundaries({
    ...base,
    timeZone: "America/New_York",
    start: "2026-11-01T05:59:59Z",
    end: "2026-11-01T06:00:00Z",
  });
  assert.equal(result.start.localTime, "2026-11-01T01:59:59");
  assert.equal(result.end!.localTime, "2026-11-01T01:00:00");
  assert.equal(result.end!.instant, "2026-11-01T06:00:00Z");
  assert.equal(result.end!.offset, "-05:00");
  assert.equal(result.end!.ambiguous, true);
});

test("malformed bounds are refused rather than repaired or silently dropped", () => {
  for (const change of [
    { start: "2026-02-30T00:00:00Z" },
    { end: base.start },
    { timeZone: "not/a-zone" },
    { start: "2026-10-05T01:00:00+01:00" },
  ])
    assert.throws(() => resolveScheduleBoundaries({ ...base, ...change }));
});

test("selected scheduled flows have digest-bound metadata; manual plans retain their original shape", (t) => {
  const f = setup(t);
  assert.equal(Object.hasOwn(planProject(f.root), "scheduleBoundaries"), false);
  f.flow.schedule = { ...base, timeZone: "Pacific/Chatham" };
  f.put("flows/source/flow.yaml", f.flow);
  const plan = planProject(f.root);
  assert.deepEqual(plan.scheduleBoundaries, {
    source: resolveScheduleBoundaries(f.flow.schedule),
  });
  const { digest: identity, ...body } = plan;
  assert.equal(identity, digest(canonical(body)));
  const changed = structuredClone(body);
  changed.scheduleBoundaries!.source.clock.timeZoneData =
    "different-review-clock";
  assert.notEqual(identity, digest(canonical(changed)));
  const selected = planProject(f.root, "dev", {
    flow: "source",
    table: "orders",
  });
  assert.equal(selected.scheduleBoundaries!.source.start.instant, base.start);
  assert.deepEqual(plan, planProject(f.root));
});

test("delivery partitions retain only their own boundaries and hash the filtered values", (t) => {
  const f = setup(t);
  f.flow.schedule = base;
  f.put("flows/source/flow.yaml", f.flow);
  const plan = planProject(f.root);
  const second = {
    ...structuredClone(plan.flows[0]!),
    id: "second",
    schedule: scheduleSchema.parse({ ...base, timeZone: "Pacific/Chatham" }),
  };
  plan.flows.push(second);
  plan.scheduleBoundaries!.second = resolveScheduleBoundaries(second.schedule!);
  plan.nodes.push(
    ...plan.nodes.map((node) => ({
      ...structuredClone(node),
      id: "second/" + node.id,
      flow: "second",
      needs: [],
    })),
  );
  const parts = deliveryExports(plan);
  assert.equal(parts.length, 2);
  for (const part of parts) {
    const own = part.plan.flows[0]!.id;
    assert.deepEqual(Object.keys(part.plan.scheduleBoundaries!), [own]);
    assert.deepEqual(
      part.plan.scheduleBoundaries![own],
      plan.scheduleBoundaries![own],
    );
    const { digest: identity, ...body } = part.plan;
    assert.equal(identity, digest(canonical(body)));
  }
  delete plan.flows.find((flow) => flow.id === "second")!.schedule;
  delete plan.scheduleBoundaries!.second;
  assert.equal(
    Object.hasOwn(
      deliveryExports(plan).find((part) => part.plan.flows[0]!.id === "second")!
        .plan,
      "scheduleBoundaries",
    ),
    false,
  );
});

test("providers receive the reviewed metadata through the sandbox without a time-zone runtime", (t) => {
  const f = setup(t);
  f.flow.schedule = {
    ...base,
    timeZone: "US/Eastern",
    start: "2026-11-01T06:30:17Z",
  };
  f.put("flows/source/flow.yaml", f.flow);
  const plan = planProject(f.root);
  const code = `export function validate(){} export function render(plan){return {"schedule-boundaries.json":{format:"json",value:plan.scheduleBoundaries}}}`;
  const ref = digest(code);
  plan.activitySources[ref] = code;
  for (const node of plan.nodes) node.runtime!.rendererRef = ref;
  const files = generateProvider(f.root, plan);
  assert.deepEqual(
    JSON.parse(files["schedule-boundaries.json"]!),
    plan.scheduleBoundaries,
  );
});

test("saved plan generation refuses changed clock data, shifted or missing boundaries and foreign flow entries even with a new digest", (t) => {
  const f = setup(t);
  f.flow.schedule = { ...base, timeZone: "Pacific/Auckland" };
  f.put("flows/source/flow.yaml", f.flow);
  const plan = planProject(f.root);
  assert.doesNotThrow(() => verifyPlan(f.root, plan));
  for (const mutate of [
    (value: typeof plan) => {
      value.scheduleBoundaries!.source.clock.timeZoneData = "changed-clock";
    },
    (value: typeof plan) => {
      value.scheduleBoundaries!.source.start.localTime = "2026-10-05T00:00:17";
    },
    (value: typeof plan) => {
      delete value.scheduleBoundaries;
    },
    (value: typeof plan) => {
      value.scheduleBoundaries!.foreign = structuredClone(
        value.scheduleBoundaries!.source,
      );
    },
  ]) {
    const value = structuredClone(plan);
    mutate(value);
    const { digest: _identity, ...body } = value;
    value.digest = digest(canonical(body));
    assert.throws(
      () => verifyPlan(f.root, value),
      (error: any) => error.code === "SCHEDULE_BOUNDARIES",
    );
  }
  delete f.flow.schedule;
  f.put("flows/source/flow.yaml", f.flow);
  assert.doesNotThrow(() => verifyPlan(f.root, planProject(f.root)));
});
