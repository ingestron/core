import { test } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../../src/core/operations.js";
import {
  ingestionDefinitionSchema,
  type IngestionDefinition,
} from "../../src/core/ingestion-definition-schema.js";
import { portableQualityRuleSchema } from "../../src/core/portable-quality-schema.js";
import {
  validatePortableQuality,
  protectQuality,
  effectiveQuality,
  previewPortableQuality,
} from "../../src/core/portable-quality.js";
const rule = (condition: any = { kind: "not-null" }, fields = ["id"]) =>
  portableQualityRuleSchema.parse({
    apiVersion: "ingestron.quality-rule/v1",
    id: "check_id",
    name: "Check identifier",
    enabled: true,
    fields,
    condition,
    nullHandling: "fail",
    threshold: { kind: "pass-rate", value: 100 },
    severity: "error",
    failureIntent: "report-only",
    engineExtensions: { retain: "opaque" },
  });
function definition(count = 2): IngestionDefinition {
  return ingestionDefinitionSchema.parse({
    apiVersion: "ingestron.ingestion-definition/v1",
    id: "sales",
    name: "Sales",
    status: "draft",
    objects: Array.from({ length: count }, (_, i) => ({
      id: `sales.object_${i}`,
      kind: i % 2 ? "table" : "file-group",
      fields: [
        { path: "id", logicalType: "integer", origin: "declared" },
        { path: "raw.email", logicalType: "string", origin: "declared" },
        { path: "time", logicalType: "timestamp", origin: "declared" },
      ],
      mapping: [
        { source: "id", output: "id" },
        { source: "raw.email", output: "email" },
        { source: "time", output: "time" },
      ],
      metadata: [
        {
          name: "observed",
          logicalType: "timestamp",
          value: { kind: "observed-at" },
        },
      ],
    })),
  });
}
const preview = (d: IngestionDefinition, bulk?: any) => {
  const r = execute({ root: "/tmp" }, "ingestion_quality_preview", {
    definition: d,
    ...(bulk ? { bulk } : {}),
  });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  return r.result;
};
test("all nine portable conditions validate logical outputs and preserve custom attributes", () => {
  for (const [condition, fields] of [
    [{ kind: "not-null" }, ["id"]],
    [{ kind: "uniqueness" }, ["id", "email"]],
    [{ kind: "range", min: 1, max: 10 }, ["id"]],
    [{ kind: "allowed-values", values: [1, 2] }, ["id"]],
    [
      { kind: "pattern", expression: "^[A-Za-z]+$", dialect: "portable-ascii" },
      ["email"],
    ],
    [{ kind: "length", min: 1, max: 100 }, ["email"]],
    [{ kind: "freshness", maxAgeSeconds: 3600 }, ["observed"]],
    [{ kind: "row-count", min: 1, max: 1000 }, []],
    [
      {
        kind: "relationship",
        object: "sales.object_1",
        fields: ["id", "email"],
        dependency: "same-ingestion",
      },
      ["id", "email"],
    ],
  ] as [any, string[]][]) {
    const d = definition();
    d.objects[0]!.quality = [rule(condition, fields)];
    const checked = preview(d);
    assert.equal(checked.valid, true, JSON.stringify(checked.issues));
    assert.equal(checked.evaluation, "not-run");
    assert.deepEqual(d.objects[0]!.quality[0]!.engineExtensions, {
      retain: "opaque",
    });
    assert.equal(
      execute({ root: "/tmp" }, "ingestion_contract_check", { value: d }).ok,
      true,
    );
  }
});
test("invalid fields, types, thresholds, bounds, patterns and aggregate intents fail authoritatively", () => {
  const invalid = [
    rule({ kind: "range", min: 20, max: 1 }),
    rule({ kind: "range", min: 0, max: 1 }, ["email"]),
    rule({ kind: "not-null" }, ["raw.email"]),
    rule({ kind: "uniqueness" }, ["id", "id"]),
    rule({ kind: "allowed-values", values: ["wrong"] }),
    rule({ kind: "pattern", expression: "(a+)+$", dialect: "portable-ascii" }, [
      "email",
    ]),
    rule({ kind: "pattern", expression: "[", dialect: "portable-ascii" }, [
      "email",
    ]),
    rule({
      kind: "relationship",
      object: "missing",
      fields: ["id"],
      dependency: "same-ingestion",
    }),
    { ...rule(), nullHandling: "pass" },
    { ...rule(), threshold: { kind: "pass-rate", value: 101 } },
    {
      ...rule({ kind: "row-count", min: 0, max: 10 }, []),
      failureIntent: "reject-row",
    },
  ];
  for (const r of invalid) {
    const d = definition();
    d.objects[0]!.quality = [r];
    assert.equal(validatePortableQuality(d).valid, false, JSON.stringify(r));
    assert.equal(
      execute({ root: "/tmp" }, "ingestion_contract_check", { value: d }).ok,
      false,
    );
  }
  const d = definition();
  d.objects[0]!.quality = [rule()];
  d.objects[0]!.mapping[0]!.output = "renamed";
  assert.equal(preview(d).valid, false);
});
test("unknown rules round-trip with explicit unvalidated warnings and disabled rules remain", () => {
  const d = definition();
  const custom = {
    id: "legacy",
    type: "custom",
    engine: "custom-engine",
    arguments: { untouched: [1, 2] },
  };
  d.objects[0]!.quality = [custom, { ...rule(), enabled: false }];
  d.objects[0]!.qualityEnabled = false;
  const result = preview(d);
  assert.equal(result.valid, true);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(d.objects[0]!.quality[0], custom);
});
test("defaults, overrides, pinned sets and mandatory locks cannot be bypassed", () => {
  const d = definition();
  const required = {
    ...rule(),
    required: { policy: "identifiers", reason: "Identifiers are mandatory" },
  };
  d.qualityDefaults = { enabled: true, rules: [required] };
  assert.equal(preview(d).valid, true);
  let next = structuredClone(d);
  next.objects[0]!.qualityEnabled = false;
  assert.equal(preview(next).valid, false);
  assert.throws(() => protectQuality(d, next));
  next = structuredClone(d);
  next.objects[0]!.quality = [{ ...required, enabled: false }];
  assert.equal(preview(next).valid, false);
  next = structuredClone(d);
  next.qualityDefaults!.rules = [];
  assert.throws(() => protectQuality(d, next));
  const optional = definition();
  optional.qualityDefaults = { enabled: true, rules: [rule()] };
  optional.objects[0]!.quality = [{ ...rule(), enabled: false }];
  assert.equal(
    effectiveQuality(optional, optional.objects[0]!)[0]!.active,
    false,
  );
  assert.equal(preview(optional).valid, true);
  const set = {
    id: "keys",
    version: 1,
    name: "Keys",
    description: "",
    fields: [{ name: "key", logicalType: "integer" as const }],
    rules: [{ ...required, fields: ["key"] }],
  };
  const pinned = definition();
  pinned.qualityRuleSets = [set];
  pinned.objects[0]!.qualitySets = [
    { id: "keys", version: 1, fields: { key: "id" } },
  ];
  assert.equal(preview(pinned).valid, true);
  next = structuredClone(pinned);
  next.qualityRuleSets![0]!.name = "Changed";
  assert.throws(() => protectQuality(pinned, next));
  next = structuredClone(pinned);
  next.qualityRuleSets = [];
  assert.throws(() => protectQuality(pinned, next));
  next = structuredClone(pinned);
  next.objects[0]!.qualitySets = [];
  assert.throws(() => protectQuality(pinned, next));
  next = structuredClone(pinned);
  next.qualityRuleSets!.push({ ...set, version: 2 });
  protectQuality(pinned, next);
  assert.equal(next.objects[0]!.qualitySets![0]!.version, 1);
});
test("bulk freezes 1000 IDs, preserves overrides, skips incompatible types and never writes", () => {
  const d = definition(1000);
  d.objects[0]!.qualityEnabled = false;
  d.objects[1]!.fields[0]!.logicalType = "string";
  d.qualityRuleSets = [
    {
      id: "keys",
      version: 1,
      name: "Keys",
      description: "",
      fields: [{ name: "key", logicalType: "integer" }],
      rules: [rule({ kind: "not-null" }, ["key"])],
    },
  ];
  const selected = d.objects.map((o) => o.id),
    before = JSON.stringify(d);
  const result = preview(d, {
    objects: selected,
    mode: "preserve",
    setting: {
      kind: "rule-set",
      binding: { id: "keys", version: 1, fields: { key: "id" } },
    },
  });
  assert.equal(
    result.outcomes.filter((o: any) => o.status === "applied").length,
    999,
  );
  assert.equal(
    result.outcomes.filter((o: any) => o.status === "skipped").length,
    1,
  );
  assert.equal(JSON.stringify(d), before);
  const enabled = preview(d, {
    objects: selected,
    mode: "preserve",
    setting: { kind: "quality-enabled", enabled: true },
  });
  assert.equal(enabled.outcomes[0].status, "preserved");
  assert.equal(enabled.definition.objects[0].qualityEnabled, false);
  const replaced = preview(d, {
    objects: selected,
    mode: "replace",
    setting: { kind: "quality-enabled", enabled: true },
  });
  assert.equal(replaced.definition.objects[0].qualityEnabled, true);
  assert.throws(() =>
    previewPortableQuality({
      definition: d,
      bulk: {
        objects: [selected[0]!, selected[0]!],
        mode: "preserve",
        setting: { kind: "quality-enabled", enabled: true },
      },
    }),
  );
});
test("bulk preserves policy locks and reports file-only metadata and missing masking paths", () => {
  const d = definition();
  d.objects[0]!.quality = [
    { ...rule(), required: { policy: "keys", reason: "Required" } },
  ];
  const selected = d.objects.map((o) => o.id);
  const disabled = preview(d, {
    objects: selected,
    mode: "replace",
    setting: { kind: "quality-enabled", enabled: false },
  });
  assert.equal(disabled.outcomes[0].status, "skipped");
  assert.equal(disabled.outcomes[1].status, "applied");
  const metadata = preview(d, {
    objects: selected,
    mode: "replace",
    setting: {
      kind: "metadata",
      column: {
        name: "path",
        logicalType: "string",
        value: { kind: "source-path" },
      },
    },
  });
  assert.equal(metadata.outcomes[0].status, "applied");
  assert.equal(metadata.outcomes[1].status, "skipped");
  const mask = preview(d, {
    objects: selected,
    mode: "replace",
    setting: {
      kind: "masking",
      field: "missing",
      policy: "redact",
      enabled: true,
    },
  });
  assert.equal(
    mask.outcomes.every((o: any) => o.status === "skipped"),
    true,
  );
});

