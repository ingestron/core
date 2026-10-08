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
      document,
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
