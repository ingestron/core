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

function call(root: string, op: string, input: any, write = false) {
  const r = execute(
    { root, environment: "dev", allowWrite: write },
    op as any,
    input,
  );
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  return r.result;
}
function setup(t: any) {
  const root = fixture(t);
  const snapshot = {
    apiVersion: "ingestron.discovery-snapshot/v1",
    id: "catalogue",
    source: "sales",
    connector: { id: "example/source/connector.yaml", version: "1.0.0" },
    collectedAt: "2026-10-16T00:00:00Z",
    coverage: { scope: "480 objects", complete: false },
    objects: Array.from({ length: 480 }, (_, i) => ({
      id: `sales.object_${i}`,
      kind: i % 2 ? "table" : "file-group",
      fields: [
        { path: "nested.id", logicalType: "unknown", origin: "inferred" },
        { path: "nested_id", logicalType: "integer", origin: "declared" },
      ],
    })),
  };
  const inv = call(root, "discovery_read", { connection: "sales" });
  const rev = call(root, "discovery_review", {
    connection: "sales",
    revision: inv.revision,
    document: JSON.stringify(snapshot),
    allowSamples: false,
  });
  const saved = call(
    root,
    "discovery_apply",
    { input: rev.input, proposalId: rev.proposal.id },
    true,
  );
  const definition = call(root, "ingestion_discovery_adopt", {
    id: "retail",
    name: "Retail",
    description: "",
    connection: "sales",
    snapshot: "catalogue",
    sha256: saved.snapshots[0].sha256,
    objects: snapshot.objects.map((o) => o.id),
  }).definition;
  return { root, definition };
}
function save(root: string, definition: any, extra = {}) {
  const revision = call(root, "ingestion_definition_read", {}).revision;
  const r = call(root, "ingestion_definition_review", {
    revision,
    definition,
    ...extra,
  });
  return call(
    root,
    "ingestion_definition_apply",
    { input: r.input, proposalId: r.proposal.id },
    true,
  );
}
test("480 objects adopt exact saved fields, map names without collisions and preserve independent edits/custom quality", (t) => {
  const { root, definition } = setup(t);
  assert.deepEqual(
    definition.objects[0].mapping.map((m: any) => m.output),
    ["nested_id", "nested_id_2"],
  );
  definition.objects[0].mapping[0].output = "customer_id";
  definition.objects[0].quality = [
    { engine: "future", vendor: { retain: true } },
  ];
  definition.objects[0].metadata = [
    {
      name: "source_file",
      logicalType: "string",
      value: { kind: "source-path" },
    },
  ];
  const saved = save(root, definition);
  assert.equal(saved.definitions[0].definition.objects.length, 480);
  assert.equal(
    saved.definitions[0].definition.objects[1].mapping[0].output,
    "nested_id",
  );
  assert.deepEqual(
    saved.definitions[0].definition.objects[0].quality,
    definition.objects[0].quality,
  );
  for (const mutate of [
    (d: any) => (d.objects[0].fields[0].logicalType = "string"),
    (d: any) => (d.objects[0].mapping[1].output = "customer_id"),
    (d: any) => (d.objects[0].mapping[0].source = "missing"),
    (d: any) => (d.discovery.sha256 = "0".repeat(64)),
    (d: any) => (d.target = { connection: "warehouse" }),
  ]) {
    const bad = structuredClone(definition);
    mutate(bad);
    assert.equal(
      execute({ root }, "ingestion_definition_review", {
        revision: saved.revision,
        definition: bad,
      }).ok,
      false,
    );
  }
});
test("working copies resume by stable object identity; concurrent and external edits conflict; save clears exact working copy atomically", (t) => {
  const { root, definition } = setup(t);
  const saved = save(root, definition);
  const draft = {
    apiVersion: "ingestron.ingestion-draft/v1",
    project: "retail",
    baseRevision: saved.revision,
    definition: { ...definition, name: "Changed" },
    context: { object: "sales.object_479", section: "mapping" },
  };
  assert.equal(
    execute({ root }, "ingestion_draft_write", {
      id: "retail",
      expected: null,
      draft,
    }).ok,
    false,
  );
  assert.equal(
    execute(
      { root, environment: "../ingestions", allowWrite: true },
      "ingestion_draft_write",
      { id: "retail", expected: null, draft },
    ).ok,
    false,
  );
  const working = call(
    root,
    "ingestion_draft_write",
    { id: "retail", expected: null, draft },
    true,
  );
  assert.equal(
    call(root, "ingestion_editor_read", { id: "retail" }).working.draft.context
      .object,
    "sales.object_479",
  );
  assert.equal(
    execute({ root, allowWrite: true }, "ingestion_draft_write", {
      id: "retail",
      expected: null,
      draft,
    }).ok,
    false,
  );
  const review = call(root, "ingestion_definition_review", {
    revision: saved.revision,
    definition: draft.definition,
    workingExpected: working.expected,
  });
  assert.equal(review.proposal.changes.length, 2);
  call(
    root,
    "ingestion_definition_apply",
    { input: review.input, proposalId: review.proposal.id },
    true,
  );
  assert.equal(
    call(root, "ingestion_editor_read", { id: "retail" }).working.draft,
    null,
  );
  assert.equal(
    execute({ root, allowWrite: true }, "ingestion_draft_write", {
      id: "retail",
      expected: working.expected,
      draft,
    }).ok,
    false,
  );
});
test("source drift blocks new adoption; pinned definition keeps historical evidence; required masks cannot weaken", (t) => {
  const { root, definition } = setup(t);
  definition.objects[0].governance = {
    masking: [{ field: "nested.id", policy: "redact", required: true }],
  };
  let saved = save(root, definition);
  const bad = structuredClone(definition);
  bad.objects[0].governance.masking = [];
  assert.equal(
    execute({ root }, "ingestion_definition_review", {
      revision: saved.revision,
      definition: bad,
    }).ok,
    false,
  );
  writeFileSync(
    join(root, "project.yaml"),
    readFileSync(join(root, "project.yaml"), "utf8") +
      "\n# source configuration changed\n",
  );
  definition.name = "Historical evidence";
  saved = save(root, definition);
  const other = { ...definition, id: "new_definition" };
  assert.equal(
    execute({ root }, "ingestion_definition_review", {
      revision: saved.revision,
      definition: other,
    }).ok,
    false,
  );
  const review = call(root, "ingestion_definition_review", {
    revision: saved.revision,
    definition: { ...definition, name: "Next" },
  });
  writeFileSync(
    join(root, "discovery/dev/sales/catalogue.yaml"),
    readFileSync(join(root, "discovery/dev/sales/catalogue.yaml"), "utf8") +
      "\n# changed evidence\n",
  );
  assert.equal(
    execute({ root, allowWrite: true }, "ingestion_definition_apply", {
      input: review.input,
      proposalId: review.proposal.id,
    }).ok,
    false,
  );
});

