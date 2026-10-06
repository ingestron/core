import test from "node:test";
import assert from "node:assert/strict";
import {
  projectTableDocuments,
  composeMetadataDocuments,
} from "../../src/core/metadata-documents.js";
import { digest } from "../../src/core/errors.js";

test("indexed assembly preserves exact runners and documents and refuses ambiguous, changed or colliding destinations", () => {
  const docs = projectTableDocuments({
    orders: { contract: { description: "Māori" } },
  }).artifacts;
  const connections = [
    {
      flow: "orders",
      artifacts: { "connector.json": "original index" },
      documents: docs,
    },
  ];
  const original = { "flows/orders/connector.json": "original index" };
  const result = composeMetadataDocuments(original, connections, {
    orders: "flows/orders",
  });
  const document = Object.keys(docs)[0];
  assert.equal(result[`flows/orders/${document}`], docs[document]);
  assert.deepEqual(original, {
    "flows/orders/connector.json": "original index",
  });
  for (const roots of [
    undefined,
    {},
    { orders: "../escape" },
    { orders: "/absolute" },
    { orders: "flows/orders", extra: "flows/extra" },
  ])
    assert.throws(() => composeMetadataDocuments(original, connections, roots));
  assert.throws(() =>
    composeMetadataDocuments(
      { ...original, "flows/orders/connector.json": "changed" },
      connections,
      { orders: "flows/orders" },
    ),
  );
  assert.throws(() =>
    composeMetadataDocuments(
      { ...original, [`flows/orders/${document}`]: docs[document] },
      connections,
      { orders: "flows/orders" },
    ),
  );
  assert.throws(() =>
    composeMetadataDocuments(
      original,
      [...connections, { ...connections[0], flow: "other" }],
      { orders: "flows/orders", other: "flows/orders/nested" },
    ),
  );
  assert.throws(() =>
    composeMetadataDocuments(
      original,
      [{ ...connections[0], documents: { [document]: "changed" } }],
      { orders: "flows/orders" },
    ),
  );
});

test("project metadata documents retain complete UTF-8 contracts, exact hashes and logical byte accounting", () => {
  const table = {
    source: { stream: "orders" },
    contract: {
      id: "orders",
      description: "レビュー Māori",
      custom: { retain: true },
    },
    columns: [
      {
        name: "wire_id",
        target: "customer_id",
        type: "BIGINT",
        required: true,
        key: true,
      },
    ],
  };
  const before = JSON.stringify(table),
    result = projectTableDocuments({ orders: table, another: table }),
    record = result.index.documents.orders;
  assert.equal(result.index.kind, "project");
  assert.equal(result.index.totalBytes, record.bytes * 2);
  assert.equal(Object.keys(result.artifacts).length, 1);
  assert.equal(Buffer.byteLength(result.artifacts[record.path]), record.bytes);
  assert.equal(digest(result.artifacts[record.path]), record.sha256);
  assert.deepEqual(JSON.parse(result.artifacts[record.path]), table);
  assert.equal(JSON.stringify(table), before);
});
test("document preparation rejects count, identity, malformed, nonfinite, document and collection bounds before producing a proposal", () => {
  for (const tables of [
    {},
    Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => ["table_" + i, {}]),
    ),
    { "../escape": {} },
    { orders: null },
    { orders: { value: Infinity } },
  ])
    assert.throws(() => projectTableDocuments(tables as any));
  assert.throws(
    () =>
      projectTableDocuments({ orders: { description: "ā".repeat(1_000_001) } }),
    /2 MB metadata document limit/,
  );
  assert.throws(
    () =>
      projectTableDocuments(
        Object.fromEntries(
          Array.from({ length: 8 }, (_, i) => [
            "table_" + i,
            { description: "x".repeat(900_000) },
          ]),
        ),
      ),
    /7 MB metadata collection limit/,
  );
});
