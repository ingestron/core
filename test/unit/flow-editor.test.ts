import test from "node:test";
import { parse } from "yaml";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../support/project.js";
import {
  readFlowEditor,
  reviewFlowEditor,
} from "../../src/core/flow-editor.js";
import { apply } from "../../src/core/authoring.js";

function setup(t: any) {
  const f = fixture(t);
  f.put("flows/result/flow.yaml", {
    apiVersion: "ingestron.flow/v1",
    id: "result",
    kind: "transformation",
    description: "Reviewed output",
    requires: {
      source: {
        dataset: "retail.source.orders.current",
        select: { mode: "same-run" },
      },
    },
    steps: [
      {
        id: "calculate",
        uses: "fixture@v1",
        with: {
          targetTable: "retail.gold.result",
          sqlFile: "./result.sql",
          enabled: true,
        },
      },
    ],
    publishes: {
      result: {
        from: "steps.calculate.outputs.result",
        contract: { $resolve: "../source/contracts/orders.yaml" },
      },
    },
  });
  f.put("flows/result/result.sql", "SELECT * FROM source\n");
  const contract = parse(
    readFileSync(join(f.root, "flows/source/contracts/orders.yaml"), "utf8"),
  );
  contract.schema[0].properties[0].description = "Owner-reviewed identifier";
  contract.schema[0].properties[0].physicalName = "source_id";
  f.put("flows/source/contracts/orders.yaml", contract);
  f.project.flows.push({ $resolve: "./flows/result/flow.yaml" });
  f.put("project.yaml", f.project);
  return f;
}
test("editor preserves unknown contract fields and SQL; reviews without writes and rejects stale logic", (t) => {
  const f = setup(t),
    snapshot = readFlowEditor(f.root, "result").selected!;
  const file = join(f.root, "flows/result/flow.yaml"),
    before = readFileSync(file, "utf8");
  const args = {
    flow: "result",
    revision: snapshot.revision,
    description: "Daily outcome",
    values: {},
    logic: { [snapshot.logic[0].id]: "SELECT id FROM source\n" },
    contracts: [],
  };
  const proposal = reviewFlowEditor(f.root, args);
  assert.equal(readFileSync(file, "utf8"), before);
  f.put("flows/result/result.sql", "SELECT changed FROM source\n");
  assert.throws(() => apply(f.root, proposal), /changed/i);
  assert.throws(() => reviewFlowEditor(f.root, args), /changed/i);
  f.put("flows/result/result.sql", snapshot.logic[0].text);
  apply(f.root, proposal);
  const after = readFlowEditor(f.root, "result").selected!;
  assert.equal(after.description, "Daily outcome");
  assert.equal(after.logic[0].text, "SELECT id FROM source\n");
  assert.equal(
    after.values.find((v) => v.name.includes("targetTable"))?.value,
    "retail.gold.result",
  );
});
test("editor validates output fields and denies invented controls without changing files", (t) => {
  const f = setup(t),
    s = readFlowEditor(f.root, "result").selected!;
  const args = {
    flow: "result",
    revision: s.revision,
    description: s.description,
    values: {},
    logic: {},
    contracts: [],
  };
  assert.throws(
    () =>
      reviewFlowEditor(f.root, {
        ...args,
        values: { ["f".repeat(64)]: "../../escape" },
      }),
    /Unknown field/,
  );
  const contract = s.contracts[0];
  assert.throws(
    () =>
      reviewFlowEditor(f.root, {
        ...args,
        contracts: [
          { id: contract.id, fields: [contract.fields[0], contract.fields[0]] },
        ],
      }),
    /Choose each/,
  );
  const fields = contract.fields.map((v: any) => ({ ...v, required: true }));
  apply(
    f.root,
    reviewFlowEditor(f.root, {
      ...args,
      contracts: [{ id: contract.id, fields }],
    }),
  );
  const preserved = parse(
    readFileSync(join(f.root, "flows/source/contracts/orders.yaml"), "utf8"),
  ).schema[0].properties[0];
  assert.equal(preserved.description, "Owner-reviewed identifier");
  assert.equal(preserved.physicalName, "source_id");
  assert.ok(
    readFlowEditor(f.root, "result").selected!.contracts[0].fields.every(
      (v: any) => v.required,
    ),
  );
});
test("editor cannot follow an escaping logic link", (t) => {
  const f = setup(t);
  f.put("flows/result/result.sql", "SELECT 1\n");
  // An absolute reference outside the registered project is rejected before reading.
  const flow = parse(
    readFileSync(join(f.root, "flows/result/flow.yaml"), "utf8"),
  );
  flow.steps[0].with.sqlFile = "/etc/hosts";
  f.put("flows/result/flow.yaml", flow);
  assert.throws(() => readFlowEditor(f.root, "result"), /leaves the project/);
});
