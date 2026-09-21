import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { stringify } from "yaml";
import { Configuration } from "../../src/core/config.js";
import { planProject, inspectProject } from "../../src/core/planner.js";
import { canonical } from "../../src/core/errors.js";
import { fixture } from "../support/project.js";

test("draft environment values stay pending and strict planning explains missing value", (t) => {
  const { root, project, put } = fixture(t);
  project.environments.dev.bindings.lakehouse.host = {
    $env: "TEST_MISSING_HOST",
  };
  put("project.yaml", project);
  assert(
    planProject(root, "dev", {
      draft: true,
      environmentVariables: {},
    }).pending.some((p) => p.name === "TEST_MISSING_HOST"),
  );
  assert.throws(
    () => planProject(root, "dev", { environmentVariables: {} }),
    /supply environment variable TEST_MISSING_HOST/,
  );
});
test("value resolution preserves types, detects cycles and does not rewrite SQL", (t) => {
  const { root } = fixture(t),
    config = new Configuration(root);
  assert.deepEqual(
    config.values(
      { n: "{{values.number}}", sql: "SELECT '{{env}}'" },
      { env: "dev", values: { number: 2 } },
    ),
    { n: 2, sql: "SELECT '{{env}}'" },
  );
  assert.throws(
    () =>
      config.values("{{values.a}}", {
        values: { a: "{{values.b}}", b: "{{values.a}}" },
      }),
    /cycle/,
  );
  assert.throws(
    () => config.values("prefix_{{values.a}}", { values: { a: {} } }),
    /non-scalar/,
  );
});
test("bad references, cycles, reference siblings and duplicate keys fail", (t) => {
  const { root, put } = fixture(t);
  for (const [name, content, pattern] of [
    ["a.yaml", "$resolve: ./a.yaml", /cycle/],
    ["b.yaml", "$resolve: ./project.yaml\nextra: true", /only key/],
    ["c.yaml", "id: one\nid: two", /unique|Map keys|mapping keys/],
    ["d.yaml", "$resolve: ./project.yaml#/missing", /Missing pointer/],
  ] as const) {
    put(name, content);
    assert.throws(() => new Configuration(root).load(name), pattern);
  }
});
test("only the current project schema is accepted", (t) => {
  const { root, project, put } = fixture(t);
  project.apiVersion = "ingestron.project/v2";
  put("project.yaml", project);
  assert.throws(() => planProject(root), /legacy project formats/);
});
test("mismatched environment and unknown flow settings fail", (t) => {
  const { root, project, flow, put } = fixture(t);
  project.environments.dev.environment = "prod";
  put("project.yaml", project);
  assert.throws(() => inspectProject(root), /differs/);
  project.environments.dev.environment = "dev";
  put("project.yaml", project);
  flow.jobs = {};
  put("flows/source/flow.yaml", flow);
  assert.throws(() => planProject(root), /Unrecognized key/);
});
test("physical-name collisions and invalid major activity selectors fail", (t) => {
  const { root, project, flow, put } = fixture(t);
  project.defaults.naming = { table: "same" };
  put("project.yaml", project);
  assert.throws(() => planProject(root), /Target collision/);
  delete project.defaults.naming;
  put("project.yaml", project);
  delete flow.ingestion;
  flow.steps = [{ id: "capture", uses: "lakeflow-ingest@v9" }];
  put("flows/source/flow.yaml", flow);
  assert.throws(() => planProject(root), /does not export|Unknown activity/);
});

test("table placeholders resolve in source paths and embedded missing inputs remain draft", (t) => {
  const { root, project, flow, put } = fixture(t);
  project.environments.dev.values.root = { $env: "INGESTRON_TEST_SOURCE_ROOT" };
  project.environments.dev.bindings.sql = { kind: "adls" };
  flow.defaults.source = {
    binding: "sql",
    format: "parquet",
    path: "{{values.root}}/{{table.id}}",
    deliveryIndex: "{{values.root}}/{{table.id}}/deliveries.json",
  };
  put("project.yaml", project);
  put("flows/source/flow.yaml", flow);
  assert.throws(
    () => planProject(root, "dev", { environmentVariables: {} }),
    /unresolved value|environment variable/,
  );
  const plan = planProject(root, "dev", {
    environmentVariables: {
      INGESTRON_TEST_SOURCE_ROOT:
        "abfss://source@example.dfs.core.windows.net/retail",
    },
  });
  assert.match(
    plan.nodes.find((n) => n.id === "source/customers/ingest_customers")!
      .source!.path,
    /retail\/customers$/,
  );
});