test("create intent cannot replace an existing definition", (t) => {
  const { root, definition } = setup(t);
  const saved = save(root, definition);
  assert.equal(
    execute({ root }, "ingestion_definition_review", {
      revision: saved.revision,
      definition: { ...definition, name: "Replacement" },
      create: true,
    }).ok,
    false,
  );
});

test("working-copy YAML expansion is bounded before any file is written", (t) => {
  const root = fixture(t),
    revision = call(root, "ingestion_definition_read", {}).revision;
  const definition = {
    apiVersion: "ingestron.ingestion-definition/v1",
    id: "large",
    name: "Large",
    description: "",
    status: "draft",
    objects: Array.from({ length: 8000 }, (_, i) => ({
      id: `object_${i}`,
      kind: "table",
      fields: [],
      mapping: [],
      metadata: [],
      quality: [{ notes: Array(100).fill("a").join("\n") }],
    })),
  };
  const draft = {
    apiVersion: "ingestron.ingestion-draft/v1",
    project: "retail",
    baseRevision: revision,
    definition,
    context: {},
  };
  assert(Buffer.byteLength(JSON.stringify(draft)) < 8 * 1024 * 1024);
  assert(Buffer.byteLength(stringify(draft)) > 8 * 1024 * 1024);
  assert.equal(
    execute({ root, allowWrite: true }, "ingestion_draft_write", {
      id: "large",
      expected: null,
      draft,
    }).ok,
    false,
  );
  assert.throws(() =>
    readFileSync(join(root, "ingestion-drafts/dev/large.yaml")),
  );
});

