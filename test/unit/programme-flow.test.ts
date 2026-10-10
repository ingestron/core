import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { fixture } from "../support/project.js";
import { installPackage } from "../../src/core/packages.js";
import { execute } from "../../src/core/operations.js";
import { readFlowEditor } from "../../src/core/flow-editor.js";
import { Configuration } from "../../src/core/config.js";
import { verifyFlowPreferences } from "../../src/core/programme-flow.js";

function setup(t: any) {
  const f = fixture(t),
    origin = join(f.root, "fixture-origin"),
    manifestPath = join(origin, "plugin/provider.yaml");
  const manifest = parse(readFileSync(manifestPath, "utf8"));
  manifest.version = "1.1.0";
  manifest.compatibility.requiredFeatures = [
    "flow-authoring-capabilities",
    "transformation-authoring-settings",
  ];
  manifest.standards = ["snapshot-with-history@v1", "append-only@v1"].map(
    (id) => ({ id, description: "Synthetic declared standard" }),
  );
  manifest.authoring = {
    transformationSettingsSchema: {},
    flows: {
      apiVersion: "ingestron.flow-authoring/v1",
      kinds: ["ingestion"],
      ingestionStandards: manifest.standards.map((s: any) => s.id),
      prerequisites: [],
    },
  };
  writeFileSync(manifestPath, stringify(manifest));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: origin, encoding: "utf8" });
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "Declare standards",
  );
  const reference = `example/fixture/plugin/provider.yaml@${git("rev-parse", "HEAD").trim()}`;
  installPackage(f.root, reference, { fromGit: origin });
  f.project.providers.packages.dbx = reference;
  f.put("environments/dev.yaml", f.project.environments.dev);
  f.project.environments.dev = { $resolve: "./environments/dev.yaml" };
  f.put("project.yaml", f.project);
  const programme = { id: "retail", root: join(f.root, "programme") };
  const target: any = {
    provider: "databricks",
    policies: {},
    capabilities: {},
    naming: { table: "{dataset}" },
    environments: [],
    generation: {
      ingestion: "auto-loader",
      changes: "snapshot-history",
      qualityFailure: "block",
      optimisation: "liquid-clustering",
    },
  };
  const document: any = {
    apiVersion: "ingestron.programme/v1",
    id: "retail",
    name: "Retail",
    objective: "Reviewed delivery",
    sponsor: "Owner",
    stakeholders: [],
    requirements: [],
    projects: [
      {
        id: "plan-sales",
        compilerId: "retail",
        name: "Sales",
        platformId: "platform",
        targets: [{ provider: "databricks", responsibilities: ["ingestion"] }],
      },
    ],
    platforms: [
      {
        id: "platform",
        name: "Retail platform",
        configuration: { targets: [target], environments: [] },
      },
    ],
  };
  const source = () =>
    f.put("programme/programme.json", JSON.stringify(document));
  source();
  const request = () => {
    const snapshot = readFlowEditor(f.root, "source").selected!;
    return {
      programme,
      project: "plan-sales",
      change: {
        action: "edit",
        definition: {
          flow: "source",
          revision: snapshot.revision,
          description: "Reviewed source",
          values: {},
          logic: {},
          contracts: [],
        },
      },
    };
  };
  const run = (
    operation: string,
    args: any,
    allowWrite = false,
    environment = "dev",
  ) => execute({ root: f.root, environment, allowWrite }, operation, args);
  const review = (args = request()) => {
    const r = run("programme_flow_review", args);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.result;
  };
  return {
    ...f,
    programme,
    document,
    target,
    source,
    request,
    run,
    review,
    reference,
  };
}
test("flow preferences compare exact installed standards, preserve unapplied intent and require reviewed writes", (t) => {
  const f = setup(t),
    before = readFileSync(join(f.root, "flows/source/flow.yaml"));
  const reviewed = f.review();
  assert.equal(reviewed.preferences.blocked, false);
  assert.equal(
    reviewed.preferences.items.find((i: any) => i.setting === "ingestion")
      .status,
    "matches",
  );
  assert.equal(
    reviewed.preferences.items.find((i: any) => i.setting === "changes").status,
    "matches",
  );
  assert.equal(
    reviewed.preferences.items.find((i: any) => i.setting === "optimisation")
      .status,
    "unapplied",
  );
  assert.equal(
    reviewed.preferences.items.find((i: any) => i.setting === "naming.table")
      .status,
    "unapplied",
  );
  assert.deepEqual(
    readFileSync(join(f.root, "flows/source/flow.yaml")),
    before,
  );
  const args = { programme: f.programme, review: reviewed };
  assert.equal(
    f.run("programme_flow_apply", args).diagnostics[0].code,
    "PERMISSION",
  );
  assert.equal(f.run("programme_flow_apply", args, true).ok, true);
  assert.equal(f.run("programme_flow_apply", args, true).ok, false);
  const built = f.run(
    "build",
    { programme: f.programme, out: "build/dev" },
    true,
  );
  assert.equal(built.ok, true, JSON.stringify(built));
  const metadata = JSON.parse(
    readFileSync(join(f.root, "build/dev/ingestron-project.json"), "utf8"),
  );
  assert.equal(metadata.sharedPreferences.sourceDigest, reviewed.sourceDigest);
  assert.equal(
    metadata.sharedPreferences.flows[0].items.find(
      (i: any) => i.setting === "changes",
    ).status,
    "matches",
  );
  assert.equal(metadata.deployment.executed, false);
});
test("changed shared intent, context and tampered review cannot be applied", (t) => {
  const f = setup(t),
    review = f.review(),
    args = { programme: f.programme, review };
  assert.equal(
    f.run("programme_flow_review", {
      ...f.request(),
      project: "another-project",
    }).diagnostics[0].code,
    "PROGRAMME",
  );
  assert.equal(
    f.run("programme_flow_apply", args, true, "test").diagnostics[0].code,
    "PROPOSAL",
  );
  assert.equal(
    f.run(
      "programme_flow_apply",
      { ...args, programme: { ...f.programme, id: "foreign" } },
      true,
    ).ok,
    false,
  );
  assert.equal(
    f.run(
      "programme_flow_apply",
      {
        ...args,
        review: {
          ...review,
          preferences: { ...review.preferences, items: [] },
        },
      },
      true,
    ).diagnostics[0].code,
    "STALE",
  );
  f.target.generation.changes = "append";
  f.source();
  assert.equal(
    f.run("programme_flow_apply", args, true).diagnostics[0].code,
    "STALE",
  );
  const blocked = f.review();
  assert.equal(blocked.preferences.blocked, true);
  assert.equal(
    f.run(
      "programme_flow_apply",
      { programme: f.programme, review: blocked },
      true,
    ).diagnostics[0].code,
    "PREFERENCE",
  );
  assert.equal(
    readFileSync(join(f.root, "flows/source/flow.yaml"), "utf8").includes(
      "Reviewed source",
    ),
    false,
  );
  const project = new Configuration(f.root, {}).load();
  assert.throws(
    () => verifyFlowPreferences(f.root, f.programme, project.flows),
    /expects append-only/,
  );
  assert.equal(
    f.run("build", { programme: f.programme }, true).diagnostics[0].code,
    "PREFERENCE",
  );
});
test("comparison uses edited and created standards, not the old flow, and leaves source files unchanged", (t) => {
  const f = setup(t);
  const snapshot = readFlowEditor(f.root, "source").selected!;
  const standard = snapshot.values.find(
    (v) => v.section === "Ingestion settings" && v.name === "standard",
  )!;
  const request = f.request();
  request.change.definition.values = { [standard.id]: "append-only@v1" };
  const edited = f.review(request);
  assert.equal(
    edited.preferences.items.find((i: any) => i.setting === "changes").actual,
    "append-only@v1",
  );
  assert.equal(edited.preferences.blocked, true);
  const created = f.run("programme_flow_review", {
    programme: f.programme,
    project: "plan-sales",
    change: {
      action: "create",
      definition: {
        id: "new_orders",
        kind: "ingestion",
        provider: "engineering",
        standard: "append-only@v1",
        output: "orders",
      },
    },
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.result.preferences.blocked, true);
  f.target.generation.changes = "append";
  f.source();
  const compatible = f.review(request);
  assert.equal(compatible.preferences.blocked, false);
  assert.equal(
    f.run(
      "programme_flow_apply",
      { programme: f.programme, review: compatible },
      true,
    ).ok,
    true,
  );
});
test("missing installed mapping stays unapplied and unassigned projects keep draft authoring", (t) => {
  const f = setup(t);
  f.target.generation.changes = "cdc-history";
  f.source();
  const review = f.review();
  assert.equal(
    review.preferences.items.find((i: any) => i.setting === "changes").status,
    "unapplied",
  );
  f.document.projects[0].targets = [];
  f.source();
  const unassigned = f.review();
  assert.deepEqual(unassigned.preferences.items, []);
  assert.equal(
    f.run(
      "programme_flow_apply",
      { programme: f.programme, review: unassigned },
      true,
    ).ok,
    true,
  );
});

test("shared quality handling compares the actual compiler default and blocks weakening", (t) => {
  const f = setup(t);
  f.project.defaults.quality = { unsupported: "report" };
  f.put("project.yaml", f.project);
  const review = f.review();
  const quality = review.preferences.items.find(
    (i: any) => i.setting === "qualityFailure",
  );
  assert.equal(quality.actual, "report");
  assert.equal(quality.status, "conflict");
  assert.equal(
    f.run("programme_flow_apply", { programme: f.programme, review }, true)
      .diagnostics[0].code,
    "PREFERENCE",
  );
});
