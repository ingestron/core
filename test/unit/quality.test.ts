import assert from "node:assert/strict";
import { test } from "node:test";
import { contractColumns } from "../../src/core/contracts.js";
import { checkProviderCompatibility } from "../../src/plugins/compatibility.js";
import { connectorPackageSchema } from "../../src/core/connector-package.js";
import {
  checkCoverage,
  combineQuality,
  contractRules,
  coverageSummary,
  flowCoverage,
  qualityDeclarationSchema,
  standardQuality,
} from "../../src/core/quality.js";

const contract = (properties: any[], quality?: any[]) => ({
  apiVersion: "v3.1.0",
  kind: "DataContract",
  id: "orders",
  version: "1.0.0",
  status: "draft",
  schema: [
    {
      name: "orders",
      logicalType: "object",
      physicalType: "table",
      properties,
      ...(quality ? { quality } : {}),
    },
  ],
});
const id = {
  name: "order_id",
  logicalType: "integer",
  physicalType: "BIGINT",
  primaryKey: true,
};
const status = {
  name: "status",
  logicalType: "string",
  physicalType: "STRING",
  quality: [
    {
      id: "status-valid",
      metric: "invalidValues",
      arguments: { validValues: ["open", "closed"] },
      mustBe: 0,
      severity: "error",
    },
  ],
};

test("library rules are parsed with outcome from severity; keys imply rules", () => {
  const rules = contractRules(
    contract([id, status], [{ metric: "rowCount", mustBeGreaterThan: 0 }]),
  );
  const byId = Object.fromEntries(rules.map((r) => [r.id, r]));
  assert.equal(byId["status-valid"].outcome, "fail");
  assert.equal(byId["status-valid"].operator, "mustBe");
  assert.equal(byId["orders.rowCount"].outcome, "warn");
  assert.equal(byId["orders.order_id.key-not-null"].source, "primary-key");
  assert.deepEqual(byId["orders.key-unique"].arguments, {
    properties: ["order_id"],
  });
});

test("an explicit rule replaces the implied key rule", () => {
  const rules = contractRules(
    contract([{ ...id, quality: [{ metric: "nullValues", mustBe: 0 }] }]),
  );
  assert.equal(rules.filter((r) => r.metric === "nullValues").length, 1);
  assert.equal(
    rules.find((r) => r.metric === "nullValues")!.source,
    "contract",
  );
});

test("malformed rules are rejected when the contract loads", () => {
  for (const rule of [
    { metric: "freshness", mustBe: 0 },
    { metric: "invalidValues", mustBe: 0 },
    { metric: "nullValues" },
    { metric: "nullValues", mustBe: 0, mustBeLessThan: 1 },
    { type: "sql", mustBe: 0 },
    { type: "custom" },
  ])
    assert.throws(
      () => contractColumns(contract([{ ...status, quality: [rule] }])),
      /QUALITY|quality|metric|comparison|query|engine|validValues/i,
    );
});

test("coverage maps rules to provider modes and blocks unenforceable errors", () => {
  const flow = {
    id: "ingest",
    tables: { orders: { contract: contract([id, status]) } },
  };
  const none = flowCoverage(flow, {
    configuration: "local",
    platform: "local",
  });
  assert.ok(none.every((e) => e.mode === "unsupported"));
  assert.throws(() => checkCoverage(none), /status-valid/);
  assert.doesNotThrow(() => checkCoverage(none, "report"));
  const declared = flowCoverage(flow, {
    configuration: "dbx",
    platform: "databricks",
    quality: {
      library: { invalidValues: "at-load", nullValues: "at-load" },
      sql: "unsupported",
      engines: [],
    },
  });
  assert.doesNotThrow(() => checkCoverage(declared));
  assert.deepEqual(coverageSummary(declared), {
    rules: 3,
    atLoad: 2,
    afterLoad: 0,
    unsupported: 1,
    documentation: 0,
  });
});

test("implied key rules are reported but never block", () => {
  const flow = {
    id: "ingest",
    tables: { orders: { contract: contract([id]) } },
  };
  assert.doesNotThrow(() =>
    checkCoverage(
      flowCoverage(flow, { configuration: "l", platform: "local" }),
    ),
  );
});