test("reviewing the current definition cannot silently clear a conflicting working copy", (t) => {
  const { root, definition } = setup(t),
    saved = save(root, definition);
  const working = call(
    root,
    "ingestion_draft_write",
    {
      id: "retail",
      expected: null,
      draft: {
        apiVersion: "ingestron.ingestion-draft/v1",
        project: "retail",
        baseRevision: saved.revision,
        definition: { ...definition, name: "Working" },
        context: {},
      },
    },
    true,
  );
  const current = save(root, { ...definition, name: "External" });
  assert.equal(
    call(root, "ingestion_editor_read", { id: "retail" }).conflict,
    true,
  );
  assert.equal(
    execute({ root }, "ingestion_definition_review", {
      revision: current.revision,
      definition: current.definitions[0].definition,
      workingExpected: working.expected,
    }).ok,
    false,
  );
  assert.equal(
    call(root, "ingestion_editor_read", { id: "retail" }).working.draft
      .definition.name,
    "Working",
  );
});

test("reviewed discovery update preserves settings, partial omissions and exact files; draft findings and stale reviews are explicit", (t) => {
  const { root, definition } = setup(t);
  definition.objects[0].mapping[0].output = "renamed_id";
  definition.objects[0].governance = {
    owner: "Data team",
    masking: [{ field: "nested_id", policy: "redact", required: true }],
  };
  definition.objects[0].metadata = [
    {
      name: "source_name",
      logicalType: "string",
      value: { kind: "source-object" },
    },
  ];
  definition.objects[0].quality = [{ custom: "preserved" }];
  save(root, definition);
  const file = join(root, "ingestions/retail.yaml");
  const before = readFileSync(file, "utf8");
  const old = call(root, "discovery_read", {
    connection: "sales",
    snapshot: "catalogue",
  }).snapshot;
  const next = {
    ...old,
    id: "catalogue_v2",
    coverage: { scope: "subset", complete: false },
    objects: [
      {
        ...old.objects[0],
        metadataComplete: true,
        fields: [
          { path: "nested_id", logicalType: "integer", origin: "declared" },
          { path: "new_field", logicalType: "string", origin: "declared" },
        ],
      },
    ],
  };
  const disc = call(root, "discovery_review", {
    connection: "sales",
    revision: call(root, "discovery_read", { connection: "sales" }).revision,
    document: JSON.stringify(next),
    allowSamples: false,
  });
  const saved = call(
    root,
    "discovery_apply",
    { input: disc.input, proposalId: disc.proposal.id },
    true,
  );
  const entry = saved.snapshots.find((s: any) => s.id === next.id);
  const revision = call(root, "ingestion_definition_read", {}).revision;
  const update = call(root, "ingestion_discovery_update", {
    revision,
    definition,
    snapshot: next.id,
    sha256: entry.sha256,
  });
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(update.definition.objects.length, 480);
  assert.deepEqual(
    update.definition.objects[0].mapping,
    definition.objects[0].mapping,
  );
  assert.deepEqual(
    update.definition.objects[0].governance,
    definition.objects[0].governance,
  );
  assert.deepEqual(
    update.definition.objects[0].quality,
    definition.objects[0].quality,
  );
  assert.deepEqual(
    update.definition.objects[0].metadata,
    definition.objects[0].metadata,
  );
  assert.deepEqual(
    update.definition.objects[1].discovery,
    definition.discovery,
  );
  assert.equal(update.changes[1].status, "Not observed — retained");
  assert.ok(update.findings.some((f: any) => f.section === "mapping"));
  assert.equal(
    update.files[0].before,
    readFileSync(join(root, "discovery/dev/sales/catalogue.yaml"), "utf8"),
  );
  assert.equal(
    update.files[0].after,
    readFileSync(join(root, "discovery/dev/sales/catalogue_v2.yaml"), "utf8"),
  );
  assert.equal(
    execute({ root }, "ingestion_definition_review", {
      revision,
      definition: update.definition,
      saveWithFindings: true,
    }).ok,
    false,
  );
  assert.equal(
    execute({ root }, "ingestion_definition_review", {
      revision,
      definition: { ...update.definition, status: "reviewed" },
      adoptDiscovery: update.definition.discovery,
      saveWithFindings: true,
    }).ok,
    false,
  );
  const review = call(root, "ingestion_definition_review", {
    revision,
    definition: update.definition,
    adoptDiscovery: update.definition.discovery,
    saveWithFindings: true,
  });
  assert.equal(review.proposal.changes[0].before, before);
  assert.equal(review.validation.valid, false);
  call(
    root,
    "ingestion_definition_apply",
    { input: review.input, proposalId: review.proposal.id },
    true,
  );
  assert.equal(readFileSync(file, "utf8"), review.proposal.changes[0].after);
  const reread = call(root, "ingestion_editor_read", { id: "retail" });
  assert.equal(reread.definition.status, "draft");
  reread.definition.objects[0].mapping =
    reread.definition.objects[0].mapping.filter(
      (m: any) => m.source !== "nested.id",
    );
  reread.definition.status = "reviewed";
  const reviewed = call(root, "ingestion_definition_review", {
    revision: reread.revision,
    definition: reread.definition,
  });
  const snapshotPath = join(root, "discovery/dev/sales/catalogue_v2.yaml");
  writeFileSync(
    snapshotPath,
    readFileSync(snapshotPath, "utf8") + "\n# changed after review\n",
  );
  assert.equal(
    execute({ root, allowWrite: true }, "ingestion_definition_apply", {
      input: reviewed.input,
      proposalId: reviewed.proposal.id,
    }).ok,
    false,
  );
  assert.equal(parse(readFileSync(file, "utf8")).status, "draft");
});

