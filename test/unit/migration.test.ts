import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fixture } from "../support/project.js";
import { migrateProvider, apply } from "../../src/core/authoring.js";
import { planProject } from "../../src/core/planner.js";
import { parse } from "yaml";
test("bundled projects get a migration error and an explicit reviewable source change", (t) => {
  const f = fixture(t);
  f.project.providers.packages.dbx = {
    source: "builtin:databricks-native",
    version: "v1",
  };
  f.put("project.yaml", f.project);
  assert.throws(() => planProject(f.root), /plugin migrate/);
  const before = readFileSync(resolve(f.root, "project.yaml"), "utf8"),
    proposal = migrateProvider(f.root, {
      package: "dbx",
      to: "example/fixture@1.0.0",
    });
  assert.equal(readFileSync(resolve(f.root, "project.yaml"), "utf8"), before);
  assert.deepEqual(
    proposal.changes.map((c) => c.path),
    ["project.yaml"],
  );
  const lock = resolve(f.root, "packages.lock.yaml"),
    original = readFileSync(lock, "utf8");
  writeFileSync(lock, original + "\n");
  assert.throws(() => apply(f.root, proposal), /changed|stale/i);
  writeFileSync(lock, original);
  apply(f.root, proposal);
  assert.equal(planProject(f.root).nodes.length, 2);
});
test("provider migration preserves the top-level short package layout", (t) => {
  const f = fixture(t);
  f.project.packages = { dbx: "fixture@1.0.0" };
  f.project.providers.packages = {};
  f.put("project.yaml", f.project);
  const proposal = migrateProvider(f.root, {
    package: "dbx",
    to: "example/fixture@1.0.0",
  });
  apply(f.root, proposal);
  const updated = parse(readFileSync(resolve(f.root, "project.yaml"), "utf8"));
  assert.equal(updated.packages.dbx, "fixture@1.0.0");
  assert.equal(planProject(f.root).nodes.length, 2);
  assert.deepEqual(updated.providers.packages, {});
});