test("default conditions validate before object selection and even when all objects override them", () => {
  for (const count of [0, 1]) {
    const d = definition(count);
    d.qualityDefaults = {
      enabled: true,
      rules: [rule({ kind: "range", min: 20, max: 1 })],
    };
    if (d.objects[0]) d.objects[0].quality = [rule()];
    assert.equal(preview(d).valid, false);
    assert.equal(
      execute({ root: "/tmp" }, "ingestion_contract_check", { value: d }).ok,
      false,
    );
    d.qualityDefaults.rules = [
      rule({ kind: "row-count", min: 0, max: 100 }, []),
    ];
    assert.equal(preview(d).valid, true);
  }
  const d = definition(0);
  d.qualityRuleSets = [
    {
      id: "relationships",
      version: 1,
      name: "Relationships",
      description: "",
      fields: [{ name: "id", logicalType: "integer" }],
      rules: [
        rule({
          kind: "relationship",
          object: "later",
          fields: ["id", "id"],
          dependency: "same-ingestion",
        }),
      ],
    },
  ];
  assert.equal(
    preview(d).valid,
    false,
    "Unbound relationship templates still require distinct, matching composite keys",
  );
});

test("reusable-library validity is independent of an object's display identity", () => {
  const d = definition(1);
  d.objects[0]!.id = "Rule sets";
  d.objects[0]!.quality = [rule({ kind: "range", min: 10, max: 1 })];
  const report = validatePortableQuality(d);
  assert.equal(report.valid, false);
  assert.equal(report.ruleSetsValid, true);
});
