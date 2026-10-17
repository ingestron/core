import { test } from "node:test";
import assert from "node:assert/strict";
import fs, {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { execute } from "../../src/core/operations.js";

function setup(t: any) {
  const root = mkdtempSync(join(tmpdir(), "programme-yaml-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const document: any = {
    apiVersion: "ingestron.programme/v1",
    id: "retail",
    name: "Retail",
    objective: "Daily **margin**\n\nPreserve reviewed intent.",
    sponsor: "Owner",
    people: ["Architect"],
    stakeholders: [{ name: "Owner", role: "Sponsor" }],
    projects: [
      {
        id: "PLAN-1",
        compilerId: "sales",
        name: "Sales",
        platformId: "PLAT-1",
        targets: [
          { provider: "databricks", responsibilities: ["transformation"] },
        ],
      },
      {
        id: "PLAN-2",
        compilerId: "inventory",
        name: "Inventory",
        platformId: "PLAT-1",
      },
    ],
    platforms: [
      {
        id: "PLAT-1",
        name: "Retail platform",
        configuration: {
          environments: [
            { name: "dev", purpose: "development" },
            { name: "test", purpose: "test" },
          ],
          targets: [
            {
              provider: "databricks",
              generation: { qualityFailure: "block" },
              capabilities: {},
              policies: {},
              naming: { table: "{dataset}" },
              environments: [
                {
                  name: "dev",
                  purpose: "development",
                  authentication: "databricks-cli",
                  configuration: { workspaceUrl: "https://synthetic.invalid" },
                  secrets: [
                    { name: "SYNTHETIC_TOKEN_REFERENCE", source: "local-env" },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
    requirements: [
      {
        id: "REQ-1",
        key: "REQ-1",
        kind: "requirement",
        title: "Daily margin",
        description: "Retain **Markdown** and links.",
        owner: "Architect",
        priority: "must",
        disposition: "ready",
        acceptance: ["Totals match"],
        projectIds: ["PLAN-1", "PLAN-2"],
      },
    ],
  };
  const raw = JSON.stringify(document, null, 4) + "\n\n";
  writeFileSync(join(root, "programme.json"), raw);
  const run = (
    operation: string,
    args: any = { id: "retail" },
    write = false,
  ) => execute({ root, allowWrite: write }, operation as any, args);
  const read = () => run("programme_read");
  const review = () => {
    const r = run("programme_migration_review", {
      id: "retail",
      direction: "to-yaml",
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.result;
  };
  const apply = (proposal: any, write = true) =>
    run("programme_migration_apply", { id: "retail", proposal }, write);
  return { root, document, raw, run, read, review, apply };
}
test("reviewed split YAML preserves identities, shared profiles, secret references and exact JSON rollback", (t) => {
  const f = setup(t),
    before = f.read().result.document,
    definition = f.run("programme_definition_inspect").result;
  const proposal = f.review();
  assert.equal(existsSync(join(f.root, "programme.yaml")), false);
  assert.ok(
    proposal.changes.some(
      (c: any) =>
        c.path === "platforms/PLAT-1/environments/databricks/dev.yaml",
    ),
  );
  assert.equal(f.apply(proposal, false).diagnostics[0].code, "PERMISSION");
  const applied = f.apply(proposal);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(existsSync(join(f.root, "programme.json")), false);
  assert.equal(readFileSync(join(f.root, proposal.backup), "utf8"), f.raw);
  assert.deepEqual(f.read().result.document, before);
  const after = f.run("programme_definition_inspect").result;
  assert.equal(after.definitionDigest, definition.definitionDigest);
  assert.deepEqual(after.platforms, definition.platforms);
  const inspected = f.run("programme_storage_inspect");
  assert.equal(inspected.ok, true);
  assert.equal(inspected.result.format, "yaml");
  assert.equal(inspected.result.rollback[0].eligible, true);
  const saved = f.run(
    "programme_save",
    { id: "retail", expectedDigest: f.read().result.digest, document: before },
    true,
  );
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.result.digest, applied.result.digest);
  const rollback = f.run("programme_migration_review", {
    id: "retail",
    direction: "restore-json",
    migration: proposal.migration,
  });
  assert.equal(rollback.ok, true, JSON.stringify(rollback));
  assert.equal(f.apply(rollback.result).ok, true);
  assert.equal(readFileSync(join(f.root, "programme.json"), "utf8"), f.raw);
  assert.equal(existsSync(join(f.root, "programme.yaml")), false);
  assert.equal(
    f.apply(f.review()).ok,
    true,
    "An unchanged prior backup can be reused after rollback",
  );
});
test("migration rejects changed reviews, colliding files, ambiguity and unreviewed rollback edits", (t) => {
  const f = setup(t),
    proposal = f.review();
  assert.equal(
    f.apply({ ...proposal, workItems: 99 }).diagnostics[0].code,
    "STALE",
  );
  writeFileSync(join(f.root, "programme.json"), f.raw + "\n");
  assert.equal(f.apply(proposal).diagnostics[0].code, "STALE");
  writeFileSync(join(f.root, "programme.json"), f.raw);
  mkdirSync(join(f.root, "planning"));
  writeFileSync(join(f.root, "planning/requirements.yaml"), "User owned\n");
  assert.equal(
    f.run("programme_migration_review", { id: "retail", direction: "to-yaml" })
      .diagnostics[0].code,
    "OWNER",
  );
  rmSync(join(f.root, "planning/requirements.yaml"));
  assert.equal(f.apply(proposal).ok, true);
  writeFileSync(join(f.root, "programme.json"), f.raw);
  assert.equal(f.read().diagnostics[0].code, "AMBIGUOUS");
  rmSync(join(f.root, "programme.json"));
  const changed = { ...f.read().result.document, objective: "Later work" };
  const saved = f.run(
    "programme_save",
    { id: "retail", expectedDigest: f.read().result.digest, document: changed },
    true,
  );
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(
    f.run("programme_migration_review", {
      id: "retail",
      direction: "restore-json",
      migration: proposal.migration,
    }).diagnostics[0].code,
    "STALE",
  );
  assert.equal(
    f.run("programme_storage_inspect").result.rollback[0].eligible,
    false,
  );
});
test("YAML saves preserve comments and unchanged file bytes and reject stale fragment changes", (t) => {
  const f = setup(t);
  assert.equal(f.apply(f.review()).ok, true);
  const rootFile = join(f.root, "programme.yaml"),
    profileFile = join(
      f.root,
      "platforms/PLAT-1/environments/databricks/dev.yaml",
    ),
    requirementsFile = join(f.root, "planning/requirements.yaml");
  writeFileSync(
    rootFile,
    "# Programme owner note\n" + readFileSync(rootFile, "utf8"),
  );
  writeFileSync(
    profileFile,
    "# Profile owner note\n" + readFileSync(profileFile, "utf8"),
  );
  writeFileSync(
    requirementsFile,
    readFileSync(requirementsFile, "utf8").replace(
      "title: Daily margin",
      "title: Daily margin # Reviewed title",
    ),
  );
  const profile = readFileSync(profileFile, "utf8"),
    before = f.read().result;
  const changed = structuredClone(before.document);
  changed.requirements[0].description = "Updated acceptance discussion";
  changed.requirements[0].title = "Daily margin revised";
  const saved = f.run(
    "programme_save",
    { id: "retail", expectedDigest: before.digest, document: changed },
    true,
  );
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(readFileSync(profileFile, "utf8"), profile);
  assert.match(readFileSync(rootFile, "utf8"), /# Programme owner note/);
  assert.match(readFileSync(requirementsFile, "utf8"), /# Reviewed title/);
  const stale = f.read().result;
  writeFileSync(profileFile, profile + "\n# Changed externally\n");
  assert.equal(
    f.run(
      "programme_save",
      { id: "retail", expectedDigest: stale.digest, document: stale.document },
      true,
    ).diagnostics[0].code,
    "CONFLICT",
  );
  const remapped = structuredClone(f.read().result.document);
  remapped.projects[0].compilerId = "other";
  assert.equal(
    f.run(
      "programme_save",
      {
        id: "retail",
        expectedDigest: f.read().result.digest,
        document: remapped,
      },
      true,
    ).diagnostics[0].code,
    "CONFLICT",
  );
});
test("invalid references, aliases, incomplete profiles and duplicate identities fail closed", (t) => {
  const f = setup(t);
  assert.equal(f.apply(f.review()).ok, true);
  const file = join(f.root, "programme.yaml"),
    original = readFileSync(file, "utf8");
  for (const path of [
    "../outside.yaml",
    "./planning/../planning/requirements.yaml",
    "https://example.invalid/data.yaml",
    "./programme.yaml",
  ]) {
    const d = parseDocument(original);
    d.setIn(["requirements", "$resolve"], path);
    writeFileSync(file, d.toString());
    assert.equal(f.read().ok, false, path);
  }
  writeFileSync(file, original + "\nname: duplicate\n");
  assert.equal(f.read().diagnostics[0].code, "YAML");
  writeFileSync(file, original.replace("name: Retail", "name: &retail Retail"));
  assert.equal(f.read().diagnostics[0].code, "YAML");
  writeFileSync(file, original);
  const profile = join(
      f.root,
      "platforms/PLAT-1/environments/databricks/dev.yaml",
    ),
    raw = readFileSync(profile, "utf8");
  writeFileSync(profile, raw.replace("authentication: databricks-cli\n", ""));
  assert.equal(f.read().ok, false);
  rmSync(profile);
  symlinkSync(join(f.root, "missing.yaml"), profile);
  assert.equal(f.read().diagnostics[0].code, "PATH");
  rmSync(profile);
  writeFileSync(profile, raw);
  const d = parseDocument(original);
  d.set("platforms", [
    d.getIn(["platforms", 0]).toJSON(),
    d.getIn(["platforms", 0]).toJSON(),
  ]);
  writeFileSync(file, d.toString());
  assert.equal(f.read().ok, false);
});
test("failed multi-file migration restores original bytes and external readers never accept partial state", (t) => {
  const f = setup(t),
    proposal = f.review();
  const originalRename = fs.renameSync;
  let calls = 0;
  fs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
    if (++calls === 3) throw Error("Synthetic interrupted replacement");
    return originalRename(...args);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    assert.equal(f.apply(proposal).ok, false);
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(join(f.root, "programme.json"), "utf8"), f.raw);
  assert.equal(existsSync(join(f.root, "programme.yaml")), false);
  assert.equal(existsSync(join(f.root, "planning/requirements.yaml")), false);
  assert.equal(f.apply(proposal).ok, true);
  writeFileSync(join(f.root, ".programme-write.lock"), "other writer");
  assert.equal(f.read().diagnostics[0].code, "BUSY");
  rmSync(join(f.root, ".programme-write.lock"));
});

test("programme file schemas are inspectable and failures during YAML save restore every affected file", (t) => {
  const f = setup(t);
  for (const name of [
    "programme",
    "programme-manifest",
    "platform-definition",
    "platform-environment",
    "requirements-definition",
  ]) {
    const schema = f.run("schema", { name });
    assert.equal(schema.ok, true, JSON.stringify(schema));
    assert.equal(schema.result.type, "object");
  }
  assert.equal(f.apply(f.review()).ok, true);
  const before = f.read().result;
  const changed = structuredClone(before.document);
  changed.name = "Different name";
  changed.requirements[0].description = "Different text";
  const originalRename = fs.renameSync;
  let calls = 0;
  fs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
    if (++calls === 2) throw Error("Synthetic save replacement failure");
    return originalRename(...args);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    assert.equal(
      f.run(
        "programme_save",
        { id: "retail", expectedDigest: before.digest, document: changed },
        true,
      ).ok,
      false,
    );
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
  assert.deepEqual(f.read().result, before);
});
