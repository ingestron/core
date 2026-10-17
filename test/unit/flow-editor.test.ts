import test from "node:test";
import { parse } from "yaml";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../support/project.js";
import {
  readFlowEditor,
  reviewFlowEditor,
  createFlowEditor,
} from "../../src/core/flow-editor.js";
import { apply } from "../../src/core/authoring.js";
test("missing source settings use reviewed additions with stale and ownership protection", (t) => {
  const f = fixture(t);
  const snapshot = readFlowEditor(f.root, "source").selected!;
  const before = readFileSync(join(f.root, "flows/source/flow.yaml"), "utf8");
  const edit = {
    flow: "source",
    revision: snapshot.revision,
    description: snapshot.description,
    values: {},
    logic: {},
    contracts: [],
    sourceAdditions: { consistency: "frozen-extract" },
  };
  const proposal = reviewFlowEditor(f.root, edit);
  assert.equal(
    readFileSync(join(f.root, "flows/source/flow.yaml"), "utf8"),
    before,
  );
  apply(f.root, proposal);
  const flow = parse(
    readFileSync(join(f.root, "flows/source/flow.yaml"), "utf8"),
  );
  assert.equal(flow.defaults.source.consistency, "frozen-extract");
  assert.equal(flow.defaults.source.binding, "files");
  assert.deepEqual(flow.tables, parse(before).tables);
  assert.throws(() => reviewFlowEditor(f.root, edit), /changed/);
  const current = readFlowEditor(f.root, "source").selected!;
  assert.ok(
    current.values.some(
      (v) => v.name === "consistency" && v.value === "frozen-extract",
    ),
  );
  assert.throws(
    () => reviewFlowEditor(f.root, { ...edit, revision: current.revision }),
    /existing source/,
  );
  for (const sourceAdditions of [
    { password: "synthetic" },
    { $resolve: "../escape" },
    { __proto__: null, constructor: "bad" },
    { nested: {} },
    { consistency: null },
  ]) {
    assert.throws(() =>
      reviewFlowEditor(f.root, {
        ...edit,
        revision: current.revision,
        sourceAdditions,
      } as any),
    );
  }
});

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
test("quality authoring preserves custom rules, follows field renames and rejects invalid rules", (t) => {
  const f = setup(t);
  const path = "flows/source/contracts/orders.yaml";
  const contract = parse(readFileSync(join(f.root, path), "utf8"));
  contract.schema[0].properties[1].quality = [
    {
      id: "custom-expectation",
      type: "custom",
      engine: "fixture",
      severity: "warning",
      implementation: { nested: { preserved: true } },
    },
  ];
  f.put(path, contract);
  const snapshot = readFlowEditor(f.root, "result").selected!;
  const output = snapshot.contracts[0];
  const original = output.fields[0].name;
  const quality = {
    ...output.quality,
    table: JSON.stringify([
      {
        id: "rows",
        type: "library",
        metric: "rowCount",
        mustBeGreaterThan: 0,
        severity: "error",
      },
    ]),
    fields: {
      ...output.quality.fields,
      [original]: JSON.stringify([
        {
          id: "no-nulls",
          type: "library",
          metric: "nullValues",
          mustBe: 0,
          severity: "warning",
        },
      ]),
    },
  };
  const fields = output.fields.map((field: any, i: number) =>
    i === 0 ? { ...field, name: "renamed_id" } : field,
  );
  const args = {
    flow: "result",
    revision: snapshot.revision,
    description: snapshot.description,
    values: {},
    logic: {},
    contracts: [{ id: output.id, fields, quality }],
  };
  const before = readFileSync(join(f.root, path), "utf8");
  const proposal = reviewFlowEditor(f.root, args);
  assert.equal(readFileSync(join(f.root, path), "utf8"), before);
  for (const invalid of [
    "{}",
    JSON.stringify([{ type: "library", metric: "made-up", mustBe: 0 }]),
    JSON.stringify([
      { id: "same", type: "text" },
      { id: "same", type: "text" },
    ]),
  ])
    assert.throws(() =>
      reviewFlowEditor(f.root, {
        ...args,
        contracts: [
          { id: output.id, fields, quality: { ...quality, table: invalid } },
        ],
      }),
    );
  assert.throws(
    () =>
      reviewFlowEditor(f.root, {
        ...args,
        contracts: [
          {
            id: output.id,
            fields,
            quality: { ...quality, fields: { unknown: "[]" } },
          },
        ],
      }),
    /unknown field/,
  );
  apply(f.root, proposal);
  const saved = parse(readFileSync(join(f.root, path), "utf8"));
  assert.deepEqual(
    saved.schema[0].properties[1].quality,
    contract.schema[0].properties[1].quality,
  );
  assert.equal(saved.schema[0].quality[0].metric, "rowCount");
  assert.equal(saved.schema[0].properties[0].name, "renamed_id");
  assert.equal(saved.schema[0].properties[0].quality[0].metric, "nullValues");
  assert.equal(
    saved.schema[0].properties[0].description,
    "Owner-reviewed identifier",
  );
  const reopened = readFlowEditor(f.root, "result").selected!;
  assert.ok(reopened.contracts[0].quality.fields.renamed_id);
  const unchanged = reviewFlowEditor(f.root, {
    flow: "result",
    revision: reopened.revision,
    description: reopened.description,
    values: {},
    logic: {},
    contracts: [reopened.contracts[0]],
  });
  assert.equal(unchanged.changes.length, 0);
});
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

