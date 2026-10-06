import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { fixture } from "../support/project.js";
import { installPackage } from "../../src/core/packages.js";
import { execute } from "../../src/core/operations.js";
import { checkProviderCompatibility } from "../../src/plugins/compatibility.js";

function setup(t: any) {
  const f = fixture(t),
    origin = join(f.root, "fixture-origin");
  const manifest = parse(
    readFileSync(join(origin, "plugin/provider.yaml"), "utf8"),
  );
  manifest.version = "2.0.0";
  manifest.compatibility.requiredFeatures = [
    "transformation-authoring-settings",
  ];
  manifest.authoring = {
    transformationSettingsSchema: {
      type: "object",
      required: ["target"],
      additionalProperties: false,
      properties: { target: { type: "string", minLength: 1 } },
    },
  };
  f.put("fixture-origin/plugin/provider.yaml", manifest);
  f.put(
    "fixture-origin/plugin/index.mjs",
    `export function author(r) {
    const base='flows/'+r.options.id+'/';
    return {files:{[base+'flow.yaml']:JSON.stringify({apiVersion:'ingestron.flow/v1',kind:'transformation',id:r.options.id,provider:r.configuration,steps:[],publishes:{result:{from:'steps.transform.outputs.result',contract:{$resolve:'./contracts/result.yaml'}}}}),[base+'contracts/result.yaml']:JSON.stringify(r.options.outputContract ?? {}),[base+'source.sql']:'SELECT * FROM source\\n'}};
  }`,
  );
  execFileSync("git", ["add", "."], { cwd: origin });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "Synthetic transformation authoring",
    ],
    { cwd: origin },
  );
  execFileSync("git", ["tag", "2.0.0"], { cwd: origin });
  installPackage(f.root, "example/fixture@2.0.0", { fromGit: origin });
  f.project.providers.packages.dbx.version = "2.0.0";
  f.put("environments/dev.yaml", f.project.environments.dev);
  f.project.environments.dev = { $resolve: "./environments/dev.yaml" };
  f.put("project.yaml", f.project);
  f.put(
    "contracts/reviewed.yaml",
    parse(
      readFileSync(join(f.root, "flows/source/contracts/orders.yaml"), "utf8"),
    ),
  );
  const ctx = { root: f.root, environment: "dev", allowWrite: true };
  const args = {
    id: "report",
    kind: "transformation",
    inputDataset: "retail.source.orders.current",
    contract: "contracts/reviewed.yaml",
    transformationSettings: { target: "report" },
  };
  return { ...f, ctx, args };
}

test("selected transformation output contracts are copied into a no-write proposal and hash-fenced through apply", (t) => {
  const f = setup(t),
    result = execute(f.ctx, "flow_create", f.args);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(existsSync(join(f.root, "flows/report/flow.yaml")), false);
  const original = readFileSync(
    join(f.root, "contracts/reviewed.yaml"),
    "utf8",
  );
  assert.ok(result.result.inputs["contracts/reviewed.yaml"]);
  assert.deepEqual(
    parse(
      result.result.changes.find(
        (change: any) => change.path === "flows/report/contracts/result.yaml",
      ).after,
    ),
    parse(original),
  );
  f.put("contracts/reviewed.yaml", original + "# concurrent review\n");
  assert.equal(execute(f.ctx, "apply", { proposal: result.result }).ok, false);
  assert.equal(existsSync(join(f.root, "flows/report/flow.yaml")), false);
  f.put("contracts/reviewed.yaml", original);
  assert.equal(execute(f.ctx, "apply", { proposal: result.result }).ok, true);
  assert.equal(
    readFileSync(join(f.root, "contracts/reviewed.yaml"), "utf8"),
    original,
  );
});

test("provider-declared settings, ingestion misuse and orphan authored files are refused before any write", (t) => {
  const f = setup(t);
  for (const transformationSettings of [
    {},
    { target: 1 },
    { target: "report", extra: true },
  ])
    assert.equal(
      execute(f.ctx, "flow_create", { ...f.args, transformationSettings }).ok,
      false,
    );
  assert.equal(
    execute(f.ctx, "flow_create", {
      ...f.args,
      kind: "ingestion",
      contract: undefined,
    }).ok,
    false,
  );
  f.put("flows/report/source.sql", "SELECT 'preserve existing source'\n");
  const result = execute(f.ctx, "flow_create", f.args);
  assert.equal(result.ok, false);
  assert.match(
    JSON.stringify(result.diagnostics),
    /replace existing.*source.sql/,
  );
  assert.equal(
    readFileSync(join(f.root, "flows/report/source.sql"), "utf8"),
    "SELECT 'preserve existing source'\n",
  );
  assert.equal(existsSync(join(f.root, "flows/report/flow.yaml")), false);
});

test("transformation authoring declarations require the shared host feature", () => {
  assert.throws(
    () =>
      checkProviderCompatibility({
        authoring: {},
        compatibility: { minimumCli: "4.2.0", requiredFeatures: [] },
      }),
    /transformation-authoring-settings/,
  );
});
