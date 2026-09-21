import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { fixture } from "../support/project.js";
import { execute } from "../../src/core/operations.js";
import { Configuration } from "../../src/core/config.js";

function setup(t: any) {
  const f = fixture(t);
  f.put("profiles/shared.yaml", { storage: { $env: "REVIEWED_STORAGE" } });
  f.put(
    "profiles/dev.yaml",
    "# Reviewed resource references\napiVersion: ingestron.environment/v1\nenvironment: dev\nvalues:\n  $resolve: ./shared.yaml\nbindings: {}\n",
  );
  f.project.environments.dev = { $resolve: "./profiles/dev.yaml" };
  f.put("project.yaml", f.project);
  return f;
}

test("environment proposals preserve unresolved references, comments and source files", (t) => {
  const f = setup(t),
    ctx = { root: f.root, allowWrite: true };
  const source = readFileSync(resolve(f.root, "profiles/dev.yaml"), "utf8");
  const proposal = execute(ctx, "environment_add", {
    name: "uat",
    from: "dev",
  });
  assert.equal(proposal.ok, true);
  assert.equal(existsSync(resolve(f.root, "profiles/uat.yaml")), false);
  assert.equal(execute(ctx, "apply", { proposal: proposal.result }).ok, true);
  const copied = readFileSync(resolve(f.root, "profiles/uat.yaml"), "utf8");
  assert.match(copied, /# Reviewed resource references/);
  assert.equal(parse(copied).values.$resolve, "./shared.yaml");
  assert.equal(parse(copied).environment, "uat");
  const project = new Configuration(f.root).load();
  assert.deepEqual(
    project.environments.uat.values,
    project.environments.dev.values,
  );
  assert.equal(
    project.environments.uat.values.storage.$env,
    "REVIEWED_STORAGE",
  );
  assert.equal(
    readFileSync(resolve(f.root, "profiles/dev.yaml"), "utf8"),
    source,
  );
  assert.equal(
    execute(ctx, "environment_add", { name: "uat", from: "dev" }).ok,
    false,
  );
});

test("environment authoring rejects overwrites, unsafe names and stale reviewed sources", (t) => {
  const f = setup(t),
    ctx = { root: f.root, allowWrite: true };
  for (const name of ["../escape", "constructor", "__proto__", "prototype"])
    assert.equal(
      execute(ctx, "environment_add", { name, from: "dev" }).ok,
      false,
    );
  assert.equal(
    execute(ctx, "environment_add", { name: "uat", from: "missing" }).ok,
    false,
  );
  f.put("profiles/uat.yaml", "User notes");
  assert.equal(
    execute(ctx, "environment_add", { name: "uat", from: "dev" }).ok,
    false,
  );
  const proposal = execute(ctx, "environment_add", {
    name: "test",
    from: "dev",
  });
  assert.equal(proposal.ok, true);
  f.put("profiles/shared.yaml", { storage: "changed-after-review" });
  const applied = execute(ctx, "apply", { proposal: proposal.result });
  assert.equal(applied.diagnostics[0].code, "STALE");
  assert.equal(existsSync(resolve(f.root, "profiles/test.yaml")), false);
});
