import assert from "node:assert/strict";
import { test } from "node:test";
import { contractColumns } from "../../src/core/contracts.js";

const contract = {
  apiVersion: "v3.1.0",
  kind: "DataContract",
  id: "customers",
  name: "Customers",
  version: "1.0.0",
  status: "draft",
  schema: [
    {
      name: "customers",
      logicalType: "object",
      physicalType: "table",
      properties: [
        {
          name: "customer_id",
          physicalName: "id",
          logicalType: "integer",
          physicalType: "BIGINT",
          required: true,
        },
      ],
    },
  ],
};

test("ODCS physicalName maps source to unique target", () => {
  assert.deepEqual(contractColumns(contract), [
    {
      name: "id",
      target: "customer_id",
      type: "BIGINT",
      required: true,
      key: false,
    },
  ]);
  assert.throws(
    () =>
      contractColumns({
        ...contract,
        schema: [
          {
            ...contract.schema[0],
            properties: [
              contract.schema[0].properties[0],
              {
                ...contract.schema[0].properties[0],
                physicalName: "other",
              },
            ],
          },
        ],
      }),
    /duplicate target/,
  );
});
