import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { execute } from "../../src/core/operations.js";
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "discovery-d2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const init = execute({ root }, "workspace_initialisation_review", {
    mode: "project",
    project: { id: "retail", name: "Retail", outcome: "Explore" },
  });
  assert.equal(
    execute({ root, allowWrite: true }, "workspace_initialisation_apply", {
      input: init.result.input,
      proposal: init.result.proposal,
    }).ok,
    true,
  );
  const p = parse(readFileSync(join(root, "project.yaml"), "utf8"));
  p.packages = {
    source: { source: "example/source/connector.yaml", version: "1.0.0" },
  };
  p.connections = {
    sales: {
      package: "source",
      sourceId: "sales",
      tenantId: "demo",
      settings: { host: "db.example.invalid" },
    },
  };
  writeFileSync(join(root, "project.yaml"), stringify(p));
  return root;
}
const snapshot = {
  apiVersion: "ingestron.discovery-snapshot/v1",
  id: "snapshot_1",
  source: "sales",
  connector: { id: "example/source/connector.yaml", version: "1.0.0" },
  collectedAt: "2026-10-16T00:00:00Z",
  coverage: { scope: "Selected source objects", complete: false },
  objects: [
    {
      id: "sales.orders",
      kind: "table",
      fields: [
        {
          path: "id",
          logicalType: "unknown",
          nativeType: "vendor-id",
          precision: 18,
          scale: 2,
          origin: "unknown",
        },
      ],
    },
  ],
};
function review(root: string, document: any, extra = {}) {
  const inventory = execute({ root }, "discovery_read", {
    connection: "sales",
  });
  assert.equal(inventory.ok, true, JSON.stringify(inventory.diagnostics));
  return execute({ root }, "discovery_review", {
    connection: "sales",
    revision: inventory.result.revision,
    document: JSON.stringify(document),
    ...extra,
  });
}
test("offline import binds source/version, persists immutable metadata and remains readable after source changes", (t) => {
  const root = fixture(t),
    before = readFileSync(join(root, "project.yaml"), "utf8");
  const r = review(root, snapshot);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const request = { input: r.result.input, proposalId: r.result.proposal.id };
  assert.equal(execute({ root }, "discovery_apply", request).ok, false);
  assert.equal(
    execute({ root, allowWrite: true }, "discovery_apply", {
      ...request,
      proposalId: "0".repeat(64),
    }).ok,
    false,
  );
  const saved = execute({ root, allowWrite: true }, "discovery_apply", request);
  assert.equal(saved.ok, true, JSON.stringify(saved.diagnostics));
  assert.equal(
    saved.result.snapshot.objects[0].fields[0].logicalType,
    "unknown",
  );
  assert.equal(saved.result.snapshot.objects[0].fields[0].precision, 18);
  assert.equal(saved.result.snapshot.objects[0].fields[0].scale, 2);
  assert.equal(readFileSync(join(root, "project.yaml"), "utf8"), before);
  assert.equal(review(root, snapshot).ok, false);
  writeFileSync(
    join(root, "project.yaml"),
    before.replace("db.example.invalid", "changed.example.invalid"),
  );
  const reopened = execute({ root }, "discovery_read", {
    connection: "sales",
    snapshot: snapshot.id,
  });
  assert.equal(reopened.ok, true);
  assert.equal(reopened.result.snapshots[0].current, false);
});
test("source families, 480 objects, nested paths, provenance and optional sample privacy", (t) => {
  const root = fixture(t);
  const doc = {
    ...snapshot,
    objects: Array.from({ length: 480 }, (_, i) => ({
      ...snapshot.objects[0],
      id: `object_${i}`,
      kind: ["table", "view", "file-group", "endpoint", "collection", "topic"][
        i % 6
      ],
      fields: [
        { path: "customer.id", logicalType: "unknown", origin: "inferred" },
      ],
      metadataComplete: false,
      cursors: ["customer.id"],
    })),
  };
  const bundle = {
    apiVersion: "ingestron.discovery-bundle/v1",
    snapshot: doc,
    samples: [
      {
        object: "object_0",
        columns: ["customer.id"],
        rows: [["synthetic-row-only"]],
        truncated: true,
      },
    ],
  };
  assert.equal(review(root, bundle).ok, false);
  const r = review(root, bundle, { allowSamples: true });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.equal(r.result.samples[0].rows.length, 1);
  assert.equal(
    JSON.stringify(r.result.input).includes("synthetic-row-only"),
    false,
  );
  assert.equal(
    JSON.stringify(r.result.proposal).includes("synthetic-row-only"),
    false,
  );
  const saved = execute({ root, allowWrite: true }, "discovery_apply", {
    input: r.result.input,
    proposalId: r.result.proposal.id,
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.result.snapshot.objects.length, 480);
  assert.equal(
    readFileSync(
      join(root, r.result.proposal.changes[0].path),
      "utf8",
    ).includes("synthetic-row-only"),
    false,
  );
  for (const samples of [
    [{ ...bundle.samples[0], columns: ["unknown"] }],
    [{ ...bundle.samples[0], rows: [[1, 2]] }],
    [bundle.samples[0], bundle.samples[0]],
  ])
    assert.equal(
      review(
        root,
        { ...bundle, snapshot: { ...doc, id: "bad" }, samples },
        { allowSamples: true },
      ).ok,
      false,
    );
});
test("invalid, duplicate, oversize, wrong binding, stale and symlink imports are refused", (t) => {
  const root = fixture(t);
  for (const doc of [
    { ...snapshot, source: "other" },
    { ...snapshot, environment: "prod" },
    { ...snapshot, connector: { ...snapshot.connector, version: "2.0.0" } },
    { ...snapshot, apiVersion: "unknown" },
    { ...snapshot, objects: [...snapshot.objects, ...snapshot.objects] },
    { ...snapshot, target: {} },
    { ...snapshot, objects: [{ ...snapshot.objects[0], keys: ["missing"] }] },
  ])
    assert.equal(review(root, doc).ok, false, JSON.stringify(doc));
  const r = review(root, snapshot);
  assert.equal(r.ok, true);
  writeFileSync(
    join(root, "project.yaml"),
    readFileSync(join(root, "project.yaml"), "utf8") + "\n# changed\n",
  );
  assert.equal(
    execute({ root, allowWrite: true }, "discovery_apply", {
      input: r.result.input,
      proposalId: r.result.proposal.id,
    }).ok,
    false,
  );
  const revision = execute({ root }, "discovery_read", { connection: "sales" })
    .result.revision;
  for (const document of [
    "id: one\nid: two",
    "a: &a [*a]",
    "x".repeat(2 * 1024 * 1024 + 1),
  ])
    assert.equal(
      execute({ root }, "discovery_review", {
        connection: "sales",
        revision,
        document,
      }).ok,
      false,
    );
  mkdirSync(join(root, "discovery/dev"), { recursive: true });
  symlinkSync(tmpdir(), join(root, "discovery/dev/sales"));
  assert.equal(
    execute({ root }, "discovery_read", { connection: "sales" }).ok,
    false,
  );
});
