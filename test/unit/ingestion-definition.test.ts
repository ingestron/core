import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../../src/core/operations.js";
const definition = {
  apiVersion: "ingestron.ingestion-definition/v1",
  id: "sales",
  name: "Sales",
  status: "draft",
  objects: [],
};
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "portable-ingestion-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const review = execute({ root }, "workspace_initialisation_review", {
    mode: "project",
    project: { id: "retail", name: "Retail", outcome: "Understand sales" },
  });
  assert.equal(review.ok, true, JSON.stringify(review.diagnostics));
  const saved = execute(
    { root, allowWrite: true },
    "workspace_initialisation_apply",
    { input: review.result.input, proposal: review.result.proposal },
  );
  assert.equal(saved.ok, true, JSON.stringify(saved.diagnostics));
  return root;
}
test("portable draft review and save needs no target and rejects stale or forged reviews", (t) => {
  const root = fixture(t);
  const inventory = execute({ root }, "ingestion_definition_read", {});
  assert.equal(inventory.ok, true, JSON.stringify(inventory.diagnostics));
  const before = readFileSync(join(root, "project.yaml"), "utf8");
  const input = { revision: inventory.result.revision, definition };
  const review = execute({ root }, "ingestion_definition_review", input);
  assert.equal(review.ok, true, JSON.stringify(review.diagnostics));
  const request = {
    input: review.result.input,
    proposalId: review.result.proposal.id,
  };
  assert.equal(
    execute({ root }, "ingestion_definition_apply", request).ok,
    false,
  );
  assert.equal(
    execute({ root, allowWrite: true }, "ingestion_definition_apply", {
      ...request,
      proposalId: "0".repeat(64),
    }).ok,
    false,
  );
  const saved = execute(
    { root, allowWrite: true },
    "ingestion_definition_apply",
    request,
  );
  assert.equal(saved.ok, true, JSON.stringify(saved.diagnostics));
  assert.equal(saved.result.definitions[0].definition.status, "draft");
  assert.equal(readFileSync(join(root, "project.yaml"), "utf8"), before);
  assert.equal(
    execute({ root, allowWrite: true }, "ingestion_definition_apply", request)
      .ok,
    false,
  );
  assert.equal(
    execute({ root }, "ingestion_definition_review", input).ok,
    false,
  );
});
test("portable contracts reject target details, traversal, duplicate identities and invalid field references", (t) => {
  const root = fixture(t);
  const obj = {
    id: "sales.orders",
    kind: "table",
    fields: [{ path: "id", logicalType: "integer", origin: "declared" }],
    mapping: [{ source: "id", output: "id" }],
  };
  for (const value of [
    { ...definition, target: { connection: "warehouse" } },
    { ...definition, apiVersion: "ingestron.ingestion-definition/v2" },
    { ...definition, id: "../outside" },
    { ...definition, status: "reviewed" },
    { ...definition, objects: [obj, obj] },
    {
      ...definition,
      objects: [{ ...obj, mapping: [{ source: "missing", output: "x" }] }],
    },
    {
      ...definition,
      objects: [
        {
          ...obj,
          metadata: [
            {
              name: "id",
              logicalType: "string",
              value: { kind: "literal", value: "duplicate" },
            },
          ],
        },
      ],
    },
    {
      ...definition,
      objects: [
        {
          ...obj,
          metadata: [
            {
              name: "file",
              logicalType: "string",
              value: { kind: "source-path" },
            },
          ],
        },
      ],
    },
    {
      ...definition,
      source: { id: "crm", connector: { id: "sql", version: "latest" } },
    },
  ])
    assert.equal(
      execute({ root }, "ingestion_contract_check", { value }).ok,
      false,
      JSON.stringify(value),
    );
  const valid = execute({ root }, "ingestion_contract_check", {
    value: { ...definition, objects: [obj] },
  });
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));
  assert.equal(valid.result.qualitySemantics, "portable-conditions-checked");
});
test("discovery and draft contracts keep unknown types and exclude raw samples and review tokens", (t) => {
  const root = fixture(t);
  const snapshot = {
    apiVersion: "ingestron.discovery-snapshot/v1",
    id: "scan1",
    source: "crm",
    connector: { id: "sql", version: "1.0.0" },
    collectedAt: "2026-10-16T00:00:00Z",
    coverage: { scope: "selected tables", complete: false },
    objects: [
      {
        id: "opaque",
        kind: "collection",
        fields: [{ path: "value", logicalType: "unknown", origin: "unknown" }],
      },
    ],
  };
  for (const value of [
    snapshot,
    {
      apiVersion: "ingestron.ingestion-draft/v1",
      project: "retail",
      baseRevision: "0".repeat(64),
      definition,
      context: {},
    },
  ])
    assert.equal(
      execute({ root }, "ingestion_contract_check", { value }).ok,
      true,
    );
  assert.equal(
    execute({ root }, "ingestion_contract_check", {
      value: { ...snapshot, samples: [{ name: "private" }] },
    }).ok,
    false,
  );
});

test("480-object portable draft preserves custom quality intent without claiming semantic validity", (t) => {
  const root = fixture(t);
  const objects = Array.from({ length: 480 }, (_, i) => ({
    id: `catalogue.object_${i}`,
    kind: i % 2 ? "table" : "file-group",
    fields: [{ path: "id", logicalType: "unknown", origin: "unknown" }],
    mapping: [{ source: "id", output: "record_id" }],
    quality: [
      {
        type: "custom",
        engine: "future-engine",
        implementation: "opaque rule",
        vendor: { retain: true },
      },
    ],
    metadata: [
      {
        name: "source_object",
        logicalType: "string",
        value: { kind: "source-object" },
      },
    ],
  }));
  const revision = execute({ root }, "ingestion_definition_read", {}).result
    .revision;
  const review = execute({ root }, "ingestion_definition_review", {
    revision,
    definition: { ...definition, objects },
  });
  assert.equal(
    review.ok,
    false,
    "Object definitions require saved discovery in D3",
  );
  const checked = execute({ root }, "ingestion_contract_check", {
    value: { ...definition, objects },
  });
  assert.equal(checked.ok, true);
  assert.equal(checked.result.qualitySemantics, "portable-conditions-checked");
});
