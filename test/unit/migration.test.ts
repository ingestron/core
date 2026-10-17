import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fixture } from "../support/project.js";
import { migrateProvider, apply } from "../../src/core/authoring.js";
import { planProject } from "../../src/core/planner.js";
import { parse } from "yaml";
import { resolvePackage } from "../../src/core/packages.js";
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
test("provider migration refuses a changed reviewed package source without replacing the project", (t) => {
  const f = fixture(t);
  const proposal = migrateProvider(f.root, {
    package: "dbx",
    to: "example/fixture@1.0.0",
  });
  const selected = resolvePackage(f.root, "example/fixture@1.0.0");
  const module = resolve(selected.root, "plugin/index.mjs");
  const before = readFileSync(module, "utf8");
  const project = readFileSync(resolve(f.root, "project.yaml"), "utf8");
  assert.ok(proposal.inputs?.[module.slice(f.root.length + 1)]);
  writeFileSync(module, before + "\n// changed after review\n");
  assert.throws(() => apply(f.root, proposal), /Reviewed input changed/);
  assert.equal(readFileSync(resolve(f.root, "project.yaml"), "utf8"), project);
  writeFileSync(module, before);
  apply(f.root, proposal);
});
test("provider migration refuses package inventory additions, deletions and symlinks after review", async (t) => {
  for (const mutation of ["addition", "deletion", "symlink"] as const) {
    await t.test(mutation, (t) => {
      const f = fixture(t);
      const proposal = migrateProvider(f.root, {
        package: "dbx",
        to: "example/fixture@1.0.0",
      });
      assert.deepEqual(proposal.reviewedPackages, [
        "example/fixture/plugin/provider.yaml@1.0.0",
      ]);
      const selected = resolvePackage(f.root, proposal.reviewedPackages![0]);
      const added = resolve(selected.root, "unreviewed.txt");
      const removed = resolve(selected.root, "plugin/activity.yaml");
      const original = readFileSync(removed);
      const before = readFileSync(resolve(f.root, "project.yaml"), "utf8");
      if (mutation === "addition") writeFileSync(added, "Added after review\n");
      else if (mutation === "deletion") rmSync(removed);
      else symlinkSync(resolve(f.root, "project.yaml"), added);
      assert.throws(
        () => apply(f.root, proposal),
        /inventory changed|Reviewed input changed|symlinks are forbidden/,
      );
      assert.equal(
        readFileSync(resolve(f.root, "project.yaml"), "utf8"),
        before,
      );
      assert.equal(
        readFileSync(resolve(f.root, "packages.lock.yaml"), "utf8").includes(
          "unreviewed",
        ),
        false,
      );
      if (mutation === "deletion") writeFileSync(removed, original);
      else rmSync(added);
      apply(f.root, proposal);
    });
  }
});
