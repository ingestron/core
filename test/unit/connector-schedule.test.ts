import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, digest } from "../../src/core/errors.js";
import {
  connectorScheduleHandover,
  validateConnectorScheduleHandover,
} from "../../src/core/connector-schedule.js";
import { connectorSchedulingSchema } from "../../src/core/connector-schedule-schema.js";
import { checkProviderCompatibility } from "../../src/plugins/compatibility.js";

const owner = {
  project: "retail",
  environment: "dev",
  flow: "bronze",
  connection: "erp",
};
const capability = {
  apiVersion: "ingestron.connector-schedule/v1" as const,
  clock: "portable" as const,
  recurrences: ["interval", "daily", "weekly", "monthly"] as const,
};
const base = {
  apiVersion: "ingestron.schedule/v1" as const,
  enabled: false,
  timeZone: "Pacific/Chatham",
  start: "2026-09-26T13:30:17Z",
  end: "2027-09-26T13:30:17Z",
  recurrence: { kind: "daily" as const, times: ["09:15", "17:45"] },
  overlap: "queue" as const,
  missed: "latest" as const,
  daylightSaving: { gap: "shift-forward" as const, fold: "both" as const },
};

test("connector handovers keep complete intent, exact scope and clock resolution across all recurrences", () => {
  const definitions = [
    {
      ...base,
      timeZone: "UTC",
      daylightSaving: undefined,
      recurrence: { kind: "interval" as const, minutes: 17 },
    },
    base,
    {
      ...base,
      recurrence: {
        kind: "weekly" as const,
        weekDays: ["Monday" as const, "Friday" as const],
        times: ["09:15", "17:45"],
      },
    },
    {
      ...base,
      recurrence: {
        kind: "monthly" as const,
        monthDays: [1, 29, 31],
        times: ["09:15", "17:45"],
      },
    },
  ];
  for (const definition of definitions) {
    const handover = connectorScheduleHandover(definition, capability, owner);
    assert.equal(handover.definition.enabled, false);
    if (definition.recurrence.kind === "interval")
      assert.equal(Object.hasOwn(handover.definition, "daylightSaving"), false);
    assert.deepEqual(handover.owner, owner);
    assert.deepEqual(handover.definition.recurrence, definition.recurrence);
    assert.equal(handover.boundaries.start.instant, definition.start);
    assert.equal(handover.boundaries.end!.instant, definition.end);
    assert.equal(
      handover.boundaries.definitionDigest,
      digest(canonical(handover.definition)),
    );
    assert.deepEqual(
      validateConnectorScheduleHandover(
        handover,
        capability,
        owner,
        definition,
      ),
      handover,
    );
    assert.deepEqual(
      connectorScheduleHandover(definition, capability, owner),
      handover,
    );
  }
  const handover = connectorScheduleHandover(base, capability, owner);
  assert.equal(handover.boundaries.start.localTime, "2026-09-27T02:15:17");
  for (const key of ["project", "environment", "flow", "connection"] as const) {
    const changed = { ...owner, [key]: "another" };
    assert.notEqual(
      connectorScheduleHandover(base, capability, changed).digest,
      handover.digest,
    );
    assert.throws(
      () =>
        validateConnectorScheduleHandover(handover, capability, changed, base),
      { code: "CONNECTOR_SCHEDULE" },
    );
  }
});

test("native calendars, paused intent and partial recurrence support never imply connector capability", () => {
  for (const declaration of [
    undefined,
    {},
    { ...capability, recurrences: [] },
    { ...capability, recurrences: ["daily", "daily"] },
    { ...capability, ignored: true },
    { ...capability, clock: "invented" },
  ])
    assert.throws(() => connectorScheduleHandover(base, declaration, owner), {
      code: "SCHEDULE_UNSUPPORTED",
    });
  assert.throws(
    () =>
      connectorScheduleHandover(
        base,
        { ...capability, recurrences: ["weekly"] },
        owner,
      ),
    { code: "SCHEDULE_UNSUPPORTED" },
  );
  assert.equal(
    connectorSchedulingSchema.safeParse({
      ...capability,
      recurrences: ["daily"],
    }).success,
    true,
  );
  const native = { ...capability, clock: "platform-native" };
  assert.throws(() => connectorScheduleHandover(base, native, owner), {
    code: "SCHEDULE_POLICY",
  });
  const nativeDefinition = {
    ...base,
    daylightSaving: undefined,
    overlap: "native" as const,
    missed: "native" as const,
  };
  assert.equal(
    connectorScheduleHandover(nativeDefinition, native, owner).clock,
    "platform-native",
  );
  assert.throws(
    () => connectorScheduleHandover(nativeDefinition, capability, owner),
    { code: "SCHEDULE_POLICY" },
  );
});

test("altered or self-rehashed boundaries, removed fields and changed host clock data are refused", () => {
  const handover = connectorScheduleHandover(base, capability, owner);
  const mutations = [
    (v: any) => {
      v.boundaries.start.instant = "2026-09-26T13:30:00Z";
    },
    (v: any) => {
      v.boundaries.start.localTime = "2026-09-27T02:15:00";
    },
    (v: any) => {
      v.boundaries.clock.timeZoneData = "different";
    },
    (v: any) => {
      v.boundaries.definitionDigest = "0".repeat(64);
    },
    (v: any) => {
      delete v.boundaries.end;
    },
    (v: any) => {
      v.definition.enabled = true;
    },
    (v: any) => {
      v.clock = "platform-native";
    },
    (v: any) => {
      v.owner.environment = "test";
    },
    (v: any) => {
      v.unreviewed = true;
    },
  ];
  for (const mutate of mutations) {
    const changed: any = structuredClone(handover);
    mutate(changed);
    const { digest: _digest, ...body } = changed;
    changed.digest = digest(canonical(body));
    assert.throws(() =>
      validateConnectorScheduleHandover(changed, capability, owner, base),
    );
  }
  const fullyRebuilt = connectorScheduleHandover(
    { ...base, enabled: true },
    capability,
    owner,
  );
  assert.throws(
    () =>
      validateConnectorScheduleHandover(fullyRebuilt, capability, owner, base),
    { code: "CONNECTOR_SCHEDULE" },
  );
  assert.throws(() =>
    validateConnectorScheduleHandover(null, capability, owner, base),
  );
  assert.throws(() =>
    validateConnectorScheduleHandover(
      { ...handover, digest: "0".repeat(64) },
      capability,
      owner,
      base,
    ),
  );
});

test("connector scheduling opts into its own host feature without requiring unrelated native rendering", () => {
  const manifest = {
    connectorRuntimes: { snapshot: { scheduling: capability } },
    compatibility: {
      minimumCli: "4.2.0",
      requiredFeatures: ["connector-runtime-capabilities"],
    },
  };
  assert.throws(() => checkProviderCompatibility(manifest), {
    code: "COMPATIBILITY",
  });
  manifest.compatibility.requiredFeatures.push("connector-schedule-handover");
  assert.doesNotThrow(() => checkProviderCompatibility(manifest));
});