test("incomplete metadata retains previous fields and connector changes cannot use discovery adoption", (t) => {
  const { root, definition } = setup(t);
  save(root, definition);
  const old = call(root, "discovery_read", {
    connection: "sales",
    snapshot: "catalogue",
  }).snapshot;
  const next = {
    ...old,
    id: "partial",
    objects: [{ ...old.objects[0], metadataComplete: false, fields: [] }],
  };
  const r = call(root, "discovery_review", {
    connection: "sales",
    revision: call(root, "discovery_read", { connection: "sales" }).revision,
    document: JSON.stringify(next),
    allowSamples: false,
  });
  const saved = call(
    root,
    "discovery_apply",
    { input: r.input, proposalId: r.proposal.id },
    true,
  );
  const input = {
    revision: call(root, "ingestion_definition_read", {}).revision,
    definition,
    snapshot: "partial",
    sha256: saved.snapshots.find((s: any) => s.id === "partial").sha256,
  };
  const update = call(root, "ingestion_discovery_update", input);
  assert.deepEqual(
    update.definition.objects[0].fields,
    definition.objects[0].fields,
  );
  assert.equal(update.changes[0].status, "Incomplete metadata — retained");
  assert.equal(
    execute({ root }, "ingestion_discovery_update", {
      ...input,
      sha256: "0".repeat(64),
    }).ok,
    false,
  );
  save(root, { ...definition, name: "Concurrent edit" });
  assert.equal(
    execute({ root }, "ingestion_discovery_update", input).ok,
    false,
  );
});

