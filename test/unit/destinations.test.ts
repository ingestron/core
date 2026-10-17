import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execute } from "../../src/core/operations.js";
import { fixture } from "../support/project.js";
const passed = (r: any) => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.result;
};
const read = (f: any) => passed(execute({ root: f.root }, "destination_read"));
const setup = (target = "databricks", method = "auto-loader") => ({
  target,
  method,
  responsibilities: ["ingestion", "orchestration"],
  deferred: true,
  resources: {},
});
const review = (
  f: any,
  name: string,
  value: any = setup(),
  revision = read(f).revision,
) =>
  execute({ root: f.root }, "destination_review", {
    configuration: name,
    revision,
    setup: value,
  });
test("standalone mixed destinations preserve flows and need no programme, resources or package installation", (t) => {
  const f = fixture(t),
    before = readFileSync(join(f.root, "flows/source/flow.yaml"), "utf8");
  for (const [name, method] of [
    ["adf", "python-batch"],
    ["databricks", "auto-loader"],
    ["fabric", "copy-job"],
  ]) {
    const proposal = passed(review(f, name, setup(name, method)));
    assert.equal(execute({ root: f.root }, "apply", { proposal }).ok, false);
    passed(execute({ root: f.root, allowWrite: true }, "apply", { proposal }));
  }
  assert.deepEqual(Object.keys(read(f).setups), [
    "adf",
    "databricks",
    "fabric",
  ]);
  assert.equal(
    readFileSync(join(f.root, "flows/source/flow.yaml"), "utf8"),
    before,
  );
  for (const name of ["programme.yaml", "planning.yaml"])
    assert.equal(existsSync(join(f.root, name)), false);
  assert.deepEqual(read(f).configured, ["engineering"]);
});
test("destination reviews reject stale state, fabricated deferred resources and unknown modes", (t) => {
  const f = fixture(t),
    revision = read(f).revision;
  f.project.description = "A concurrent edit";
  f.put("project.yaml", f.project);
  assert.equal(
    review(f, "dbx", setup(), revision).diagnostics[0].code,
    "STALE",
  );
  assert.equal(
    review(f, "dbx", {
      ...setup(),
      resources: { workspaceUrl: "https://example.invalid" },
    }).ok,
    false,
  );
  assert.equal(review(f, "dbx", setup("databricks", "invented")).ok, false);
  assert.equal(review(f, "__proto__").ok, false);
  assert.equal(review(f, "dbx", { ...setup(), deferred: false }).ok, false);
});
test("planned methods remain deferred and environment configurations cannot alias one another", (t) => {
  const f = fixture(t);
  f.project.environments.uat = structuredClone(f.project.environments.dev);
  f.put("project.yaml", f.project);
  const proposal = passed(review(f, "adf", setup("adf", "mapping-data-flow")));
  passed(execute({ root: f.root, allowWrite: true }, "apply", { proposal }));
  assert.equal(
    review(f, "adf", { ...setup("adf", "mapping-data-flow"), deferred: false })
      .diagnostics[0].code,
    "CAPABILITY",
  );
  const revision = passed(
    execute({ root: f.root, environment: "uat" }, "destination_read"),
  ).revision;
  assert.equal(
    execute({ root: f.root, environment: "uat" }, "destination_review", {
      configuration: "adf",
      revision,
      setup: setup("adf", "snapshot-copy"),
    }).diagnostics[0].code,
    "OWNER",
  );
});

test("ingestion mode inspection resolves short locked provider identities and rejects undeclared modes", (t) => {
  const f = fixture(t);
  f.project.providers.packages.dbx = { source: "fixture", version: "1.0.0" };
  f.put("project.yaml", f.project);
  const value = passed(
    execute({ root: f.root }, "flow_modes_read", { flow: "source" }),
  );
  assert.equal(value.provider, "engineering");
  assert.equal(value.platform, "databricks");
  assert.equal(
    execute({ root: f.root }, "flow_modes_review", {
      flow: "source",
      revision: value.revision,
      mode: "invented",
    }).diagnostics[0].code,
    "CAPABILITY",
  );
});
