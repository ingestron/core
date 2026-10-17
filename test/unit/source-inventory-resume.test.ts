import test from "node:test";
import assert from "node:assert/strict";
import { restoreInventory } from "../../src/core/source-journey.js";
import { digest } from "../../src/core/errors.js";
const page = (
  name: string,
  cursor: string | null,
  nextCursor?: string,
  scope = "one",
) => ({
  inventoryRequest: { scope, cursor: cursor ? digest(cursor) : null },
  result: {
    apiVersion: "ingestron.source-access-result/v1",
    status: "succeeded",
    action: "inventory",
    scope: "metadata",
    tables: [
      {
        id: `table_${digest(name).slice(0, 16)}`,
        name,
        kind: "table",
        source: { table: name },
      },
    ],
    ...(nextCursor ? { nextCursor } : {}),
  },
});
test("restores a multi-page inventory without mixing another scope", () => {
  const result = restoreInventory([
    page("c", "two"),
    page("other", null, "two", "other"),
    page("b", "one", "two"),
    page("a", null, "one"),
  ]);
  assert.deepEqual(
    result?.tables.map((t) => t.name),
    ["a", "b", "c"],
  );
  assert.equal(result?.nextCursor, undefined);
});
test("refresh and missing chain never revive older objects", () => {
  assert.deepEqual(
    restoreInventory([page("new", null), page("old", null)])?.tables.map(
      (t) => t.name,
    ),
    ["new"],
  );
  assert.deepEqual(
    restoreInventory([
      page("tail", "missing"),
      page("new", null, "new-cursor"),
      page("old", null, "missing"),
    ])?.tables.map((t) => t.name),
    ["tail"],
  );
});
test("legacy receipts remain a single safe snapshot", () => {
  const latest = page("legacy", null);
  delete (latest as any).inventoryRequest;
  assert.deepEqual(
    restoreInventory([latest, page("old", null)])?.tables.map((t) => t.name),
    ["legacy"],
  );
});