test("draft findings cannot persist an invalid immutable reusable rule-set version", (t) => {
  const { root, definition } = setup(t);
  definition.qualityRuleSets = [
    {
      id: "invalid",
      version: 1,
      name: "Invalid bounds",
      description: "",
      fields: [],
      rules: [
        {
          apiVersion: "ingestron.quality-rule/v1",
          id: "count",
          name: "Count",
          description: "",
          enabled: true,
          fields: [],
          condition: { kind: "row-count", min: 10, max: 1 },
          nullHandling: "fail",
          threshold: { kind: "pass-rate", value: 100 },
          severity: "error",
          failureIntent: "report-only",
        },
      ],
    },
  ];
  const revision = call(root, "ingestion_definition_read", {}).revision;
  const r = execute({ root }, "ingestion_definition_review", {
    revision,
    definition,
    saveWithFindings: true,
  });
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r.diagnostics), /versions must be valid/);
});

test("registered connector transition adopts new metadata explicitly and retains settings and previous object evidence", (t) => {
  const { root, definition } = setup(t);
  definition.objects[0].quality = [
    { engine: "custom", expression: "preserve" },
  ];
  definition.objects[0].governance = {
    owner: "Data owner",
    masking: [{ field: "nested.id", policy: "redact", required: true }],
  };
  save(root, definition);
  const project = parse(readFileSync(join(root, "project.yaml"), "utf8"));
  project.packages.source.version = "1.1.0";
  writeFileSync(join(root, "project.yaml"), stringify(project));
  // Existing pinned definitions remain editable after registration changes.
  save(root, { ...definition, name: "Retained settings" });
  const old = call(root, "discovery_read", {
    connection: "sales",
    snapshot: "catalogue",
  }).snapshot;
  const next = {
    ...old,
    id: "upgraded",
    connector: { ...old.connector, version: "1.1.0" },
    objects: old.objects
      .slice(1)
      .map((o: any) => ({ ...o, metadataComplete: true })),
  };
  const r = call(root, "discovery_review", {
    connection: "sales",
    revision: call(root, "discovery_read", { connection: "sales" }).revision,
    document: JSON.stringify(next),
    allowSamples: false,
  });
  const saved = call(
    root,
    "discovery_apply",
    { input: r.input, proposalId: r.proposal.id },
    true,
  );
  const update = call(root, "ingestion_discovery_update", {
    revision: call(root, "ingestion_definition_read", {}).revision,
    definition,
    snapshot: "upgraded",
    sha256: saved.snapshots.find((s: any) => s.id === "upgraded").sha256,
  });
  assert.equal(update.definition.source.connector.version, "1.1.0");
  assert.equal(update.definition.objects[0].discovery.id, "catalogue");
  assert.deepEqual(
    update.definition.objects[0].governance,
    definition.objects[0].governance,
  );
  assert.deepEqual(
    update.definition.objects[0].quality,
    definition.objects[0].quality,
  );
  assert.deepEqual(
    update.definition.objects.map((o: any) => o.mapping),
    definition.objects.map((o: any) => o.mapping),
  );
  assert.equal(
    execute({ root }, "ingestion_definition_review", {
      revision: call(root, "ingestion_definition_read", {}).revision,
      definition: update.definition,
    }).ok,
    false,
  );
  save(root, update.definition, {
    adoptDiscovery: update.definition.discovery,
  });
  save(root, { ...update.definition, name: "Edit after adoption" });
});

