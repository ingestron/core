import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../support/project.js";
import { inspectProject, planProject } from "../../src/core/planner.js";
import { execute } from "../../src/core/operations.js";
import { flowSchema } from "../../src/core/schema.js";

test("a named execution profile shares datasets and contracts and stays independent of environment", (t) => {
  const f = fixture(t);
  f.flow.executionProfiles = {
    alternate: {
      provider: "engineering",
      ingestion: f.flow.ingestion,
      source: f.flow.defaults.source,
    },
  };
  f.put("flows/source/flow.yaml", f.flow);
  const base = inspectProject(f.root, "dev");
  const target = inspectProject(f.root, "dev", {
    flow: "source",
    profile: "alternate",
  });
  assert.deepEqual(target.flows[0].tables, base.flows[0].tables);
  const plan = planProject(f.root, "dev", {
    flow: "source",
    profile: "alternate",
  });
  assert.equal(plan.selection.profile, "alternate");
  assert.equal(plan.environment, "dev");
  assert.notEqual(
    plan.digest,
    planProject(f.root, "dev", { flow: "source" }).digest,
  );
  assert.equal(
    execute({ root: f.root }, "resolve", {
      flow: "source",
      profile: "alternate",
    }).ok,
    true,
  );
  assert.equal(
    execute({ root: f.root }, "validate", {
      flow: "source",
      profile: "alternate",
    }).ok,
    true,
  );
});
test("profile selection fails closed and cannot override shared table identity", (t) => {
  const f = fixture(t);
  assert.throws(
    () => inspectProject(f.root, "dev", { profile: "adf" }),
    /Select one flow/,
  );
  assert.throws(
    () => inspectProject(f.root, "dev", { flow: "source", profile: "missing" }),
    /unknown execution profile/,
  );
  f.flow.executionProfiles = {
    adf: {
      provider: "engineering",
      ingestion: f.flow.ingestion,
      source: { table: "other" },
    },
  };
  f.put("flows/source/flow.yaml", f.flow);
  assert.throws(
    () => inspectProject(f.root, "dev", { flow: "source", profile: "adf" }),
    /cannot replace dataset/,
  );
  assert.equal(
    flowSchema.safeParse({
      ...f.flow,
      executionProfiles: {
        adf: { ...f.flow.executionProfiles.adf, tables: {} },
      },
    }).success,
    false,
  );
  assert.equal(
    execute({ root: f.root }, "validate", {
      mode: "draft",
      profile: "adf",
      flow: "source",
    }).ok,
    false,
  );
});
test("profile binding replaces runtime source defaults while preserving explicit dataset fields", (t) => {
  const f = fixture(t);
  f.flow.executionProfiles = {
    sql: {
      provider: "engineering",
      ingestion: { standard: "snapshot-land@v1" },
      source: { kind: "azure-sql", linkedService: "northwind" },
    },
  };
  f.flow.tables.customers.source = { schema: "dbo", table: "Customers" };
  f.put("flows/source/flow.yaml", f.flow);
  const selected = inspectProject(f.root, "dev", {
    flow: "source",
    profile: "sql",
  }).flows[0];
  assert.deepEqual(selected.defaults.source, {
    kind: "azure-sql",
    linkedService: "northwind",
  });
  assert.deepEqual(selected.tables!.customers.source, {
    schema: "dbo",
    table: "Customers",
  });
  assert.equal(selected.ingestion!.connection, undefined);
});
