import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../../src/core/operations.js";
const input = {
  programme: {
    id: "retail",
    name: "Retail decisions",
    objective: "Improve daily decisions",
    owner: "Commercial lead",
  },
  project: {
    id: "margin",
    name: "Daily margin",
    outcome: "Explain margin exceptions before the trading day",
  },
  platform: {
    id: "retail-data",
    name: "Retail platform",
    targets: ["databricks"],
  },
  environments: [
    { name: "dev", purpose: "development" },
    { name: "uat", purpose: "test" },
  ],
};
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "workspace-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test("workspace review is read only; apply creates interoperable programme and project YAML", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "README.md"), "Existing repository material\n");
  const review = execute({ root }, "workspace_initialisation_review", input);
  assert.equal(review.ok, true, JSON.stringify(review.diagnostics));
  assert.deepEqual(readdirSync(root), ["README.md"]);
  assert.equal(
    execute({ root }, "workspace_initialisation_apply", review.result).ok,
    false,
  );
  const request = {
    input: review.result.input,
    proposal: review.result.proposal,
  };
  assert.equal(
    execute({ root }, "workspace_initialisation_apply", request).ok,
    false,
  );
  const saved = execute(
    { root, allowWrite: true },
    "workspace_initialisation_apply",
    request,
  );
  assert.equal(saved.ok, true, JSON.stringify(saved.diagnostics));
  assert.equal(saved.result.workspace.projects[0].id, "margin");
  assert.deepEqual(saved.result.workspace.projects[0].environments, [
    "dev",
    "uat",
  ]);
  assert.equal(
    readFileSync(join(root, "README.md"), "utf8"),
    "Existing repository material\n",
  );
  const programme = execute(
    { root: join(root, "programme") },
    "programme_read",
    { id: "retail" },
  );
  assert.equal(programme.ok, true, JSON.stringify(programme.diagnostics));
  assert.equal(
    programme.result.document.requirements[0].description,
    input.project.outcome,
  );
  assert.deepEqual(
    programme.result.document.platforms[0].configuration.targets[0]
      .environments,
    [],
  );
  assert.equal(
    execute({ root: join(root, "projects/margin") }, "environments", {}).ok,
    true,
  );
  assert.equal(
    execute(
      { root, allowWrite: true },
      "workspace_initialisation_apply",
      request,
    ).ok,
    false,
  );
});
test("workspace apply rejects stale, forged and conflicting definitions without writes", (t) => {
  for (const mode of ["changed", "forged", "symlink"]) {
    const root = fixture(t);
    const reviewed = execute(
      { root },
      "workspace_initialisation_review",
      input,
    ).result;
    if (mode === "changed") {
      mkdirSync(join(root, "projects"));
      writeFileSync(join(root, "projects/keep.txt"), "keep");
    }
    if (mode === "forged") reviewed.proposal.changes[0].after += "# forged\n";
    if (mode === "symlink") symlinkSync(tmpdir(), join(root, "programme"));
    const saved = execute(
      { root, allowWrite: true },
      "workspace_initialisation_apply",
      { input, proposal: reviewed.proposal },
    );
    assert.equal(saved.ok, false, mode);
    assert.equal(readdirSync(root).includes(".programme-write.lock"), false);
    if (mode === "changed")
      assert.equal(
        readFileSync(join(root, "projects/keep.txt"), "utf8"),
        "keep",
      );
  }
});
test("workspace input rejects ambiguous targets, paths and missing accountable intent", (t) => {
  const root = fixture(t);
  for (const override of [
    { platform: { ...input.platform, targets: ["databricks", "databricks"] } },
    { project: { ...input.project, id: "../outside" } },
    { programme: { ...input.programme, owner: "" } },
    { environments: [...input.environments, input.environments[0]] },
  ])
    assert.equal(
      execute({ root }, "workspace_initialisation_review", {
        ...input,
        ...override,
      }).ok,
      false,
    );
  assert.deepEqual(readdirSync(root), []);
});

test("project-first setup requires only name and outcome and parks enterprise structures", (t) => {
  const root = fixture(t);
  const intent = {
    mode: "project",
    project: {
      id: "daily-sales",
      name: "Daily sales",
      outcome: "Understand sales trends",
    },
  };
  const review = execute({ root }, "workspace_initialisation_review", intent);
  assert.equal(review.ok, true, JSON.stringify(review.diagnostics));
  const result = execute(
    { root, allowWrite: true },
    "workspace_initialisation_apply",
    { input: review.result.input, proposal: review.result.proposal },
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.result.workspace.platforms, []);
  assert.deepEqual(result.result.workspace.projects[0].environments, ["dev"]);
  assert.equal(result.result.workspace.projects[0].platformId, undefined);
  assert.equal(result.result.workspace.programme, undefined);
  assert.equal(result.result.workspace.projects[0].path, "");
  assert.equal(result.result.workspace.projects[0].name, "Daily sales");
  assert.deepEqual(readdirSync(root).sort(), [
    ".gitignore",
    "environments",
    "project.yaml",
  ]);
  assert.match(
    readFileSync(join(root, "project.yaml"), "utf8"),
    /description: Understand sales trends/,
  );
  assert.equal(execute({ root }, "environments", {}).ok, true);
  assert.equal(
    execute({ root }, "workspace_inspect", {}).result.projects[0].id,
    "daily-sales",
  );
});
