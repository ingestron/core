import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../../src/core/operations.js";
const doc = {
  apiVersion: "ingestron.programme/v1",
  id: "retail",
  name: "Retail",
  objective: "Reconcile orders",
  sponsor: "Owner",
  stakeholders: [],
  projects: [{ id: "orders", name: "Orders" }],
  requirements: [
    {
      id: "REQ-1",
      title: "Daily orders",
      description: "Finance reconciles orders",
      owner: "Analyst",
      priority: "must",
      disposition: "ready",
      acceptance: ["Totals match source"],
      projectIds: ["orders"],
    },
  ],
};
test("programme intent is saved independently of a project with permission and stale-write protection", () => {
  const root = mkdtempSync(join(tmpdir(), "programme-"));
  try {
    const read = () => execute({ root }, "programme_read", { id: "retail" });
    assert.deepEqual(read().result, { document: null, digest: null });
    const save = (
      document = doc,
      expectedDigest: string | null = null,
      allowWrite = true,
    ) =>
      execute({ root, allowWrite }, "programme_save", {
        id: "retail",
        document,
        expectedDigest,
      });
    assert.equal(save(doc, null, false).diagnostics[0]?.code, "PERMISSION");
    const first = save();
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual(read().result, first.result);
    assert.equal(save().diagnostics[0]?.code, "CONFLICT");
    const changed = save({ ...doc, name: "Retail 2" }, first.result.digest);
    assert.equal(changed.ok, true);
    assert.equal(read().result.document.name, "Retail 2");
    assert.equal(
      save({ ...doc, id: "other" }, changed.result.digest).diagnostics[0]?.code,
      "PROGRAMME",
    );
    assert.equal(
      execute({ root }, "programme_read", { id: "other" }).diagnostics[0]?.code,
      "PROGRAMME",
    );
    assert.equal(
      save(
        { ...doc, requirements: [{ ...doc.requirements[0]!, owner: "" }] },
        changed.result.digest,
      ).diagnostics[0]?.code,
      "SCHEMA",
    );
    assert.equal(
      save(
        {
          ...doc,
          requirements: [{ ...doc.requirements[0]!, projectIds: ["outside"] }],
        },
        changed.result.digest,
      ).diagnostics[0]?.code,
      "SCHEMA",
    );
    assert.equal(
      save(
        { ...doc, projects: [doc.projects[0]!, doc.projects[0]!] },
        changed.result.digest,
      ).diagnostics[0]?.code,
      "SCHEMA",
    );
    assert.equal(read().result.digest, changed.result.digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("programme rejects symlink destinations and preserves malformed files", () => {
  const root = mkdtempSync(join(tmpdir(), "programme-"));
  const other = join(root, "other.json"),
    file = join(root, "programme.json");
  try {
    writeFileSync(other, JSON.stringify(doc));
    symlinkSync(other, file);
    assert.equal(
      execute({ root }, "programme_read", { id: "retail" }).diagnostics[0]
        ?.code,
      "PATH",
    );
    assert.equal(
      execute({ root, allowWrite: true }, "programme_save", {
        id: "retail",
        expectedDigest: null,
        document: doc,
      }).ok,
      false,
    );
    assert.equal(readFileSync(other, "utf8"), JSON.stringify(doc));
    rmSync(file);
    writeFileSync(file, "broken");
    assert.equal(
      execute({ root, allowWrite: true }, "programme_save", {
        id: "retail",
        expectedDigest: null,
        document: doc,
      }).ok,
      false,
    );
    assert.equal(readFileSync(file, "utf8"), "broken");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("programme work hierarchy, milestones, areas and external IDs preserve sync identity", () => {
  const root = mkdtempSync(join(tmpdir(), "programme-hierarchy-"));
  const make = (id: string, kind: string, extra = {}) => ({
    ...doc.requirements[0],
    id,
    kind,
    ...extra,
  });
  const document = {
    ...doc,
    platforms: [{ id: "data-platform", name: "Data platform" }],
    requirements: [
      make("EPIC-1", "epic"),
      make("REQ-1", "requirement", {
        parentId: "EPIC-1",
        area: { kind: "platform", id: "data-platform" },
        milestoneId: "MS-1",
        externalRefs: [
          { system: "jira", container: "DATA", id: "DATA-12", revision: "1" },
        ],
      }),
      make("TASK-1", "task", {
        parentId: "REQ-1",
        area: { kind: "project", id: "orders" },
      }),
      make("MS-1", "milestone", {
        due: "2026-12-01",
        area: { kind: "programme", id: "retail" },
      }),
    ],
  };
  try {
    const save = (value: unknown, digest: string | null = null) =>
      execute({ root, allowWrite: true }, "programme_save", {
        id: "retail",
        expectedDigest: digest,
        document: value,
      });
    const first = save(document);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual(
      execute({ root }, "programme_read", { id: "retail" }).result.document,
      {
        ...document,
        nextWorkItemNumber: 1,
        requirements: document.requirements.map((r) => ({ ...r, key: r.id })),
      },
    );
    for (const patch of [
      { parentId: "TASK-1" },
      { parentId: "REQ-1" },
      { milestoneId: "TASK-1" },
      { area: { kind: "platform", id: "unknown" } },
      { due: "2026-02-30" },
    ]) {
      const invalid = {
        ...document,
        requirements: document.requirements.map((r) =>
          r.id === "REQ-1" ? { ...r, ...patch } : r,
        ),
      };
      assert.equal(
        save(invalid, first.result.digest).diagnostics[0]?.code,
        "SCHEMA",
      );
    }
    const dangling = {
      ...document,
      requirements: document.requirements.filter((r) => r.id !== "EPIC-1"),
    };
    assert.equal(
      save(dangling, first.result.digest).diagnostics[0]?.code,
      "SCHEMA",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("programme project references accept opaque workspace identities", () => {
  const root = mkdtempSync(join(tmpdir(), "programme-workspace-"));
  try {
    const document = {
      ...doc,
      projects: [{ id: "0123456789abcdef", name: "Workspace project" }],
      requirements: [
        {
          ...doc.requirements[0],
          projectIds: ["0123456789abcdef"],
          area: { kind: "project", id: "0123456789abcdef" },
        },
      ],
    };
    const saved = execute({ root, allowWrite: true }, "programme_save", {
      id: doc.id,
      expectedDigest: null,
      document,
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.deepEqual(
      execute({ root }, "programme_read", { id: doc.id }).result.document,
      {
        ...document,
        nextWorkItemNumber: 1,
        requirements: document.requirements.map((r) => ({ ...r, key: r.id })),
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("full data product template assigns scope, reuses shared work and proposes without writes", () => {
  const root = mkdtempSync(join(tmpdir(), "programme-template-"));
  try {
    const generate = (document: unknown, id: string) =>
      execute({ root }, "programme_project_template", {
        id: "retail",
        document,
        newProject: { id, name: id },
        platform: { id: "lakehouse", name: "Lakehouse" },
        owner: "ion",
        template: "full-data-product/v1",
      });
    const first = generate(doc, "one");
    assert.equal(first.ok, true, JSON.stringify(first));
    const plan = first.result.document;
    assert.equal(
      plan.projects.find((p: any) => p.id === "one").template,
      "full-data-product/v1",
    );
    assert.ok(
      plan.requirements.some(
        (r: any) =>
          r.area?.kind === "platform" && r.component === "connections",
      ),
    );
    assert.ok(
      plan.requirements.some(
        (r: any) => r.area?.kind === "project" && r.component === "ingestion",
      ),
    );
    assert.equal(
      execute({ root }, "programme_read", { id: "retail" }).result.document,
      null,
    );
    const second = generate(plan, "two");
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(
      second.result.document.requirements.filter(
        (r: any) => r.area?.kind === "platform",
      ).length,
      plan.requirements.filter((r: any) => r.area?.kind === "platform").length,
    );
    assert.equal(generate(plan, "one").ok, false);
    const save = execute({ root, allowWrite: true }, "programme_save", {
      id: "retail",
      expectedDigest: null,
      document: second.result.document,
    });
    assert.equal(save.ok, true, JSON.stringify(save));
    const task = plan.requirements.find(
      (r: any) => r.area?.kind === "project" && r.kind === "task",
    );
    task.dependsOn = [task.id];
    assert.equal(generate(plan, "three").ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selected catalogue records form traceable WBS work without claiming application", () => {
  const root = mkdtempSync(join(tmpdir(), "programme-basis-"));
  try {
    const document = {
      ...doc,
      people: ["ion", "Alex"],
      requirements: [
        ...doc.requirements,
        {
          ...doc.requirements[0],
          id: "POL-1",
          kind: "policy",
          title: "Retain data for 30 days",
          component: "ingestion",
        },
        {
          ...doc.requirements[0],
          id: "STD-1",
          kind: "standard",
          title: "Daily reconciliation",
        },
      ],
    };
    const input = {
      id: "retail",
      document,
      newProject: { id: "new", name: "New" },
      platform: { id: "lakehouse", name: "Lakehouse" },
      owner: "ion",
      template: "full-data-product/v1",
      selectedRecordIds: ["REQ-1", "POL-1"],
    };
    const result = execute({ root }, "programme_project_template", input);
    assert.equal(result.ok, true, JSON.stringify(result));
    const plan = result.result.document;
    assert.equal(
      plan.projects.find((p: any) => p.id === "new").platformId,
      "lakehouse",
    );
    const tasks = plan.requirements.filter((r: any) => r.basisIds?.length);
    assert.equal(tasks.length, 2);
    assert.ok(
      tasks.every((r: any) => r.disposition === "draft" && r.area.id === "new"),
    );
    assert.deepEqual(
      plan.requirements.find((r: any) => r.id === "POL-1").applications,
      [{ projectId: "new", status: "planned", evidence: "" }],
    );
    assert.equal(
      plan.requirements.find((r: any) => r.id === "STD-1").applications,
      undefined,
    );
    assert.equal(
      execute({ root }, "programme_project_template", {
        ...input,
        selectedRecordIds: ["missing"],
      }).ok,
      false,
    );
    assert.equal(
      execute({ root }, "programme_project_template", {
        ...input,
        selectedRecordIds: ["POL-1", "POL-1"],
      }).ok,
      false,
    );
    const save = (document: unknown) =>
      execute({ root, allowWrite: true }, "programme_save", {
        id: "retail",
        document,
        expectedDigest: null,
      });
    const policy = plan.requirements.find((r: any) => r.id === "POL-1");
    policy.applications[0].status = "applied";
    assert.equal(save(plan).diagnostics[0]?.code, "SCHEMA");
    policy.applications[0].evidence =
      "Reviewed retention configuration in change 12";
    const saved = save(plan);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.deepEqual(
      execute({ root }, "programme_read", { id: "retail" }).result.document
        .people,
      ["ion", "Alex"],
    );
    const removed = {
      ...plan,
      requirements: plan.requirements.filter((r: any) => r.id !== "POL-1"),
    };
    assert.equal(
      execute({ root, allowWrite: true }, "programme_save", {
        id: "retail",
        document: removed,
        expectedDigest: saved.result.digest,
      }).diagnostics[0]?.code,
      "SCHEMA",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
