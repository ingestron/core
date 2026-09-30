import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connectionRoute,
  nativeConnectionFlow,
} from "../../src/core/native-connections.js";
import { projectSchema } from "../../src/core/schema.js";

const sources = {
  "sql-server": {
    route: "native",
    standards: ["snapshot-land@v1"],
    capabilities: ["snapshot"],
    bindingSchema: {
      type: "object",
      required: ["linkedService", "variant"],
      properties: {
        linkedService: { type: "string" },
        variant: { enum: ["azure-sql", "sql-server"] },
      },
      additionalProperties: false,
    },
    source: {
      kind: "{{binding.variant}}",
      linkedService: "{{binding.linkedService}}",
      consistency: "frozen-extract",
      label: "{{connection.sourceId}}-{{connection.database}}",
      via: "{{connection.binding}}",
    },
  },
};
const flow = (ingestion: any = {}) => ({
  id: "sales",
  kind: "ingestion",
  ingestion: {
    connection: "erp",
    standard: "snapshot-land@v1",
    target: {},
    ...ingestion,
  },
  defaults: { with: {} },
  tables: { orders: { source: { schema: "dbo", table: "orders" } } },
});
const connection = {
  kind: "sql-server",
  route: "native",
  sourceId: "erp",
  tenantId: "nz",
  binding: "erp",
  settings: { database: "sales" },
};
const input = (
  binding: any = { linkedService: "erp_sql", variant: "azure-sql" },
) => ({
  connectionName: "erp",
  connection,
  binding,
  configuration: "landing",
  sources,
});

test("a native connection flow becomes the provider's standard with its source", () => {
  const rewritten = nativeConnectionFlow(flow(), input());
  assert.deepEqual(rewritten.ingestion, {
    standard: "snapshot-land@v1",
    target: {},
  });
  assert.deepEqual(rewritten.defaults.source, {
    kind: "azure-sql",
    linkedService: "erp_sql",
    consistency: "frozen-extract",
    label: "erp-sales",
    via: "erp",
  });
  assert.deepEqual(rewritten.tables, flow().tables);
});

test("native routes reject missing routes, wrong standards, bindings and capabilities", () => {
  assert.throws(
    () => nativeConnectionFlow(flow(), { ...input(), sources: {} }),
    /no native route for sql-server/,
  );
  assert.throws(
    () => nativeConnectionFlow(flow({ standard: "append-only@v1" }), input()),
    /choose ingestion.standard from snapshot-land@v1/,
  );
  assert.throws(
    () => nativeConnectionFlow(flow(), input({ linkedService: "x" })),
    /binding for connection erp/,
  );
  assert.throws(
    () => nativeConnectionFlow(flow({ requires: ["cdc"] }), input()),
    /cannot supply cdc/,
  );
  assert.throws(
    () => nativeConnectionFlow(flow({ execution: { mode: "local" } }), input()),
    /apply to portable connectors/,
  );
});

test("connections choose routes; native ones need a kind and portable ones a package", () => {
  const base = {
    apiVersion: "ingestron.project/v1",
    id: "p",
    providers: { configurations: {} },
    environments: {},
    flows: [],
  };
  const parse = (c: any) =>
    projectSchema.safeParse({ ...base, connections: { erp: c } }).success;
  assert.equal(
    parse({
      sourceId: "a",
      tenantId: "b",
      route: "native",
      kind: "sql-server",
    }),
    true,
  );
  assert.equal(parse({ sourceId: "a", tenantId: "b", route: "native" }), false);
  assert.equal(parse({ sourceId: "a", tenantId: "b" }), false);
  assert.equal(parse({ sourceId: "a", tenantId: "b", package: "sql" }), true);
  const project = { connections: { erp: { route: "native" }, gh: {} } };
  assert.equal(
    connectionRoute(project, { ingestion: { connection: "erp" } }),
    "native",
  );
  assert.equal(
    connectionRoute(project, { ingestion: { connection: "gh" } }),
    "portable",
  );
  assert.equal(connectionRoute(project, {}), undefined);
});
