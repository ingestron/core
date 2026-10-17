import { test } from "node:test";
import assert from "node:assert/strict";
import {
  programmeSchema,
  type Programme,
} from "../../src/core/programme-schema.js";
import { withWorkItemKeys } from "../../src/core/programme-keys.js";
import {
  requirementsTemplate,
  requirementStarters,
} from "../../src/core/requirements-catalogue.js";
const document = programmeSchema.parse({
  apiVersion: "ingestron.programme/v1",
  id: "retail",
  name: "Retail",
  objective: "",
  sponsor: "ion",
  stakeholders: [],
  projects: [{ id: "orders", name: "Orders", platformId: "lakehouse" }],
  platforms: [{ id: "lakehouse", name: "Lakehouse" }],
  requirements: [],
});
test("human keys preserve references and remain stable through deletion and append", () => {
  const item = (id: string) => ({
    id,
    title: "Task",
    description: "",
    owner: "ion",
    priority: "must" as const,
    disposition: "draft" as const,
    acceptance: [],
    projectIds: [],
    kind: "task" as const,
  });
  const first = withWorkItemKeys({
    ...document,
    requirements: [
      item("WBS-02b79834c9ca04338f88"),
      {
        ...item("WBS-other-long-internal-id"),
        dependsOn: ["WBS-02b79834c9ca04338f88"],
      },
      item("REQ-1"),
    ],
  });
  assert.deepEqual(
    first.requirements.map((r) => r.key),
    ["WBS-001", "WBS-002", "REQ-1"],
  );
  const second = withWorkItemKeys({
    ...first,
    requirements: [
      first.requirements[1]!,
      first.requirements[2]!,
      item("WBS-another-long-internal-id"),
    ],
  });
  assert.deepEqual(
    second.requirements.map((r) => r.key),
    ["WBS-002", "REQ-1", "WBS-003"],
  );
  assert.deepEqual(second.requirements[0]?.dependsOn, [
    "WBS-02b79834c9ca04338f88",
  ]);
  const collision = withWorkItemKeys({
    ...document,
    requirements: [
      { ...item("long-internal-identifier"), key: "REQ-1" },
      item("REQ-1"),
    ],
  });
  assert.equal(new Set(collision.requirements.map((r) => r.key)).size, 2);
});
test("each owner receives a distinct catalogue and selected starters are idempotent drafts", () => {
  for (const area of [
    { kind: "programme", id: "retail" },
    { kind: "platform", id: "lakehouse" },
    { kind: "project", id: "orders" },
  ] as const) {
    const available = requirementStarters(document, area);
    assert.ok(available.length >= 3);
    const input = {
      id: "retail",
      document,
      area,
      owner: "ion",
      selected: available.map((s) => s.id),
    };
    const first = requirementsTemplate(input);
    assert.equal(first.document.requirements.length, available.length);
    assert.ok(
      first.document.requirements.every(
        (r) =>
          r.area?.kind === area.kind &&
          r.area.id === area.id &&
          r.owner === "ion" &&
          r.disposition === "draft" &&
          r.key,
      ),
    );
    assert.deepEqual(
      requirementsTemplate({ ...input, document: first.document }).document,
      first.document,
    );
    assert.equal(document.requirements.length, 0);
  }
  assert.throws(() =>
    requirementStarters(document, { kind: "project", id: "missing" }),
  );
  assert.throws(() =>
    requirementsTemplate({
      id: "retail",
      document,
      area: { kind: "programme", id: "retail" },
      owner: "ion",
      selected: ["not-a-starter"],
    }),
  );
});

test("starter suggestions respect assigned target capabilities and policies", () => {
  const target = (provider: string) => ({
    provider,
    capabilities: {},
    policies: { "secret-references": "enabled" },
    naming: {},
    environments: [],
  });
  const configured = programmeSchema.parse({
    ...document,
    platforms: [
      {
        id: "lakehouse",
        name: "Lakehouse",
        configuration: { targets: [target("adf"), target("databricks")] },
      },
    ],
    projects: [
      {
        id: "orders",
        name: "Orders",
        platformId: "lakehouse",
        targets: [{ provider: "adf", responsibilities: ["ingestion"] }],
      },
    ],
  });
  const project = requirementStarters(configured, {
    kind: "project",
    id: "orders",
  });
  assert.ok(
    !project.some((s) => s.id.includes("-policy-")),
    "Shared policies remain platform-owned",
  );
  assert.ok(!project.some((s) => s.id.startsWith("databricks-")));
  const shared = requirementStarters(configured, {
    kind: "platform",
    id: "lakehouse",
  });
  assert.ok(shared.some((s) => s.id === "databricks-policy-secret-references"));
  assert.ok(
    !requirementStarters(configured, { kind: "programme", id: "retail" }).some(
      (s) => s.id.startsWith("adf-"),
    ),
  );
});
