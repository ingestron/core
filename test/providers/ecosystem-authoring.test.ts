import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { execute } from "../../src/core/operations.js";
import { apply } from "../../src/core/authoring.js";
import { ecosystem } from "../support/ecosystem.js";
test("provider starter is runnable, refuses replacement and works through shared operations", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "ingestron-starter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(
    execute({ root }, "provider_scaffold", { id: "Invalid_ID", out: "invalid" })
      .ok,
    false,
  );
  const proposal: any = execute({ root }, "provider_scaffold", {
    id: "example-sql",
    out: "provider example",
  });
  assert.equal(proposal.ok, true, JSON.stringify(proposal));
  apply(root, proposal.result);
  const child = resolve(root, "provider example");
  execFileSync(process.execPath, ["--test", "test/provider.test.mjs"], {
    cwd: child,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== "NODE_TEST_CONTEXT",
      ),
    ),
  });
  const checked = execute({ root: child }, "provider_check", {
    delivery: true,
  });
  assert.equal(checked.ok, true, JSON.stringify(checked));
  const build = execute({ root: child, allowWrite: true }, "build", {
    delivery: true,
    out: "out",
  });
  assert.equal(build.ok, true, JSON.stringify(build));
  assert.match(
    readFileSync(resolve(child, "out/model.sql"), "utf8"),
    /CREATE VIEW example_view/,
  );
  assert.equal(
    execute({ root }, "provider_scaffold", {
      id: "example-sql",
      out: "provider example",
    }).ok,
    false,
  );
  assert.equal(
    execute({ root }, "provider_scaffold", {
      id: "example-sql",
      out: "../escape",
    }).ok,
    false,
  );
});
test("flow group and input editing retain reviewed proposals and reject stale changes", (t) => {
  const f = ecosystem(t);
  const proposal: any = execute({ root: f.root }, "flow_export", {
    id: "landing",
    group: "shared",
  });
  assert.equal(proposal.ok, true, JSON.stringify(proposal));
  apply(f.root, proposal.result);
  const connect: any = execute({ root: f.root }, "flow_connect", {
    id: "landing",
    input: "new_input",
    dataset: "retail.models.customers",
    handover: "relation",
  });
  assert.equal(connect.ok, true, JSON.stringify(connect));
  const duplicate: any = execute({ root: f.root }, "flow_connect", {
    id: "models",
    input: "raw",
    dataset: "retail.landing.customers",
    handover: "relation",
  });
  assert.equal(duplicate.ok, false);
  f.project.description = "concurrent edit";
  f.save();
  assert.throws(() => apply(f.root, connect.result), /changed since/);
});