test("providers declaring quality must require the host feature", () => {
  assert.throws(
    () =>
      checkProviderCompatibility({
        compatibility: { minimumCli: "4.2.0", requiredFeatures: [] },
        quality: { library: {} },
      }),
    /quality-capabilities/,
  );
  assert.doesNotThrow(() =>
    checkProviderCompatibility({
      compatibility: {
        minimumCli: "4.2.0",
        requiredFeatures: ["quality-capabilities"],
      },
      quality: { library: {} },
    }),
  );
});

test("connector runtime checks combine with the target, earliest mode first", () => {
  const connector = {
    library: { duplicateValues: "at-load", nullValues: "at-load" },
    sql: "unsupported",
    engines: [],
  } as const;
  const target = {
    library: { nullValues: "after-load", rowCount: "after-load" },
    sql: "after-load",
    engines: ["dqx"],
  } as const;
  assert.deepEqual(combineQuality(connector, target), {
    library: {
      nullValues: "at-load",
      duplicateValues: "at-load",
      rowCount: "after-load",
    },
    sql: "after-load",
    engines: ["dqx"],
  });
  assert.equal(combineQuality(undefined, target), target);
  assert.equal(combineQuality(), undefined);
  const flow = {
    id: "ingest",
    tables: { orders: { contract: contract([id, status]) } },
  };
  const entries = flowCoverage(flow, {
    configuration: "local",
    platform: "local",
    quality: combineQuality({
      ...connector,
      library: { invalidValues: "at-load" },
    }),
  });
  assert.doesNotThrow(() => checkCoverage(entries));
});

test("connector manifests may declare runtime quality support", () => {
  const manifest = {
    apiVersion: "ingestron.connector/v1",
    id: "files",
    version: "1.3.0",
    description: "Files",
    connector: "singer:files@23.0.1",
    documentation: "https://example.com/files",
    upstream: {
      ecosystem: "singer",
      variant: "ingestron",
      package: "pyarrow",
      version: "23.0.1",
      repository: "https://example.com/arrow",
      licence: "Apache-2.0",
      licenceFile: "LICENSE",
      licenceStatus: "evidenced",
    },
    runtime: { contract: "c", path: "runtime.json", sha256: "a".repeat(64) },
    definition: { settingsSchema: {}, selectionSchema: {} },
    execution: { local: { modes: ["local"], evidence: "synthetic" } },
  };
  const parsed = connectorPackageSchema.parse({
    ...manifest,
    quality: { library: { rowCount: "at-load" } },
  });
  assert.deepEqual(parsed.quality, {
    library: { rowCount: "at-load" },
    sql: "unsupported",
    engines: [],
  });
  assert.throws(() =>
    connectorPackageSchema.parse({
      ...manifest,
      quality: { library: { freshness: "at-load" } },
    }),
  );
});

test("a provider may declare quality per ingestion standard", () => {
  const declared = qualityDeclarationSchema.parse({
    library: { nullValues: "at-load" },
    standards: {
      "snapshot-with-history@v1": {
        library: { nullValues: "at-load", rowCount: "at-load" },
      },
      "immutable-file-copy@v1": {},
    },
  });
  assert.deepEqual(standardQuality(declared, "snapshot-with-history@v1"), {
    library: { nullValues: "at-load", rowCount: "at-load" },
    sql: "unsupported",
    engines: [],
  });
  assert.deepEqual(
    standardQuality(declared, "immutable-file-copy@v1")!.library,
    {},
  );
  assert.deepEqual(standardQuality(declared, "append-only@v1")!.library, {
    nullValues: "at-load",
  });
  assert.deepEqual(standardQuality(declared, undefined)!.library, {
    nullValues: "at-load",
  });
  assert.equal(standardQuality(undefined, "append-only@v1"), undefined);
  assert.throws(() =>
    qualityDeclarationSchema.parse({ standards: { "Bad Standard": {} } }),
  );
});
