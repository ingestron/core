import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse, parseDocument, stringify } from "yaml";
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

test("inline environment copying preserves comments and project-relative references without moving the source", (t) => {
  const f = fixture(t);
  f.put("profiles/shared.yaml", { storage: { $env: "REVIEWED_STORAGE" } });
  const doc = parseDocument(stringify(f.project));
  const profile = parseDocument(
    "apiVersion: ingestron.environment/v1\nenvironment: dev\nvalues:\n  # Shared reviewed profile\n  $resolve: ./profiles/shared.yaml\nbindings: {}\n",
  ).contents!;
  profile.commentBefore = " Reviewed inline resources";
  doc.setIn(["environments", "dev"], profile);
  f.put("project.yaml", doc.toString());
  const before = parse(readFileSync(resolve(f.root, "project.yaml"), "utf8"))
    .environments.dev;
  const proposal = execute({ root: f.root }, "environment_add", {
    name: "uat",
    from: "dev",
  });
  assert.equal(proposal.ok, true, JSON.stringify(proposal));
  assert.deepEqual(
    proposal.result.changes.map((c: any) => c.path),
    ["project.yaml"],
  );
  assert.equal(
    execute({ root: f.root, allowWrite: true }, "apply", {
      proposal: proposal.result,
    }).ok,
    true,
  );
  const saved = readFileSync(resolve(f.root, "project.yaml"), "utf8"),
    project = parse(saved);
  assert.deepEqual(project.environments.dev, before);
  assert.equal(project.environments.uat.environment, "uat");
  assert.equal(
    project.environments.uat.values.$resolve,
    "./profiles/shared.yaml",
  );
  assert.match(saved, /Reviewed inline resources/);
  assert.equal(saved.match(/Shared reviewed profile/g)?.length, 2);
  assert.deepEqual(
    new Configuration(f.root).load().environments.uat.values.storage,
    { $env: "REVIEWED_STORAGE" },
  );
});

test("copied inline anchors are unique while internal and external aliases retain their intended values", (t) => {
  const f = fixture(t),
    doc = parseDocument(stringify(f.project));
  doc.setIn(
    ["defaults", "with"],
    parseDocument(
      "shared: &outside {value: preserved}\ncollision: &env_uat_store {value: unchanged}\n",
    ).contents,
  );
  doc.setIn(
    ["environments", "dev"],
    parseDocument(
      "apiVersion: ingestron.environment/v1\nenvironment: dev\nvalues:\n  storage: &store {$env: REVIEWED_STORAGE}\n  duplicate: *store\n  external: *outside\nbindings: {}\n",
    ).contents,
  );
  f.put("project.yaml", doc.toString());
  const proposal = execute({ root: f.root }, "environment_add", {
    name: "uat",
    from: "dev",
  });
  assert.equal(proposal.ok, true, JSON.stringify(proposal));
  assert.match(proposal.result.changes[0].after, /&env_uat_store_2/);
  assert.match(proposal.result.changes[0].after, /\*env_uat_store_2/);
  assert.equal(
    execute({ root: f.root, allowWrite: true }, "apply", {
      proposal: proposal.result,
    }).ok,
    true,
  );
  const saved = new Configuration(f.root).load();
  assert.deepEqual(saved.environments.uat.values.storage, {
    $env: "REVIEWED_STORAGE",
  });
  assert.deepEqual(
    saved.environments.uat.values.duplicate,
    saved.environments.uat.values.storage,
  );
  assert.deepEqual(saved.environments.uat.values.external, {
    value: "preserved",
  });
  assert.deepEqual(saved.environments.dev.values.storage, {
    $env: "REVIEWED_STORAGE",
  });
});

test("inline copies reject changed shared inputs before modifying the project", (t) => {
  const f = fixture(t);
  f.put("profiles/shared.yaml", { storage: { $env: "REVIEWED_STORAGE" } });
  f.project.environments.dev.values = { $resolve: "./profiles/shared.yaml" };
  f.put("project.yaml", f.project);
  const proposal = execute({ root: f.root }, "environment_add", {
    name: "uat",
    from: "dev",
  });
  assert.equal(proposal.ok, true);
  const before = readFileSync(resolve(f.root, "project.yaml"), "utf8");
  f.put("profiles/shared.yaml", { storage: "changed-after-review" });
  const result = execute({ root: f.root, allowWrite: true }, "apply", {
    proposal: proposal.result,
  });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, "STALE");
  assert.equal(readFileSync(resolve(f.root, "project.yaml"), "utf8"), before);
});
