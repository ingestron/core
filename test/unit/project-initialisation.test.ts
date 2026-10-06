import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse } from "yaml";
import { execute } from "../../src/core/operations.js";
function empty(t: any) {
  const root = mkdtempSync(resolve(tmpdir(), "ingestron-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test("empty project setup is a reviewed five-file change with separate development, test and production definitions", (t) => {
  const root = empty(t),
    proposal = execute({ root }, "initialise", { id: "retail" });
  assert.equal(proposal.ok, true);
  assert.equal(proposal.result.changes.length, 5);
  assert.equal(existsSync(resolve(root, "project.yaml")), false);
  assert.equal(
    execute({ root, allowWrite: false }, "apply", { proposal: proposal.result })
      .ok,
    false,
  );
  assert.equal(existsSync(resolve(root, "project.yaml")), false);
  assert.equal(
    execute({ root, allowWrite: true }, "apply", { proposal: proposal.result })
      .ok,
    true,
  );
  const project = parse(readFileSync(resolve(root, "project.yaml"), "utf8"));
  assert.deepEqual(Object.keys(project.environments), ["dev", "test", "prod"]);
  assert.deepEqual(project.providers.configurations, {});
  assert.deepEqual(project.flows, []);
  for (const name of ["dev", "test", "prod"]) {
    const env = parse(
      readFileSync(resolve(root, `environments/${name}.yaml`), "utf8"),
    );
    assert.equal(env.environment, name);
    assert.deepEqual(env.bindings, {});
  }
  assert.equal(execute({ root }, "initialise", { id: "another" }).ok, false);
});
test("project setup rejects reserved and unsafe identifiers before creating any documents", (t) => {
  const root = empty(t);
  for (const id of ["constructor", "__proto__", "prototype", "../outside"]) {
    assert.equal(execute({ root }, "initialise", { id }).ok, false);
    assert.equal(existsSync(resolve(root, "project.yaml")), false);
  }
  for (const name of ["constructor", "__proto__", "prototype", "../outside"]) {
    assert.equal(
      execute({ root }, "initialise", {
        id: "retail",
        environments: ["dev", name],
      }).ok,
      false,
    );
    assert.equal(existsSync(resolve(root, "project.yaml")), false);
  }
  assert.equal(
    execute({ root }, "initialise", {
      id: "retail",
      environments: ["dev", "dev"],
    }).ok,
    false,
  );
});
test("project setup preserves existing user files and rejects a changed review target atomically", (t) => {
  const root = empty(t);
  writeFileSync(resolve(root, ".gitignore"), "# Reviewed user exclusions\n");
  assert.equal(execute({ root }, "initialise", { id: "retail" }).ok, false);
  assert.equal(
    readFileSync(resolve(root, ".gitignore"), "utf8"),
    "# Reviewed user exclusions\n",
  );
  assert.equal(existsSync(resolve(root, "project.yaml")), false);
  rmSync(resolve(root, ".gitignore"));
  const proposal = execute({ root }, "initialise", { id: "retail" });
  assert.equal(proposal.ok, true);
  writeFileSync(resolve(root, "project.yaml"), "# Concurrent user work\n");
  const applied = execute({ root, allowWrite: true }, "apply", {
    proposal: proposal.result,
  });
  assert.equal(applied.ok, false);
  assert.equal(
    readFileSync(resolve(root, "project.yaml"), "utf8"),
    "# Concurrent user work\n",
  );
  assert.equal(existsSync(resolve(root, "environments/dev.yaml")), false);
});
