import assert from "node:assert/strict";
import { test } from "node:test";
import { draftContract, fromRows } from "../../src/core/discovery.js";
import { contractColumns } from "../../src/core/contracts.js";

test("drafts are valid contracts; keys only when accepted; unusable fields are listed", () => {
  const columns = [
    { name: "id", type: "integer", nullable: false, key: true },
    {
      name: "amount",
      type: "decimal",
      nullable: true,
      precision: 10,
      scale: 2,
    },
    { name: "ratio", type: "number", nullable: true },
    { name: "active", type: "boolean", nullable: true },
    { name: "note", type: "string", nullable: true },
    {
      name: "payload",
      type: "string",
      nullable: true,
      supported: false,
      sourceType: "jsonb",
    },
    { name: "Order Date", type: "string", nullable: true },
  ] as any;
  const { contract, skipped } = draftContract("orders", columns, false);
  const props = contract.schema[0].properties as any[];
  assert.deepEqual(
    props.map((p) => [
      p.name,
      p.physicalType,
      p.required ?? false,
      p.primaryKey ?? false,
    ]),
    [
      ["id", "BIGINT", true, false],
      ["amount", "DECIMAL(10,2)", false, false],
      ["ratio", "DOUBLE", false, false],
      ["active", "BOOLEAN", false, false],
      ["note", "STRING", false, false],
    ],
  );
  assert.equal(contract.status, "draft");
  assert.deepEqual(
    skipped.map((s) => s.name),
    ["payload", "Order Date"],
  );
  const keyed = draftContract("orders", columns, true).contract;
  assert.equal((keyed.schema[0].properties as any[])[0].primaryKey, true);
  assert.equal(contractColumns(keyed)[0].key, true);
  assert.throws(
    () =>
      draftContract(
        "empty",
        [{ name: "x y", type: "string", nullable: true }] as any,
        false,
      ),
    /no usable fields/,
  );
});

test("exported metadata rows from ADF and Databricks become catalogue columns", () => {
  const sqlServer = [
    {
      schema_name: "dbo",
      table_name: "Orders",
      column_name: "OrderID",
      ordinal_position: 1,
      data_type: "int",
      precision: 10,
      scale: 0,
      nullable: false,
      primary_key: true,
    },
    {
      schema_name: "dbo",
      table_name: "Orders",
      column_name: "Freight",
      ordinal_position: 2,
      data_type: "money",
      precision: 19,
      scale: 4,
      nullable: true,
      primary_key: false,
    },
    {
      schema_name: "dbo",
      table_name: "Orders",
      column_name: "Shape",
      ordinal_position: 3,
      data_type: "geography",
      nullable: true,
      primary_key: false,
    },
  ];
  const orders = fromRows(sqlServer, {
    orders: { schema: "dbo", table: "Orders" },
  }).orders.columns;
  assert.deepEqual(
    orders.map((c) => [c.name, c.type, c.key ?? false, c.supported ?? true]),
    [
      ["OrderID", "integer", true, true],
      ["Freight", "decimal", false, true],
      ["Shape", "string", false, false],
    ],
  );
  assert.equal(orders[1].precision, 19);
  // Oracle returns upper-case column aliases; NUMBER with scale 0 is an integer.
  const oracle = [
    {
      SCHEMA_NAME: "SALES",
      TABLE_NAME: "CUSTOMERS",
      COLUMN_NAME: "ID",
      ORDINAL_POSITION: 1,
      DATA_TYPE: "NUMBER",
      NUMERIC_PRECISION: 10,
      NUMERIC_SCALE: 0,
      NULLABLE: 0,
      PRIMARY_KEY: 1,
    },
  ];
  assert.equal(
    fromRows(oracle, { c: { schema: "SALES", table: "CUSTOMERS" } }).c
      .columns[0].type,
    "integer",
  );
  // Databricks information_schema types, matched by destination table for SaaS sources.
  const databricks = [
    {
      schema_name: "bronze",
      table_name: "accounts",
      column_name: "Id",
      ordinal_position: 1,
      data_type: "STRING",
      nullable: "NO",
    },
    {
      schema_name: "bronze",
      table_name: "accounts",
      column_name: "Revenue",
      ordinal_position: 2,
      data_type: "DECIMAL",
      numeric_precision: 18,
      numeric_scale: 2,
      nullable: "YES",
    },
    {
      schema_name: "bronze",
      table_name: "accounts",
      column_name: "Employees",
      ordinal_position: 3,
      data_type: "LONG",
      nullable: "YES",
    },
  ];
  const accounts = fromRows(databricks, { accounts: { object: "Account" } })
    .accounts.columns;
  assert.deepEqual(
    accounts.map((c) => [c.name, c.type, c.nullable]),
    [
      ["Id", "string", false],
      ["Revenue", "decimal", true],
      ["Employees", "integer", true],
    ],
  );
  assert.throws(
    () => fromRows(sqlServer, { missing: { schema: "dbo", table: "Nope" } }),
    /no metadata rows/,
  );
});
