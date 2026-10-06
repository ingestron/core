import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stringify } from "yaml";
import { deliveryPlanSchema } from "../../src/core/delivery-plan-schema.js";
import { deliveryPlanDiff } from "../../src/core/delivery-plan.js";
import { execute } from "../../src/core/operations.js";
import { validateDocument } from "../../src/sdk/schemas.js";

const draft = () => ({
  apiVersion: "ingestron.delivery-plan/v1",
  project: "retail",
  revision: 1,
  requirements: [
    {
      id: "R_sales",
      title: "Daily sales",
      description: "Finance needs daily sales by store.",
      disposition: "accepted",
      acceptance: ["Approved totals reconcile to the reviewed source scope."],
    },
  ],
  work: [
    {
      id: "W_bronze",
      title: "Review raw orders",
      stage: "contracts",
      requirements: ["R_sales"],
      owner: "Ingestion",
      targets: [{ kind: "source", id: "retail_sql" }],
    },
    {
      id: "W_gold",
      title: "Verify finance output",
      stage: "verification",
      requirements: ["R_sales"],
      dependsOn: ["W_bronze"],
    },
  ],
});
test("delivery intent is strict, linked and acyclic and never accepts a completion claim", () => {
  assert.equal(deliveryPlanSchema.safeParse(draft()).success, true);
  for (const mutate of [
    (p: any) => p.requirements.push({ ...p.requirements[0] }),
    (p: any) => p.work.push({ ...p.work[0] }),
    (p: any) => p.work[0].requirements.push("unknown"),
    (p: any) => (p.work[0].dependsOn = ["unknown"]),
    (p: any) => (p.work[0].dependsOn = ["W_bronze"]),
    (p: any) => (p.work[0].dependsOn = ["W_gold"]),
    (p: any) => (p.work[0].complete = true),
    (p: any) => (p.work[0].due = "2026-02-31"),
    (p: any) => p.work[0].requirements.push("R_sales"),
    (p: any) => (p.work[0].targets[0].password = "forbidden"),
  ]) {
    const plan = draft();
    mutate(plan);
    assert.equal(deliveryPlanSchema.safeParse(plan).success, false);
  }
});
test("baseline differences use stable identity, propagate dependency impact and flag unchanged revision", () => {
  const before = deliveryPlanSchema.parse(draft());
  const after = structuredClone(before);
  after.requirements[0].acceptance.push("Refunds are deducted once.");
  after.work.reverse();
  const diff = deliveryPlanDiff(before, after);
  assert.deepEqual(diff.requirements.changed, ["R_sales"]);
  assert.deepEqual(diff.work.changed, []);
  assert.deepEqual(diff.affectedWork, ["W_bronze", "W_gold"]);
  assert.equal(diff.revisionAdvanced, false);
  const reordered = structuredClone(before);
  reordered.work.reverse();
  assert.deepEqual(deliveryPlanDiff(before, reordered).work.changed, []);
  assert.throws(() => deliveryPlanDiff(before, { ...after, project: "other" }));
});
test("a changed upstream package impacts dependent work without claiming evidence freshness", () => {
  const before = deliveryPlanSchema.parse(draft());
  const after = structuredClone(before);
  after.work[1].requirements = ["R_sales"];
  after.work[0].owner = "Platform ingestion";
  const diff = deliveryPlanDiff(before, after);
  assert.deepEqual(diff.work.changed, ["W_bronze"]);
  assert.deepEqual(diff.affectedWork, ["W_bronze", "W_gold"]);
});
test("checking is offline, fenced, read-only and separates assignment from acceptance evidence", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "delivery-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(resolve(root, "project.yaml"), "id: retail\n");
  const plan = draft();
  plan.requirements.push({ ...plan.requirements[0], id: "R_unassigned" });
  const content = stringify(plan);
  writeFileSync(resolve(root, "delivery-plan.yaml"), content);
  writeFileSync(resolve(root, "baseline.yaml"), stringify(draft()));
  const result = execute(
    { root, allowExecute: false, allowNetwork: false, allowWrite: false },
    "delivery_plan_check",
    { baseline: "baseline.yaml" },
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.result.requirements.unassigned, ["R_unassigned"]);
  assert.deepEqual(result.result.work.withoutOwner, ["W_gold"]);
  assert.match(result.result.evidence, /no acceptance, progress/);
  assert.equal(
    readFileSync(resolve(root, "delivery-plan.yaml"), "utf8"),
    content,
  );
  assert.equal(
    execute({ root }, "delivery_plan_check", { path: "../delivery-plan.yaml" })
      .ok,
    false,
  );
  writeFileSync(resolve(root, "project.yaml"), "id: other\n");
  assert.equal(execute({ root }, "delivery_plan_check", {}).ok, false);
});
test("editor validation and generated JSON schema expose the same delivery contract", () => {
  const plan = draft();
  assert.equal(
    validateDocument({
      kind: "delivery-plan",
      uri: "untitled:plan",
      content: stringify(plan),
    }).valid,
    true,
  );
  plan.work[0].requirements = ["missing"];
  const result = validateDocument({
    kind: "delivery-plan",
    uri: "untitled:plan",
    content: stringify(plan),
  });
  assert.equal(result.valid, false);
  assert.match(result.diagnostics[0].pointer, /work\/0\/requirements\/0/);
  const schema = execute({ root: process.cwd() }, "schema", {
    name: "delivery-plan",
  });
  assert.equal(schema.ok, true, JSON.stringify(schema.diagnostics));
  assert.ok(schema.result.properties.requirements);
});

test("plan and baseline proposals require explicit application and reject foreign intent", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "delivery-author-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(resolve(root, "project.yaml"), "id: retail\n");
  const proposal = execute({ root }, "delivery_plan_propose", {
    plan: draft(),
  });
  assert.equal(proposal.ok, true, JSON.stringify(proposal.diagnostics));
  assert.equal(
    execute({ root }, "apply", { proposal: proposal.result }).ok,
    false,
  );
  assert.equal(
    execute({ root, allowWrite: true }, "apply", { proposal: proposal.result })
      .ok,
    true,
  );
  const baseline = execute({ root }, "delivery_plan_baseline", {});
  assert.equal(baseline.ok, true, JSON.stringify(baseline.diagnostics));
  assert.equal(
    execute({ root, allowWrite: true }, "apply", { proposal: baseline.result })
      .ok,
    true,
  );
  const original = readFileSync(
    resolve(root, "delivery-plan.baseline.yaml"),
    "utf8",
  );
  const changed = draft();
  changed.revision = 2;
  changed.work[0].owner = "Platform";
  const next = execute({ root }, "delivery_plan_propose", { plan: changed });
  assert.equal(
    execute({ root, allowWrite: true }, "apply", { proposal: next.result }).ok,
    true,
  );
  const check = execute({ root }, "delivery_plan_check", {
    baseline: "delivery-plan.baseline.yaml",
  });
  assert.deepEqual(check.result.diff.affectedWork, ["W_bronze", "W_gold"]);
  assert.equal(
    readFileSync(resolve(root, "delivery-plan.baseline.yaml"), "utf8"),
    original,
  );
  assert.equal(
    execute({ root }, "delivery_plan_propose", {
      plan: { ...changed, project: "foreign" },
    }).ok,
    false,
  );
  assert.equal(
    execute({ root }, "delivery_plan_baseline", {
      baseline: "delivery-plan.yaml",
    }).ok,
    false,
  );
});
