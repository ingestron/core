import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import { fixture } from "../support/project.js";
import { execute } from "../../src/core/operations.js";
import { inspectProject, planProject } from "../../src/core/planner.js";
import { verifyPlan } from "../../src/core/generate.js";
import { prepareConnection } from "../../src/core/connections.js";
import { policySchema } from "../../src/core/policy-schema.js";
import { projectGovernance } from "../../src/core/project-governance.js";
import { validateDocument } from "../../src/sdk/schemas.js";
const policy = (rules: Record<string, unknown> = {}) =>
  policySchema.parse({
    apiVersion: "ingestron.policy/v1",
    id: "engineering",
    version: "1",
    owner: "Data engineering",
    rules,
  });
function owned(f: ReturnType<typeof fixture>) {
  for (const id of ["orders", "customers"]) {
    const path = `flows/source/contracts/${id}.yaml`;
    const c = parse(readFileSync(resolve(f.root, path), "utf8"));
    c.team = {
      members: [
        { username: "owner", role: "Data owner" },
        { username: "steward", role: "Data steward" },
      ],
    };
    f.put(path, c);
  }
}
const plan = () => ({
  apiVersion: "ingestron.delivery-plan/v1",
  project: "retail",
  revision: 1,
  requirements: [
    {
      id: "R_sales",
      title: "Daily sales",
      description: "Daily sales",
      disposition: "accepted",
      acceptance: ["Counts reconcile"],
    },
  ],
  work: [
    {
      id: "W_sales",
      title: "Implement sales",
      stage: "development",
      requirements: ["R_sales"],
      owner: "Engineering",
      targets: [{ kind: "flow", id: "source" }],
    },
  ],
});

test("governance is read-only, reports definition gaps and never implies approval or runtime enforcement", (t) => {
  const f = fixture(t);
  const before = readFileSync(resolve(f.root, "project.yaml"), "utf8");
  const result = execute({ root: f.root }, "governance_check", {});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.result.policyReady, null);
  assert.equal(result.result.products.length, 2);
  assert.equal(result.result.products[0].requiredQualityRules, 2);
  assert.equal(result.result.products[0].enforcedQualityRules, 0);
  assert.match(result.result.evidence, /no authenticated approval/);
  assert.equal(before, readFileSync(resolve(f.root, "project.yaml"), "utf8"));
  assert.equal(
    execute({ root: f.root }, "governance_check", { flow: "missing" }).ok,
    false,
  );
});

test("saved policy blocks strict inspection before provider planning and does not block correction", (t) => {
  const f = fixture(t);
  f.project.policy = policy({
    contractOwner: "required",
    contractSteward: "required",
    minimumRequiredQualityRules: 2,
    allowedContractStatuses: ["draft"],
  });
  f.put("project.yaml", f.project);
  const failed = execute({ root: f.root }, "governance_check", {});
  assert.equal(failed.ok, true);
  assert.equal(failed.result.policyReady, false);
  assert.equal(
    failed.result.issues.filter((i: any) => i.severity === "error").length,
    4,
  );
  assert.throws(() => inspectProject(f.root), /Contract has no current owner/);
  assert.doesNotThrow(() => inspectProject(f.root, "dev", { draft: true }));
  owned(f);
  assert.doesNotThrow(() => inspectProject(f.root));
  const accepted = execute({ root: f.root }, "governance_check", {}).result;
  assert.equal(accepted.policyReady, true);
  assert.equal(accepted.policy.id, "engineering");
  assert.notEqual(accepted.digest, failed.result.digest);
  f.project.policy = policy({
    minimumRequiredQualityRules: 3,
    allowedContractStatuses: ["active"],
  });
  f.put("project.yaml", f.project);
  assert.throws(() => inspectProject(f.root), /fewer required quality rules/);
});

test("delivery rules validate real target definitions, assignments and current baseline with input hashes", (t) => {
  const f = fixture(t);
  owned(f);
  f.project.policy = policy({
    workOwnersRequired: true,
    acceptedRequirementsAssigned: true,
    definitionTargetsRequired: true,
    reviewedBaselineRequired: true,
  });
  f.put("project.yaml", f.project);
  assert.throws(() => inspectProject(f.root), /requires a delivery plan/);
  const p: any = plan();
  f.put("delivery-plan.yaml", p);
  f.put("delivery-plan.baseline.yaml", p);
  const ready = execute({ root: f.root }, "governance_check", {}).result;
  assert.equal(ready.policyReady, true);
  assert.equal(ready.delivery.baselineCurrent, true);
  assert.ok(ready.inputDigests["delivery-plan.baseline.yaml"]);
  p.work[0].targets[0].id = "missing";
  delete p.work[0].owner;
  p.requirements.push({ ...p.requirements[0], id: "R_unassigned" });
  f.put("delivery-plan.yaml", p);
  const changed = execute({ root: f.root }, "governance_check", {}).result;
  assert.equal(changed.policyReady, false);
  for (const code of [
    "WORK_TARGET",
    "WORK_OWNER",
    "REQUIREMENT_UNASSIGNED",
    "DELIVERY_BASELINE",
  ])
    assert.ok(changed.issues.some((i: any) => i.code === code));
  assert.notEqual(ready.digest, changed.digest);
  p.project = "foreign";
  f.put("delivery-plan.yaml", p);
  assert.equal(
    execute({ root: f.root }, "governance_check", {}).diagnostics[0].code,
    "PROJECT",
  );
});

