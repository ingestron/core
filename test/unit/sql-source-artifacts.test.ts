import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateProvider,
  validateProviderPlan,
} from "../../src/plugins/generation.js";
import { checkProviderCompatibility } from "../../src/plugins/compatibility.js";
import { digest } from "../../src/core/errors.js";
import {
  flowCoverage,
  checkCoverage,
  qualityDeclarationSchema,
} from "../../src/core/quality.js";

test("provider generation receives exact planned SQL text with published typed output, without executing source", (t) => {
  const root = mkdtempSync(join(tmpdir(), "core-sql-artifact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const text = "SELECT id FROM source; -- SQL is evidence, never executed\n";
  writeFileSync(join(root, "logic.sql"), text);
  const contract = {
    apiVersion: "v3.1.0",
    kind: "DataContract",
    id: "report",
    name: "report",
    version: "1.0.0",
    status: "draft",
    schema: [
      {
        name: "report",
        logicalType: "object",
        properties: [
          {
            name: "id",
            logicalType: "integer",
            physicalType: "BIGINT",
            required: true,
          },
        ],
      },
    ],
  };
  const code = `export function validate(plan) { if(plan.nodes[0].columns[0].name !== 'id') throw Error('Missing output contract'); if(plan.sourceFilesChecked && !plan.nodes[0].sql.startsWith('SELECT')) throw Error('Invalid source'); }
export function render(plan) { return {'pipelines/logic.sql': {format:'text', value:plan.nodes[0].sql}}; }`;
  const plan: any = {
    apiVersion: "ingestron.plan/v1",
    selection: {},
    files: { "logic.sql": digest(text) },
    activitySources: { renderer: code },
    nodes: [
      {
        id: "report/transform",
        flow: "report",
        step: "transform",
        runtime: {
          rendererRef: "renderer",
          capabilities: { typedTransformationLanguages: ["sql"] },
        },
        with: { sqlFile: "logic.sql" },
      },
    ],
    flows: [
      {
        id: "report",
        publishes: {
          namedOutput: { from: "steps.transform.outputs.result", contract },
        },
      },
    ],
  };
  validateProviderPlan(plan, root);
  const files = generateProvider(root, plan);
  assert.equal(files["pipelines/logic.sql"], text);
  assert.equal(readFileSync(join(root, "logic.sql"), "utf8"), text);
  assert.equal(existsSync(join(root, "EXECUTED")), false);
  writeFileSync(join(root, "logic.sql"), text + "# concurrent edit\n");
  assert.throws(
    () => generateProvider(root, plan),
    (error: any) => error.code === "STALE",
  );
  assert.equal(existsSync(join(root, "EXECUTED")), false);
});

test("SQL capability declarations require an explicit compatible host feature", () => {
  const capabilities = {
    artifactKinds: ["native-pipeline"],
    delivery: false,
    handovers: [],
    packContracts: {},
    typedTransformationLanguages: ["sql"] as ["sql"],
  };
  assert.throws(
    () =>
      checkProviderCompatibility({
        capabilities,
        compatibility: { minimumCli: "4.2.0", requiredFeatures: [] },
      }),
    /typed-transformation-outputs/,
  );
  checkProviderCompatibility({
    capabilities,
    compatibility: {
      minimumCli: "4.2.0",
      requiredFeatures: ["typed-transformation-outputs"],
    },
  });
});

test("published SQL rules report after-load enforcement and block explicit required rules when unsupported", () => {
  const contract = {
    id: "report",
    schema: [
      {
        name: "report",
        properties: [{ name: "id", primaryKey: true }],
        quality: [
          {
            id: "nonempty",
            metric: "rowCount",
            mustBeGreaterThan: 0,
            severity: "error",
          },
        ],
      },
    ],
  };
  const flow = { id: "report", publishes: { result: { contract } } };
  const declaration = qualityDeclarationSchema.parse({
    transformations: {
      sql: {
        library: {
          rowCount: "after-load",
          duplicateValues: "after-load",
          nullValues: "after-load",
        },
      },
    },
  });
  const entries = flowCoverage(flow, {
    configuration: "native",
    platform: "databricks",
    publishedQuality: { result: declaration.transformations!.sql },
  });
  assert.ok(entries.length > 0);
  assert.ok(entries.every((entry) => entry.mode === "after-load"));
  checkCoverage(entries);
  const unsupported = flowCoverage(flow, {
    configuration: "native",
    platform: "databricks",
    publishedQuality: { result: undefined },
  });
  assert.throws(() => checkCoverage(unsupported), /cannot be enforced/);
  checkCoverage(unsupported, "report");
});