test("duplicate and reversible archive preserve 480 objects, old version evidence, legacy files and dependency fences", (t) => {
  const { root, definition } = setup(t);
  definition.objects[0].mapping[0].output = "customer_id";
  definition.objects[0].quality = [
    { engine: "future", vendor: { retain: true } },
  ];
  definition.objects[0].governance = {
    owner: "Data team",
    masking: [
      { field: "nested.id", policy: "redact", enabled: true, required: true },
    ],
  };
  definition.objects[0].metadata = [
    {
      name: "source_file",
      logicalType: "string",
      value: { kind: "source-path" },
    },
  ];
  save(root, definition, { create: true, saveWithFindings: true });
  const original = readFileSync(join(root, "ingestions/retail.yaml"), "utf8");
  mkdirSync(join(root, "flows"), { recursive: true });
  const legacy =
    "# retained legacy target data\nkind: ingestion\ntarget: warehouse\ncustom: keep\n";
  writeFileSync(join(root, "flows/legacy.yaml"), legacy);
  const project = parse(readFileSync(join(root, "project.yaml"), "utf8"));
  project.packages.source.version = "2.0.0";
  writeFileSync(join(root, "project.yaml"), stringify(project));
  const copy = {
    ...definition,
    id: "copy",
    name: "Copied ingestion",
    status: "draft",
    archived: false,
  };
  save(root, copy, {
    create: true,
    duplicateFrom: "retail",
    saveWithFindings: true,
  });
  assert.equal(
    readFileSync(join(root, "ingestions/retail.yaml"), "utf8"),
    original,
  );
  assert.deepEqual(
    parse(readFileSync(join(root, "ingestions/copy.yaml"), "utf8")).objects,
    definition.objects,
  );
  let revision = call(root, "ingestion_definition_read", {}).revision;
  assert.equal(
    execute({ root }, "ingestion_definition_review", {
      revision,
      create: true,
      duplicateFrom: "retail",
      definition: { ...copy, id: "tampered", objects: [] },
    }).ok,
    false,
  );
  mkdirSync(join(root, "ingestion-handoffs/prod"), { recursive: true });
  const handoff = {
    apiVersion: "ingestron.ingestion-handoff/v1",
    project: "retail",
    definition: { id: "copy", sha256: "a".repeat(64) },
    contracts: [],
    requiredCapabilities: [],
  };
  const handoffPath = join(root, "ingestion-handoffs/prod/warehouse.yaml");
  writeFileSync(handoffPath, stringify(handoff));
  const archiveInput = {
    revision,
    definition: { ...copy, archived: true },
    saveWithFindings: true,
  };
  let result = execute({ root }, "ingestion_definition_review", archiveInput);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, "DEPENDENCY");
  rmSync(handoffPath);
  const review = call(root, "ingestion_definition_review", archiveInput);
  // A consumer appearing after review prevents applying it.
  writeFileSync(handoffPath, stringify(handoff));
  assert.equal(
    execute({ root, allowWrite: true }, "ingestion_definition_apply", {
      input: review.input,
      proposalId: review.proposal.id,
    }).ok,
    false,
  );
  rmSync(handoffPath);
  const working = {
    apiVersion: "ingestron.ingestion-draft/v1",
    project: "retail",
    baseRevision: revision,
    definition: copy,
    context: {},
  };
  const savedWorking = call(
    root,
    "ingestion_draft_write",
    { id: "copy", expected: null, draft: working },
    true,
  );
  assert.equal(
    execute({ root }, "ingestion_definition_review", archiveInput)
      .diagnostics[0].code,
    "DEPENDENCY",
  );
  call(
    root,
    "ingestion_draft_write",
    { id: "copy", expected: savedWorking.expected, draft: null },
    true,
  );
  // Null discarded-copy files remain valid dependency inputs.
  save(root, { ...copy, archived: true }, { saveWithFindings: true });
  revision = call(root, "ingestion_definition_read", {}).revision;
  assert.equal(
    execute({ root, allowWrite: true }, "ingestion_draft_write", {
      id: "copy",
      expected: call(root, "ingestion_editor_read", { id: "copy" }).working
        .expected,
      draft: { ...working, baseRevision: revision },
    }).ok,
    false,
  );
  assert.equal(
    execute({ root }, "ingestion_definition_review", {
      revision,
      definition: { ...copy, archived: true, name: "Edited while archived" },
      saveWithFindings: true,
    }).ok,
    false,
  );
  save(root, copy, { saveWithFindings: true });
  assert.deepEqual(
    parse(readFileSync(join(root, "ingestions/copy.yaml"), "utf8")),
    copy,
  );
  assert.equal(readFileSync(join(root, "flows/legacy.yaml"), "utf8"), legacy);
  assert.equal(
    readFileSync(join(root, "ingestions/retail.yaml"), "utf8"),
    original,
  );
});