test("published transformation contracts appear and conflicting identities cannot meet policy", (t) => {
  const f = fixture(t);
  owned(f);
  const state = inspectProject(f.root, "dev", { draft: true });
  state.project.policy = policy();
  const contract = state.flows[0].tables!.orders.contract;
  const published: any = {
    ...state.flows[0],
    id: "publish",
    tables: undefined,
    publishes: { orders: { from: "view", contract } },
  };
  state.flows.push(published);
  assert.deepEqual(
    projectGovernance(state).products.find((p) => p.contract === "orders")!
      .flows,
    ["publish", "source"],
  );
  published.publishes.orders.contract = {
    ...contract,
    description: "different definition",
  };
  const conflict = projectGovernance(state);
  assert.equal(conflict.policyReady, false);
  assert.ok(conflict.issues.some((i) => i.code === "CONTRACT_CONFLICT"));
  const scoped = projectGovernance(state, { flow: "source" });
  assert.equal(scoped.policyReady, true);
});

test("policy authoring is atomic, stale and read-only fenced and preserves inline or referenced ownership", (t) => {
  const f = fixture(t);
  const ctx = { root: f.root };
  const before = readFileSync(resolve(f.root, "project.yaml"), "utf8");
  f.put("project.yaml", "# project owner comment\n" + before);
  const proposal = execute(ctx, "policy_propose", {
    policy: policy({ contractOwner: "required" }),
  }).result;
  assert.deepEqual(
    proposal.changes.map((c: any) => c.path),
    ["project.yaml", "governance/policy.yaml"],
  );
  assert.equal(
    execute(ctx, "apply", { proposal }).diagnostics[0].code,
    "PERMISSION",
  );
  assert.equal(
    execute({ ...ctx, allowWrite: true }, "apply", { proposal }).ok,
    true,
  );
  assert.match(
    readFileSync(resolve(f.root, "project.yaml"), "utf8"),
    /^# project owner comment/,
  );
  f.put(
    "governance/policy.yaml",
    "# policy owner comment\n" + stringify(policy()),
  );
  const edit = execute(ctx, "policy_propose", {
    policy: policy({ contractSteward: "required" }),
  }).result;
  assert.deepEqual(
    edit.changes.map((c: any) => c.path),
    ["governance/policy.yaml"],
  );
  assert.match(edit.changes[0].after, /policy owner comment/);
  f.put(
    "governance/policy.yaml",
    stringify(policy({ minimumRequiredQualityRules: 2 })),
  );
  assert.equal(
    execute({ ...ctx, allowWrite: true }, "apply", { proposal: edit })
      .diagnostics[0].code,
    "STALE",
  );
  f.project.policy = policy();
  f.put("project.yaml", f.project);
  assert.deepEqual(
    execute(ctx, "policy_propose", {
      policy: policy({ contractOwner: "required" }),
    }).result.changes.map((c: any) => c.path),
    ["project.yaml"],
  );
  delete f.project.policy;
  f.put("project.yaml", f.project);
  assert.equal(
    execute(ctx, "policy_propose", { policy: policy() }).diagnostics[0].code,
    "OWNER",
  );
});

test("policy schemas reject unknown controls and expose editor-safe diagnostics", () => {
  const p = policy();
  assert.equal(
    validateDocument({
      kind: "policy",
      content: stringify(p),
      uri: "policy.yaml",
    }).valid,
    true,
  );
  for (const rules of [
    { minimumRequiredQualityRules: -1 },
    { minimumRequiredQualityRules: 101 },
    { allowedContractStatuses: [] },
    { approved: true },
  ])
    assert.equal(policySchema.safeParse({ ...p, rules }).success, false);
  assert.equal(
    execute({ root: process.cwd() }, "schema", { name: "policy" }).ok,
    true,
  );
});

test("portable preparation applies policy before loading source or execution packages", (t) => {
  const f = fixture(t);
  f.project.policy = policy({ contractOwner: "required" });
  f.flow.ingestion = { connection: "files" };
  f.project.connections = {
    files: { package: "absent", sourceId: "files", tenantId: "test" },
  };
  f.put("project.yaml", f.project);
  f.put("flows/source/flow.yaml", f.flow);
  assert.throws(
    () => prepareConnection(f.root, "dev", "source", true),
    (e) => (e as any).code === "POLICY",
  );
  owned(f);
  assert.throws(
    () => prepareConnection(f.root, "dev", "source", true),
    (e) => (e as any).code === "PACKAGE",
  );
});

test("an expired owner invalidates generation even when reviewed source hashes are unchanged", (t) => {
  const f = fixture(t);
  owned(f);
  f.project.policy = policy({ contractOwner: "required" });
  f.put("project.yaml", f.project);
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-10-04T12:00:00Z").getTime(),
  });
  for (const id of ["orders", "customers"]) {
    const path = `flows/source/contracts/${id}.yaml`;
    const c = parse(readFileSync(resolve(f.root, path), "utf8"));
    c.team.members[0].dateOut = "2026-10-05";
    f.put(path, c);
  }
  const planned = planProject(f.root);
  assert.doesNotThrow(() => verifyPlan(f.root, planned));
  t.mock.timers.setTime(new Date("2026-10-06T12:00:00Z").getTime());
  assert.throws(
    () => verifyPlan(f.root, planned),
    (e) => (e as any).code === "POLICY",
  );
});
