import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { execute } from "../../src/core/operations.js";
import { fixture } from "../support/project.js";
import { verifyProgrammeDelivery } from "../../src/core/programme-delivery.js";
const ok = (r: any) => {
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  return r.result;
};
function setup(t: any) {
  const f = fixture(t);
  const item = {
    title: "Synthetic work",
    description: "Preserve the reviewed scope",
    owner: "Team",
    priority: "must",
    disposition: "done",
    acceptance: ["Reviewed source totals reconcile"],
    projectIds: ["retail-plan"],
  };
  const document: any = {
    apiVersion: "ingestron.programme/v1",
    id: "delivery",
    name: "Delivery",
    objective: "Synthetic",
    sponsor: "Owner",
    stakeholders: [],
    projects: [{ id: "retail-plan", name: "Retail", compilerId: "retail" }],
    requirements: [
      { ...item, id: "R_orders", kind: "requirement" },
      { ...item, id: "W_contract", kind: "task", basisIds: ["R_orders"] },
      {
        ...item,
        id: "W_verify",
        kind: "task",
        basisIds: ["R_orders"],
        dependsOn: ["W_contract"],
      },
    ],
  };
  const save = () =>
    f.put("programme/programme.json", JSON.stringify(document));
  save();
  const common = {
    programme: { id: "delivery", root: join(f.root, "programme") },
    project: "retail-plan",
  };
  const call = (name: string, input: any = common, write = false) =>
    execute({ root: f.root, allowWrite: write }, name as any, input);
  const selection = {
    requirements: [{ id: "R_orders", disposition: "draft" }],
    work: [
      {
        id: "W_contract",
        stage: "contracts",
        requirements: ["R_orders"],
        targets: [],
      },
      {
        id: "W_verify",
        stage: "verification",
        requirements: ["R_orders"],
        targets: [],
      },
    ],
  };
  return { f, document, save, common, call, selection };
}
test("programme handoff preserves authored work, requires explicit acceptance and guards stale/replayed writes", (t) => {
  const { f, document, save, common, call, selection } = setup(t);
  const read = ok(call("programme_delivery_read"));
  assert.equal(read.plan, null);
  const input = { ...common, revision: read.revision, selection };
  let review = ok(call("programme_delivery_review", input));
  assert.equal(
    call("programme_delivery_apply", { programme: common.programme, review })
      .diagnostics[0].code,
    "PERMISSION",
  );
  document.objective = "Changed scope";
  save();
  assert.equal(
    call(
      "programme_delivery_apply",
      { programme: common.programme, review },
      true,
    ).diagnostics[0].code,
    "STALE",
  );
  review = ok(
    call("programme_delivery_review", {
      ...input,
      revision: ok(call("programme_delivery_read")).revision,
    }),
  );
  ok(
    call(
      "programme_delivery_apply",
      { programme: common.programme, review },
      true,
    ),
  );
  let saved = ok(call("programme_delivery_read"));
  assert.equal(saved.plan.requirements[0].disposition, "draft"); // Done never grants acceptance.
  assert.deepEqual(
    saved.plan.requirements[0].acceptance,
    document.requirements[0].acceptance,
  );
  assert.deepEqual(saved.plan.work[1].dependsOn, ["W_contract"]);
  assert.equal(saved.independentlyEdited, false);
  assert.equal(
    call(
      "programme_delivery_apply",
      { programme: common.programme, review },
      true,
    ).diagnostics[0].code,
    "STALE",
  );
  const old = readFileSync(join(f.root, "delivery-plan.yaml"), "utf8");
  document.requirements[0].description = "Changed authored requirement";
  save();
  saved = ok(call("programme_delivery_read"));
  assert.equal(saved.sourceChanged, true);
  const refresh = ok(
    call("programme_delivery_review", { ...input, revision: saved.revision }),
  );
  assert.equal(readFileSync(join(f.root, "delivery-plan.yaml"), "utf8"), old);
  ok(
    call(
      "programme_delivery_apply",
      { programme: common.programme, review: refresh },
      true,
    ),
  );
  saved = ok(call("programme_delivery_read"));
  assert.equal(saved.plan.revision, 2);
  assert.equal(saved.sourceChanged, false);
});
test("programme handoff rejects missing dependencies, silent adoption and truncated source content", (t) => {
  const { f, document, save, common, call, selection } = setup(t);
  const review = (value: any = selection, adoptExisting = false) =>
    call("programme_delivery_review", {
      ...common,
      revision: ok(call("programme_delivery_read")).revision,
      selection: value,
      adoptExisting,
    });
  assert.equal(
    review({ ...selection, work: selection.work.slice(1) }).diagnostics[0].code,
    "DEPENDENCY",
  );
  const initial = ok(review());
  ok(
    call(
      "programme_delivery_apply",
      { programme: common.programme, review: initial },
      true,
    ),
  );
  const read = ok(call("programme_delivery_read"));
  read.plan.requirements[0].description = "Independent manual change";
  f.put("delivery-plan.yaml", read.plan);
  assert.equal(ok(call("programme_delivery_read")).independentlyEdited, true);
  assert.equal(review().diagnostics[0].code, "OWNER");
  const adopted = ok(review(selection, true));
  ok(
    call(
      "programme_delivery_apply",
      { programme: common.programme, review: adopted },
      true,
    ),
  );
  document.requirements[0].description = "x".repeat(2001);
  save();
  assert.equal(review().ok, false);
});
test("programme baseline is a separate review, preserves source scope and rejects altered proposals", (t) => {
  const { document, save, common, call, selection } = setup(t);
  const read = () => ok(call("programme_delivery_read"));
  const initial = ok(
    call("programme_delivery_review", {
      ...common,
      revision: read().revision,
      selection,
    }),
  );
  const tampered = structuredClone(initial);
  tampered.proposal.changes[0].after += "# changed\n";
  assert.equal(
    call(
      "programme_delivery_apply",
      { programme: common.programme, review: tampered },
      true,
    ).diagnostics[0].code,
    "STALE",
  );
  ok(
    call(
      "programme_delivery_apply",
      { programme: common.programme, review: initial },
      true,
    ),
  );
  assert.equal(read().baselineCurrent, false);
  const baseline = ok(
    call("programme_delivery_baseline_review", {
      ...common,
      revision: read().revision,
    }),
  );
  ok(
    call(
      "programme_delivery_apply",
      { programme: common.programme, review: baseline },
      true,
    ),
  );
  assert.equal(read().baselineCurrent, true);
  document.requirements[0].applications = [
    {
      projectId: common.project,
      status: "not-applicable",
      evidence: "Outside scope",
    },
  ];
  save();
  assert.equal(
    read().items.some((i: any) => i.id === "R_orders"),
    false,
  );
  assert.equal(
    call("programme_delivery_baseline_review", {
      ...common,
      revision: read().revision,
    }).diagnostics[0].code,
    "STALE",
  );
  assert.equal(
    call("programme_delivery_review", {
      ...common,
      revision: read().revision,
      selection,
    }).diagnostics[0].code,
    "REQUIREMENT",
  );
});

