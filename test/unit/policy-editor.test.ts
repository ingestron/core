import test from "node:test";
import assert from "node:assert/strict";
import { execute } from "../../src/core/operations.js";
import { fixture } from "../support/project.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const ok = (r: any) => {
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  return r.result;
};
test("policy editor reads and proposes existing enforcement rules with stale and write protection", (t) => {
  const f = fixture(t),
    context = { root: f.root },
    before = readFileSync(join(f.root, "project.yaml"), "utf8");
  const read = ok(execute(context, "policy_editor_read"));
  assert.equal(read.policy, null);
  const policy = {
    apiVersion: "ingestron.policy/v1",
    id: "local",
    owner: "Synthetic owner",
    version: "1",
    rules: { contractOwner: "required" },
  };
  const review = ok(
    execute(context, "policy_editor_review", {
      revision: read.revision,
      policy,
    }),
  );
  assert.equal(readFileSync(join(f.root, "project.yaml"), "utf8"), before);
  assert.equal(
    execute(context, "apply", { proposal: review }).diagnostics[0].code,
    "PERMISSION",
  );
  ok(execute({ ...context, allowWrite: true }, "apply", { proposal: review }));
  const after = ok(execute(context, "policy_editor_read"));
  assert.equal(after.policy.rules.contractOwner, "required");
  assert.equal(
    execute(context, "policy_editor_review", {
      revision: read.revision,
      policy,
    }).diagnostics[0].code,
    "STALE",
  );
  const check = ok(execute(context, "governance_check"));
  assert.equal(check.policyReady, false);
  assert.equal(check.policy.digest, after.policyDigest);
  assert.ok(
    check.issues.some(
      (i: any) => i.code === "CONTRACT_OWNER" && i.severity === "error",
    ),
  );
  const repair = ok(
    execute(context, "policy_editor_review", {
      revision: after.revision,
      policy: { ...policy, rules: { contractOwner: "active-only" } },
    }),
  );
  assert.deepEqual(
    repair.changes.map((c: any) => c.path),
    ["governance/policy.yaml"],
  );
  ok(execute({ ...context, allowWrite: true }, "apply", { proposal: repair }));
  assert.equal(ok(execute(context, "governance_check")).policyReady, true);
});
