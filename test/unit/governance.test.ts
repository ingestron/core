import assert from "node:assert/strict";
import { test } from "node:test";
import { contractColumns } from "../../src/core/contracts.js";
import { contractGovernance, dataProducts } from "../../src/core/governance.js";

const base = (extra: Record<string, unknown> = {}) => ({
  apiVersion: "v3.1.0",
  kind: "DataContract",
  id: "orders",
  name: "Orders",
  version: "1.0.0",
  status: "draft",
  schema: [
    {
      name: "orders",
      logicalType: "object",
      physicalType: "table",
      properties: [
        {
          name: "order_id",
          logicalType: "integer",
          physicalType: "BIGINT",
          required: true,
          primaryKey: true,
          quality: [{ metric: "nullValues", mustBe: 0 }],
        },
      ],
      quality: [{ metric: "rowCount", mustBeGreaterThan: 0 }],
    },
  ],
  ...extra,
});

const team = {
  name: "Sales data",
  members: [
    { username: "ana", role: "Data owner" },
    { username: "ben", role: "Data steward" },
    { username: "old", role: "Owner", dateOut: "2020-01-01" },
    { username: "dev", role: "Engineer" },
  ],
};

test("ownership comes from current ODCS team members by role", () => {
  const g = contractGovernance(base({ team }));
  assert.equal(g.contract, "orders");
  assert.equal(g.team, "Sales data");
  assert.deepEqual(g.owners, ["ana"]);
  assert.deepEqual(g.stewards, ["ben"]);
  assert.equal(g.qualityRules, 2);
  assert.equal(g.enforcedQualityRules, 0);
});

test("the deprecated ODCS v2 team array is still read", () => {
  const g = contractGovernance(
    base({ team: [{ username: "ana", role: "owner" }] }),
  );
  assert.deepEqual(g.owners, ["ana"]);
});

test("an active contract must name an owner; drafts need not", () => {
  assert.doesNotThrow(() => contractColumns(base()));
  assert.doesNotThrow(() => contractColumns(base({ status: "active", team })));
  assert.throws(
    () =>
      contractColumns(
        base({
          status: "active",
          team: { members: [{ username: "dev", role: "Engineer" }] },
        }),
      ),
    /active contract must name an owner/,
  );
});

test("data products are listed once per contract with their flows", () => {
  const contract = base({ team });
  const products = dataProducts([
    { id: "ingest", tables: { orders: { contract } } },
    { id: "publish", tables: { orders: { contract } } },
    { id: "empty", tables: {} },
  ]);
  assert.equal(products.length, 1);
  assert.deepEqual(products[0].flows, ["ingest", "publish"]);
  assert.deepEqual(products[0].owners, ["ana"]);
});
