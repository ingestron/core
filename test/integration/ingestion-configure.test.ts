import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import { fixture } from "../support/project.js";
import { mapContractFields } from "../../src/core/authoring.js";
import { execute } from "../../src/core/operations.js";

const execution = { mode: "local", ingestion: "incremental" };
const source = (table: string) => ({
  schema: "public",
  table,
  incremental: {
    watermark: "id",
    initial: 0,
    consistency: "ordered-committed-append",
  },
});
test("contract locations follow inline and fragment references through the authoritative fences", (t) => {
  const { root, put, project } = fixture(t);
  const contract = {
    apiVersion: "v3.1.0",
    kind: "DataContract",
    id: "sales",
    schema: [{ name: "orders", properties: [] }],
  };
  project.flows = [
    { id: "inline", kind: "ingestion", tables: { orders: { contract } } },
    { $resolve: "./shared.yaml#/flow" },
  ];
  put("project.yaml", project);
  put("shared.yaml", {
    flow: {
      id: "shared",
      kind: "ingestion",
      tables: { orders: { $resolve: "./objects.yaml#/orders" } },
    },
  });
  put("objects.yaml", {
    orders: { contract: { $resolve: "./contracts.yaml#/sales" } },
  });
  put("contracts.yaml", {
    sales: contract,
    other: { description: "preserve" },
  });
  const inline = execute({ root }, "contract_location", {
    flow: "inline",
    table: "orders",
  });
  assert.equal(inline.ok, true, JSON.stringify(inline.diagnostics));
  assert.equal(inline.result.path, "project.yaml");
  assert.deepEqual(inline.result.pointer, [
    "flows",
    0,
    "tables",
    "orders",
    "contract",
  ]);
  const shared = execute({ root }, "contract_location", {
    flow: "shared",
    table: "orders",
  });
  assert.equal(shared.ok, true, JSON.stringify(shared.diagnostics));
  assert.equal(shared.result.path, "contracts.yaml");
  assert.deepEqual(shared.result.pointer, ["sales"]);
  assert.match(shared.result.documentRevision, /^[a-f0-9]{64}$/);
  const locations = execute({ root }, "authoring_locations", {
    flow: "shared",
  });
  assert.equal(locations.ok, true, JSON.stringify(locations.diagnostics));
  assert.deepEqual(locations.result.flow.pointer, ["flow"]);
  assert.equal(locations.result.flow.path, "shared.yaml");
  assert.deepEqual(locations.result.tables.orders.pointer, ["orders"]);
  assert.equal(locations.result.tables.orders.path, "objects.yaml");
  assert.deepEqual(locations.result.tables.orders.contract, shared.result);
  const batch = execute({ root }, "authoring_locations_batch", {
    flows: ["shared"],
  });
  assert.equal(batch.ok, true, JSON.stringify(batch));
  assert.deepEqual(batch.result.flows.shared, locations.result);
  assert.deepEqual(Object.keys(batch.result.documents), [
    "contracts.yaml",
    "objects.yaml",
    "shared.yaml",
  ]);
  assert.equal(
    batch.result.documents["objects.yaml"].sha256,
    locations.result.tables.orders.documentRevision,
  );
  assert.equal(
    batch.result.documents["contracts.yaml"].sha256,
    locations.result.tables.orders.contract.documentRevision,
  );
  assert.equal(
    batch.result.documents["shared.yaml"].content,
    readFileSync(resolve(root, "shared.yaml"), "utf8"),
  );
  assert.equal(
    execute({ root }, "authoring_locations_batch", {
      flows: ["shared", "shared"],
    }).diagnostics[0].code,
    "FLOW",
  );

  put(".private-flow.yaml", {
    apiVersion: "ingestron.flow/v1",
    kind: "ingestion",
    id: "private_flow",
    tables: { orders: { contract } },
  });
  project.flows.push({ $resolve: "./.private-flow.yaml" } as any);
  put("project.yaml", project);
  assert.equal(
    execute({ root }, "authoring_locations_batch", { flows: ["private_flow"] })
      .diagnostics[0].code,
    "PATH",
  );
  project.flows.pop();
  put("project.yaml", project);
  assert.equal(
    execute({ root }, "contract_location", { flow: "shared", table: "foreign" })
      .ok,
    false,
  );
  put("objects.yaml", {
    orders: { contract: { $resolve: "../outside.yaml" } },
  });
  assert.equal(
    execute({ root }, "contract_location", { flow: "shared", table: "orders" })
      .ok,
    false,
  );
});
test("bounded authoring batches include deduplicated contract fragments and refuse private contract documents", (t) => {
  const { root, put, project } = fixture(t);
  const contract = (name: string) => ({
    apiVersion: "v3.1.0",
    kind: "DataContract",
    id: name,
    schema: [{ name, properties: [{ name: "id", logicalType: "integer" }] }],
  });
  put("contracts/shared.yaml", {
    contracts: [contract("first"), contract("second")],
  });
  const tables = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => {
      const name = `table_${index}`;
      if (index > 1) put(`contracts/${name}.yaml`, contract(name));
      return [
        name,
        {
          contract: {
            $resolve:
              index < 2
                ? `./contracts/shared.yaml#/contracts/${index}`
                : `./contracts/${name}.yaml`,
          },
        },
      ];
    }),
  );
  project.flows = [{ id: "estate", kind: "ingestion", tables }];
  put("project.yaml", project);
  const result = execute({ root }, "authoring_locations_batch", {
    flows: ["estate"],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(Object.keys(result.result.documents).length, 100);
  assert.deepEqual(result.result.flows.estate.tables.table_1.contract.pointer, [
    "contracts",
    "1",
  ]);
  for (const table of Object.values<any>(result.result.flows.estate.tables))
    assert.equal(
      result.result.documents[table.contract.path].sha256,
      table.contract.documentRevision,
    );
  put(".private-contract.yaml", contract("private"));
  tables.table_99.contract.$resolve = "./.private-contract.yaml";
  put("project.yaml", project);
  const denied = execute({ root }, "authoring_locations_batch", {
    flows: ["estate"],
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.diagnostics[0].code, "PATH");
});
test("ingestion configuration previews one atomic change across inline and referenced table definitions", (t) => {
  const { root, put, project } = fixture(t);
  project.flows = [
    {
      apiVersion: "ingestron.flow/v1",
      kind: "ingestion",
      id: "append",
      ingestion: { connection: "sales" },
      tables: {
        orders: { source: { schema: "public", table: "orders" } },
        customers: { $resolve: "./tables.yaml#/customers" },
      },
    },
  ];
  put("project.yaml", "# project comment\n" + stringify(project));
  put(
    "tables.yaml",
    "# shared definitions\ncustomers:\n  source: {schema: public, table: customers}\n  description: retain this\nother:\n  source: {schema: public, table: other}\n",
  );
  const before = readFileSync(resolve(root, "project.yaml"), "utf8");
  const ctx = { root, environment: "dev", allowWrite: true };
  const proposal = execute(ctx, "ingestion_configure", {
    flow: "append",
    execution,
    sources: { orders: source("orders"), customers: source("customers") },
  });
  assert.equal(proposal.ok, true, JSON.stringify(proposal.diagnostics));
  assert.equal(readFileSync(resolve(root, "project.yaml"), "utf8"), before);
  assert.deepEqual(proposal.result.changes.map((c: any) => c.path).sort(), [
    "project.yaml",
    "tables.yaml",
  ]);
  assert.equal(
    execute({ ...ctx, allowWrite: false }, "apply", {
      proposal: proposal.result,
    }).ok,
    false,
  );
  assert.equal(execute(ctx, "apply", { proposal: proposal.result }).ok, true);
  const applied = parse(readFileSync(resolve(root, "project.yaml"), "utf8"));
  assert.deepEqual(applied.flows[0].ingestion.execution, execution);
  const tables = parse(readFileSync(resolve(root, "tables.yaml"), "utf8"));
  assert.deepEqual(tables.customers.source, source("customers"));
  assert.equal(tables.customers.description, "retain this");
  assert.deepEqual(tables.other.source, { schema: "public", table: "other" });
  assert.match(
    readFileSync(resolve(root, "tables.yaml"), "utf8"),
    /shared definitions/,
  );
});

test("foreign tables and conflicting shared definitions produce no proposal or writes", (t) => {
  const { root, put, project } = fixture(t);
  project.flows = [
    {
      apiVersion: "ingestron.flow/v1",
      kind: "ingestion",
      id: "append",
      tables: {
        first: { $resolve: "./shared.yaml" },
        second: { $resolve: "./shared.yaml" },
      },
    },
  ];
  put("project.yaml", project);
  put("shared.yaml", { source: { schema: "public", table: "orders" } });
  const before = readFileSync(resolve(root, "shared.yaml"), "utf8");
  for (const sources of [
    { foreign: source("foreign") },
    { first: source("first"), second: source("second") },
  ]) {
    const result = execute({ root }, "ingestion_configure", {
      flow: "append",
      execution,
      sources,
    });
    assert.equal(result.ok, false);
    assert.equal(result.result, undefined);
    assert.equal(readFileSync(resolve(root, "shared.yaml"), "utf8"), before);
  }
});

test("referenced flow configuration retains sibling files and rejects a stale multi-file proposal", (t) => {
  const { root, put, flow } = fixture(t);
  const before = readFileSync(resolve(root, "project.yaml"), "utf8");
  put("flows/source/flow.yaml", "# keep flow comment\n" + stringify(flow));
  const result = execute({ root }, "ingestion_configure", {
    flow: "source",
    execution,
    sources: {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.result.changes.map((c: any) => c.path),
    ["flows/source/flow.yaml"],
  );
  assert.match(result.result.changes[0].after, /keep flow comment/);
  writeFileSync(
    resolve(root, "flows/source/contracts/orders.yaml"),
    "# changed input\n" +
      readFileSync(resolve(root, "flows/source/contracts/orders.yaml"), "utf8"),
  );
  assert.equal(
    execute({ root, allowWrite: true }, "apply", { proposal: result.result })
      .diagnostics[0].code,
    "STALE",
  );
  assert.equal(readFileSync(resolve(root, "project.yaml"), "utf8"), before);
});

test("field mappings edit the bound inline or fragment contract and retain neighbouring definitions", (t) => {
  const { root, put, project } = fixture(t);
  const putJson = (name: string, value: unknown) =>
    put(name, JSON.stringify(value));
  const contract = {
    apiVersion: "v3.1.0",
    kind: "DataContract",
    id: "orders",
    name: "Orders",
    version: "1.0.0",
    status: "active",
    team: { members: [{ username: "synthetic-owner", role: "Data owner" }] },
    schema: [
      {
        name: "orders",
        logicalType: "object",
        physicalType: "table",
        properties: [
          {
            name: "id",
            logicalType: "integer",
            physicalType: "BIGINT",
            required: true,
            primaryKey: true,
            description: "Owned key",
            quality: [
              {
                id: "no_nulls",
                type: "library",
                metric: "nullValues",
                mustBe: 0,
                severity: "error",
              },
            ],
          },
        ],
      },
    ],
  };
  project.flows = [
    {
      id: "inline",
      kind: "ingestion",
      tables: { orders: { contract }, untouched: { description: "preserve" } },
    },
  ];
  put("project.yaml", "# Owner comment\n" + stringify(project));
  putJson("discovery.json", {
    apiVersion: "ingestron.singer-discovery/v1",
    catalog: {
      streams: [
        {
          stream: "orders",
          schema: {
            properties: {
              id: { type: "integer" },
              label: { type: ["string", "null"] },
            },
          },
        },
      ],
    },
  });
  const options = {
    apiVersion: "ingestron.field-mapping/v1" as const,
    flow: "inline",
    environment: "dev",
    contract: "project.yaml#/flows/0/tables/orders/contract",
    discovery: "discovery.json",
    stream: "orders",
    table: "orders",
    fields: [
      { source: "id", target: "order_id" },
      { source: "label", target: "label" },
    ],
  };
  const proposal = mapContractFields(root, options);
  assert.equal(proposal.changes.length, 1);
  assert.equal(proposal.changes[0].path, "project.yaml");
  assert.match(proposal.changes[0].after, /Owner comment/);
  const changed = parse(proposal.changes[0].after);
  const mapped = changed.flows[0].tables.orders.contract;
  assert.equal(mapped.status, "draft");
  assert.equal(mapped.schema[0].properties[0].physicalName, "id");
  assert.equal(mapped.schema[0].properties[0].primaryKey, true);
  assert.equal(mapped.schema[0].properties[0].description, "Owned key");
  assert.equal(mapped.schema[0].properties[0].quality[0].id, "no_nulls");
  assert.equal(mapped.schema[0].properties[1].required, false);
  assert.deepEqual(
    changed.flows[0].tables.untouched,
    project.flows[0].tables.untouched,
  );
  assert.throws(
    () =>
      mapContractFields(root, {
        ...options,
        contract: "project.yaml#/flows/0/tables/untouched",
      }),
    /authoritative workflow/,
  );
  putJson("discovery.json", { apiVersion: "changed" });
  const stale = execute({ root, allowWrite: true }, "apply", { proposal });
  assert.equal(stale.ok, false);
  assert.equal(stale.diagnostics[0].code, "STALE");
  project.flows[0].tables.orders.contract = {
    $resolve: "./contracts.yaml#/orders",
  };
  put("project.yaml", project);
  put(
    "contracts.yaml",
    "# Shared owner comment\n" +
      stringify({ orders: contract, sibling: { description: "keep" } }),
  );
  putJson("discovery.json", {
    apiVersion: "ingestron.singer-discovery/v1",
    catalog: {
      streams: [
        {
          stream: "orders",
          schema: {
            properties: { id: { type: "integer" }, label: { type: "string" } },
          },
        },
      ],
    },
  });
  const fragment = mapContractFields(root, {
    ...options,
    contract: "contracts.yaml#/orders",
  });
  assert.equal(fragment.changes[0].path, "contracts.yaml");
  const shared = parse(fragment.changes[0].after);
  assert.deepEqual(shared.sibling, { description: "keep" });
  assert.equal(shared.orders.schema[0].properties[0].name, "order_id");
  assert.match(fragment.changes[0].after, /Shared owner comment/);
});