test("contract metadata round-trips without losing other owners, team roles, descriptions or field annotations", (t) => {
  const f = setup(t),
    path = "flows/source/contracts/orders.yaml";
  const contract = parse(readFileSync(join(f.root, path), "utf8"));
  contract.description = {
    purpose: "Source orders",
    limitations: "Synthetic only",
  };
  contract.team = {
    name: "Retail",
    members: [
      {
        username: "Commercial",
        role: "owner",
        description: "Existing accountability",
      },
      { username: "Quality", role: "steward" },
    ],
  };
  f.put(path, contract);
  const s = readFlowEditor(f.root, "result").selected!;
  assert.equal(
    s.readiness.find((r) => r.id.endsWith(":identity"))?.ready,
    false,
  );
  const c = s.contracts[0];
  const edit = {
    flow: s.id,
    revision: s.revision,
    description: s.description,
    values: {},
    logic: {},
    contracts: [
      {
        id: c.id,
        fields: c.fields,
        metadata: {
          contractId: "retail.reviewed-orders",
          name: "Reviewed orders",
          purpose: "Identify missing orders",
          owners: ["Commercial", "Operations"],
        },
      },
    ],
  };
  assert.throws(
    () =>
      reviewFlowEditor(f.root, {
        ...edit,
        contracts: [
          {
            ...edit.contracts[0],
            metadata: {
              ...edit.contracts[0].metadata,
              contractId: "customers",
            },
          },
        ],
      }),
    /already uses/,
  );
  apply(f.root, reviewFlowEditor(f.root, edit));
  const after = parse(readFileSync(join(f.root, path), "utf8"));
  assert.deepEqual(after.schema, contract.schema);
  assert.equal(after.id, "retail.reviewed-orders");
  assert.equal(after.description.limitations, "Synthetic only");
  assert.equal(after.description.purpose, "Identify missing orders");
  assert.equal(after.team.name, "Retail");
  assert.deepEqual(after.team.members.slice(0, 2), contract.team.members);
  assert.deepEqual(after.team.members[2], {
    username: "Operations",
    role: "owner",
  });
  assert.equal(
    after.schema[0].properties[0].description,
    "Owner-reviewed identifier",
  );
  assert.deepEqual(
    readFlowEditor(f.root, "result").selected!.contracts[0].metadata.owners,
    ["Commercial", "Operations"],
  );
});

test("legacy provider rendering standards do not imply supported flow creation", (t) => {
  const f = setup(t);
  const provider = readFlowEditor(f.root).providers[0];
  assert.equal(provider.available, false);
  assert.deepEqual(provider.standards, []);
  assert.deepEqual(provider.kinds, []);
});

test("ingestion creation refuses a prospective identity already assigned to another output", (t) => {
  const f = setup(t);
  const path = "flows/source/contracts/customers.yaml";
  const contract = parse(readFileSync(join(f.root, path), "utf8"));
  contract.id = "retail.new_stock.stock";
  f.put(path, contract);
  assert.throws(
    () =>
      createFlowEditor(f.root, "dev", {
        id: "new_stock",
        kind: "ingestion",
        provider: "engineering",
        standard: "append-only@v1",
        output: "stock",
      }),
    /already uses this contract identity/,
  );
});
