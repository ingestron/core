import assert from "node:assert/strict";
import { test } from "node:test";
import { expandBridgeFlows } from "../../src/core/bridge-connections.js";
import { connectionRoute } from "../../src/core/native-connections.js";
import { flowSchema, projectSchema } from "../../src/core/schema.js";

const contract = {
  apiVersion: "v3.1.0",
  kind: "DataContract",
  id: "customers",
  name: "customers",
  version: "1.0.0",
  status: "draft",
  schema: [{ name: "customers", properties: [] }],
};
const connection = {
  kind: "sql-server",
  route: "bridge",
  binding: "erp_adf",
  sourceId: "erp",
  tenantId: "nz",
  bridge: {
    provider: "landing",
    publisher: "publisher",
    landing: {
      linkedService: "landing_adls",
      fileSystem: "landing",
      path: "retail",
    },
    handover: "files",
    publication: { maximumDropPercent: 50 },
  },
};
const flow = (extra: any = {}) =>
  flowSchema.parse({
    apiVersion: "ingestron.flow/v1",
    kind: "ingestion",
    id: "sales",
    provider: "processing",
    ingestion: {
      connection: "erp",
      standard: "snapshot-with-history@v1",
      pipeline: "sales",
    },
    tables: {
      customers: { source: { schema: "dbo", table: "customers" }, contract },
      orders: { source: { schema: "dbo", table: "orders" }, contract },
    },
    ...extra,
  });
const connections = () => ({
  erp: projectSchema.shape.connections.parse({ erp: connection }).erp,
});

test("a bridge expands into landing, publication and ingestion legs", () => {
  const [land, publish, consumer] = expandBridgeFlows("retail", connections(), [
    flow(),
  ]) as any[];
  assert.deepEqual(
    [land.id, publish.id, consumer.id],
    ["sales_land", "sales_publish", "sales"],
  );
  assert.equal(land.provider, "landing");
  assert.deepEqual(land.ingestion, {
    connection: "erp",
    standard: "snapshot-land@v1",
    target: connection.bridge.landing,
    handover: { binding: "files" },
  });
  assert.deepEqual(land.tables.orders.source, {
    schema: "dbo",
    table: "orders",
  });
  assert.equal(publish.provider, "publisher");
  assert.deepEqual(publish.ingestion, {
    standard: "snapshot-publication@v1",
    maximumDropPercent: 50,
  });
  assert.deepEqual(publish.requires.landing_orders, {
    dataset: "retail.sales_land.orders.snapshot",
    select: { mode: "same-run" },
    handover: "files",
  });
  assert.deepEqual(publish.tables.orders.source, {
    from: "requires.landing_orders",
  });
  assert.equal(consumer.ingestion.connection, undefined);
  assert.equal(consumer.ingestion.standard, "snapshot-with-history@v1");
  assert.equal(
    consumer.requires.completed_customers.dataset,
    "retail.sales_publish.customers.completed",
  );
  assert.deepEqual(consumer.tables.customers.source, {
    from: "requires.completed_customers",
  });
  assert.deepEqual(consumer.bridge.legs, ["sales_land", "sales_publish"]);
  // Every leg is a complete parsed flow.
  for (const leg of [land, publish])
    assert.deepEqual(Object.keys(leg.tables.customers.steps), []);
  // The landing leg reads natively on its landing provider only.
  const project = { connections: connections() };
  assert.equal(connectionRoute(project, land), "bridge");
  assert.equal(connectionRoute(project, consumer), undefined);
});

test("other flows pass through unchanged", () => {
  const other = flow({
    id: "plain",
    ingestion: { standard: "append-only@v1" },
  });
  assert.deepEqual(expandBridgeFlows("retail", connections(), [other]), [
    other,
  ]);
});

test("bridges fail closed on ambiguous or unsupported flows", () => {
  const expand = (f: any) => expandBridgeFlows("retail", connections(), [f]);
  assert.throws(
    () => expand(flow({ provider: undefined })),
    /name the ingesting provider/,
  );
  assert.throws(
    () => expand(flow({ provider: "landing" })),
    /name the ingesting provider/,
  );
  assert.throws(
    () =>
      expand(
        flow({
          requires: {
            other: { dataset: "retail.x.y.z", select: { mode: "same-run" } },
          },
        }),
      ),
    /remove requires/,
  );
  assert.throws(
    () =>
      expand(
        flow({
          ingestion: {
            connection: "erp",
            standard: "snapshot-with-history@v1",
            execution: { mode: "local" },
          },
        }),
      ),
    /portable connectors/,
  );
});

test("the schema requires a kind and a bridge block exactly for bridge routes", () => {
  const parse = (c: any) =>
    projectSchema.shape.connections.safeParse({ erp: c });
  assert.equal(parse(connection).success, true);
  const { bridge: _b, ...withoutBlock } = connection;
  assert.match(
    JSON.stringify(parse(withoutBlock).error),
    /needs a bridge block/,
  );
  assert.match(
    JSON.stringify(parse({ ...connection, route: "native" }).error),
    /only a bridge connection has one/,
  );
  const { kind: _k, ...withoutKind } = connection;
  assert.match(JSON.stringify(parse(withoutKind).error), /needs a kind/);
  assert.equal(
    parse(connection).data!.erp.bridge!.standard,
    "snapshot-land@v1",
  );
});