test("manual comments in a materialised plan require explicit adoption", (t) => {
  const { f, common, call, selection } = setup(t);
  const read = () => ok(call("programme_delivery_read"));
  const initial = ok(
    call("programme_delivery_review", {
      ...common,
      revision: read().revision,
      selection,
    }),
  );
  ok(
    call(
      "programme_delivery_apply",
      { programme: common.programme, review: initial },
      true,
    ),
  );
  const path = join(f.root, "delivery-plan.yaml");
  const authored = "# Keep the review context\n" + readFileSync(path, "utf8");
  f.put("delivery-plan.yaml", authored);
  assert.equal(read().independentlyEdited, true);
  assert.equal(
    call("programme_delivery_review", {
      ...common,
      revision: read().revision,
      selection,
    }).diagnostics[0].code,
    "OWNER",
  );
  assert.equal(
    call("programme_delivery_baseline_review", {
      ...common,
      revision: read().revision,
    }).diagnostics[0].code,
    "STALE",
  );
  assert.equal(readFileSync(path, "utf8"), authored);
});
test("builds require the current registered planning source and retain its file identities", (t) => {
  const { f, document, save, common, call, selection } = setup(t);
  assert.deepEqual(verifyProgrammeDelivery(f.root), {});
  const initial = ok(
    call("programme_delivery_review", {
      ...common,
      revision: ok(call("programme_delivery_read")).revision,
      selection,
    }),
  );
  ok(
    call(
      "programme_delivery_apply",
      { programme: common.programme, review: initial },
      true,
    ),
  );
  assert.equal(call("build_review", {}).diagnostics[0].code, "BINDING");
  const files = verifyProgrammeDelivery(f.root, common.programme);
  assert.match(files["delivery-plan.source.yaml"]!, /^[a-f0-9]{64}$/);
  assert.match(files["delivery-plan.yaml"]!, /^[a-f0-9]{64}$/);
  document.objective = "Changed programme";
  save();
  assert.equal(
    call("build_review", { programme: common.programme }).diagnostics[0].code,
    "STALE",
  );
});
