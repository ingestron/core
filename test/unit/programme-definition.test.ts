import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execute } from "../../src/core/operations.js";

test("programme identity review preserves plan IDs and rejects stale, duplicate and reassigned registrations", () => {
  const root = mkdtempSync(join(tmpdir(), "programme-definition-"));
  const run = (operation: string, args: unknown, allowWrite = false) =>
    execute({ root, allowWrite }, operation, args);
  const document = {
    apiVersion: "ingestron.programme/v1",
    id: "retail",
    name: "Retail",
    objective: "Daily margin",
    sponsor: "Owner",
    stakeholders: [],
    requirements: [],
    projects: [
      { id: "legacy-uri-hash-1", name: "Sales", platformId: "PLAT-1" },
      { id: "legacy-uri-hash-2", name: "Inventory", platformId: "PLAT-1" },
    ],
    platforms: [{ id: "PLAT-1", name: "Shared data" }],
  };
  try {
    assert.equal(
      run("programme_definition_inspect", { id: "retail" }).ok,
      false,
    );
    const saved = run(
      "programme_save",
      { id: "retail", expectedDigest: null, document },
      true,
    );
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const original = readFileSync(join(root, "programme.json"), "utf8");
    const inspect = () =>
      run("programme_definition_inspect", { id: "retail" }).result;
    const first = inspect();
    assert.equal(first.projects[0].compilerId, null);
    assert.equal(first.projects[0].planId, document.projects[0].id);
    assert.equal(first.projects[0].platformId, "PLAT-1");
    assert.equal(first.executionEnabled, false);
    const propose = (
      project: string,
      compilerId: string,
      expectedDigest = saved.result.digest,
    ) =>
      run("programme_registration_propose", {
        id: "retail",
        project,
        compilerId,
        expectedDigest,
      });
    const proposal = propose("legacy-uri-hash-1", "sales-margin");
    assert.equal(proposal.ok, true, JSON.stringify(proposal));
    assert.equal(readFileSync(join(root, "programme.json"), "utf8"), original);
    assert.equal(propose("unknown", "sales-margin").ok, false);
    for (const compilerId of [
      "__proto__",
      "constructor",
      "../sales",
      "",
      "a".repeat(81),
    ]) {
      assert.equal(propose("legacy-uri-hash-1", compilerId).ok, false);
    }
    const payload = {
      id: "retail",
      expectedDigest: proposal.result.expectedDigest,
      document: proposal.result.document,
    };
    assert.equal(
      run("programme_save", payload).diagnostics[0]?.code,
      "PERMISSION",
    );
    const applied = run("programme_save", payload, true);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(
      run("programme_save", payload, true).diagnostics[0]?.code,
      "CONFLICT",
    );
    assert.equal(
      propose("legacy-uri-hash-2", "inventory").diagnostics[0]?.code,
      "CONFLICT",
    );
    assert.equal(
      propose("legacy-uri-hash-2", "sales-margin", applied.result.digest)
        .diagnostics[0]?.code,
      "SCHEMA",
    );
    assert.equal(
      propose("legacy-uri-hash-1", "different", applied.result.digest)
        .diagnostics[0]?.code,
      "CONFLICT",
    );
    assert.equal(
      run(
        "programme_save",
        { id: "retail", expectedDigest: applied.result.digest, document },
        true,
      ).diagnostics[0]?.code,
      "CONFLICT",
    );
    assert.deepEqual(applied.result.document.projects[1], document.projects[1]);
    assert.deepEqual(applied.result.document.platforms, document.platforms);
    assert.deepEqual(
      inspect().projects.map((p: any) => p.planId),
      document.projects.map((p) => p.id),
    );
    const beforeWhitespace = inspect();
    writeFileSync(
      join(root, "programme.json"),
      JSON.stringify(applied.result.document),
    );
    assert.equal(inspect().definitionDigest, beforeWhitespace.definitionDigest);
    assert.notEqual(inspect().sourceDigest, beforeWhitespace.sourceDigest);
    assert.equal(
      inspect().platforms[0].definitionDigest,
      first.platforms[0].definitionDigest,
    );
    assert.equal(
      run("programme_definition_inspect", { id: "other" }).ok,
      false,
    );
    assert.equal(
      run("programme_definition_inspect", { id: "retail", root: "/tmp" }).ok,
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
