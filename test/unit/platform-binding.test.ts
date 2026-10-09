import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { fixture } from "../support/project.js";
import { execute } from "../../src/core/operations.js";
import { installPackage } from "../../src/core/packages.js";
import { Configuration } from "../../src/core/config.js";
import { verifyBuildBindings } from "../../src/core/platform-binding.js";
import { buildProject } from "../../src/core/project-build.js";

function setup(t: any) {
  const f = fixture(t),
    origin = join(f.root, "fixture-origin");
  const manifestFile = join(origin, "plugin/provider.yaml");
  const manifest = parse(readFileSync(manifestFile, "utf8"));
  manifest.version = "1.1.0";
  manifest.compatibility.requiredFeatures = ["programme-platform-binding"];
  manifest.configurationSchema = {
    type: "object",
    additionalProperties: false,
    required: ["deployment"],
    properties: {
      deployment: {
        type: "object",
        required: ["rootPath"],
        properties: { rootPath: { type: "string" } },
      },
    },
  };
  manifest.platformBinding = {
    apiVersion: "ingestron.platform-binding-authoring/v1",
    resourcesSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceUrl", "catalog"],
      properties: {
        workspaceUrl: { type: "string" },
        catalog: { type: "string" },
      },
    },
  };
  writeFileSync(manifestFile, stringify(manifest));
  const moduleFile = join(origin, "plugin/index.mjs");
  writeFileSync(
    moduleFile,
    readFileSync(moduleFile, "utf8").replace(
      "export function author(r){",
      `export function author(r){
    if(r.operation==='platform_binding') return {files:{'binding.yaml':JSON.stringify({apiVersion:'ingestron.provider-binding/v1',binding:{kind:'databricks',host:r.options.resources.workspaceUrl,catalog:r.options.resources.catalog},options:{deployment:{rootPath:'/Workspace/Shared/'+r.options.projectId+'/'+r.options.environment}},ownership:'Existing shared resources remain external',pendingIntent:['Review flow standards separately']})}};
  `,
    ),
  );
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
    "binding fixture",
  );
  const commit = git("rev-parse", "HEAD").trim();
  const reference = `example/fixture/plugin/provider.yaml@${commit}`;
  installPackage(f.root, reference, { fromGit: origin });
  const project: any = {
    apiVersion: "ingestron.project/v1",
    id: "retail",
    packages: {},
    providers: { configurations: {} },
    defaults: {},
    environments: {
      dev: { $resolve: "./environments/dev.yaml" },
      uat: { $resolve: "./environments/uat.yaml" },
    },
    flows: [],
  };
  for (const environment of ["dev", "uat"])
    f.put(`environments/${environment}.yaml`, {
      apiVersion: "ingestron.environment/v1",
      environment,
      values: {},
      bindings: {},
    });
  f.put("project.yaml", project);
  const programme = {
    id: "retail-programme",
    root: join(f.root, "shared-programme"),
  };
  const document: any = {
    apiVersion: "ingestron.programme/v1",
    id: programme.id,
    name: "Retail",
    objective: "Daily decisions",
    sponsor: "Owner",
    stakeholders: [],
    requirements: [],
    projects: [
      {
        id: "PLAN-1",
        name: "Retail",
        compilerId: "retail",
        platformId: "PLAT-1",
        targets: [
          { provider: "databricks", responsibilities: ["transformation"] },
        ],
      },
      {
        id: "PLAN-2",
        name: "Other",
        compilerId: "inventory",
        platformId: "PLAT-1",
      },
    ],
    platforms: [
      {
        id: "PLAT-1",
        name: "Shared",
        configuration: {
          environments: [
            { name: "test", purpose: "test" },
            { name: "prod", purpose: "production" },
          ],
          targets: [
            {
              provider: "databricks",
              generation: { qualityFailure: "block" },
              capabilities: {},
              policies: {},
              naming: {},
              environments: [
                {
                  name: "test",
                  purpose: "test",
                  authentication: "databricks-cli",
                  configuration: { workspaceUrl: "https://shared.invalid" },
                  secrets: [],
                },
              ],
            },
          ],
        },
      },
    ],
  };
  const saveSource = () =>
    f.put(
      "shared-programme/programme.json",
      JSON.stringify(document, null, 2) + "\n",
    );
  saveSource();
  const args = {
    programme,
    project: "PLAN-1",
    sharedEnvironment: "test",
    target: "databricks",
    reference,
    configuration: "warehouse_dev",
    resources: { catalog: "retail_test" },
  };
  const run = (
    operation: string,
    args: unknown,
    allowWrite = false,
    environment = "dev",
  ) => execute({ root: f.root, environment, allowWrite }, operation, args);
  const review = () => {
    const r = run("platform_binding_propose", args);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.result;
  };
  const apply = (proposal: any) =>
    run("platform_binding_apply", { programme, proposal }, true);
  return {
    ...f,
    project,
    programme,
    document,
    saveSource,
    args,
    run,
    review,
    apply,
    reference,
  };
}

test("explicit project dev to shared test binding preserves other environments and shared intent", (t) => {
  const f = setup(t),
    before = readFileSync(
      join(f.root, "shared-programme/programme.json"),
      "utf8",
    ),
    untouched = readFileSync(join(f.root, "environments/uat.yaml"), "utf8");
  const proposed = f.review();
  assert.equal(existsSync(join(f.root, "platform-bindings")), false);
  assert.equal(proposed.environment, "dev");
  assert.equal(proposed.sharedEnvironment, "test");
  assert.equal(proposed.materialised.binding.host, "https://shared.invalid");
  assert.equal(proposed.materialised.binding.catalog, "retail_test");
  assert.equal(
    f.run("platform_binding_apply", {
      programme: f.programme,
      proposal: proposed,
    }).diagnostics[0]?.code,
    "PERMISSION",
  );
  const applied = f.apply(proposed);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const resolved = new Configuration(f.root, {}).load();
  assert.equal(resolved.platformBindings.warehouse_dev.planProjectId, "PLAN-1");
  assert.equal(
    resolved.platformBindings.warehouse_dev.source.document.projects.length,
    2,
  );
  assert.equal(
    resolved.providers.configurations.warehouse_dev.binding,
    "warehouse_dev_platform",
  );
  assert.equal(resolved.defaults.provider, undefined);
  assert.equal(
    readFileSync(join(f.root, "environments/uat.yaml"), "utf8"),
    untouched,
  );
  assert.equal(
    readFileSync(join(f.root, "shared-programme/programme.json"), "utf8"),
    before,
  );
  assert.equal(
    f.apply(proposed).ok,
    false,
    "Applying the old review twice must fail",
  );
  const inspected = f.run("platform_binding_inspect", {
    programme: f.programme,
    project: "PLAN-1",
  });
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.equal(inspected.result.bindings[0].intact, true);
  assert.equal(inspected.result.bindings[0].stale, false);
  assert.throws(() => buildProject(f.root, "dev", {}), /authorised programme/);
  assert.doesNotThrow(() => verifyBuildBindings(f.root, "dev", f.programme));
  assert.doesNotThrow(() => verifyBuildBindings(f.root, "uat"));
});

test("binding refuses absent registration, target, profile and resource overrides", (t) => {
  const f = setup(t);
  for (const patch of [
    { project: "PLAN-2" },
    { target: "adf" },
    { sharedEnvironment: "prod" },
    { sharedEnvironment: "dev" },
    { resources: {} },
    {
      resources: {
        catalog: "retail_test",
        workspaceUrl: "https://other.invalid",
      },
    },
    { resources: { catalog: "retail_test", password: "hidden" } },
    { configuration: "a".repeat(72) },
  ]) {
    assert.equal(
      f.run("platform_binding_propose", { ...f.args, ...patch }).ok,
      false,
      JSON.stringify(patch),
    );
  }
  assert.equal(
    f.run("platform_binding_propose", f.args, false, "missing").ok,
    false,
  );
  f.document.projects[0].compilerId = "wrong";
  f.saveSource();
  assert.equal(f.run("platform_binding_propose", f.args).ok, false);
});

test("review checks changed programme and project inputs, supports explicit refresh, and locks source writes", (t) => {
  const f = setup(t),
    proposed = f.review();
  f.document.objective = "Changed outcome";
  f.saveSource();
  assert.equal(f.apply(proposed).diagnostics[0]?.code, "STALE");
  assert.equal(existsSync(join(f.root, ".ingestron-write.lock")), false);
  assert.equal(
    existsSync(join(f.programme.root, ".programme-write.lock")),
    false,
  );
  const fresh = f.review();
  writeFileSync(
    join(f.root, "environments/uat.yaml"),
    readFileSync(join(f.root, "environments/uat.yaml"), "utf8") +
      "# concurrent change\n",
  );
  assert.equal(f.apply(fresh).diagnostics[0]?.code, "STALE");
  const current = f.review();
  writeFileSync(
    join(f.programme.root, ".programme-write.lock"),
    "another writer",
  );
  assert.equal(f.apply(current).ok, false);
  assert.equal(
    readFileSync(join(f.programme.root, ".programme-write.lock"), "utf8"),
    "another writer",
  );
});

test("refresh preserves prior snapshots and build rejects stale source, weakened gates and manual input edits", (t) => {
  const f = setup(t);
  assert.equal(f.apply(f.review()).ok, true);
  const initial = new Configuration(f.root, {}).load().platformBindings
    .warehouse_dev;
  const oldSnapshot = join(
      f.root,
      `platform-bindings/snapshots/${initial.source.definitionDigest}.json`,
    ),
    oldText = readFileSync(oldSnapshot, "utf8");
  f.document.objective = "Better margin decisions";
  f.saveSource();
  assert.throws(
    () => verifyBuildBindings(f.root, "dev", f.programme),
    /Shared programme changed/,
  );
  assert.equal(
    f.run("platform_binding_inspect", {
      programme: f.programme,
      project: "PLAN-1",
    }).result.bindings[0].stale,
    true,
  );
  const refreshed = f.apply(f.review());
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
  assert.equal(readFileSync(oldSnapshot, "utf8"), oldText);
  assert.doesNotThrow(() => verifyBuildBindings(f.root, "dev", f.programme));
  const raw = parse(readFileSync(join(f.root, "project.yaml"), "utf8"));
  raw.defaults.quality = { unsupported: "report" };
  f.put("project.yaml", raw);
  assert.throws(
    () => verifyBuildBindings(f.root, "dev", f.programme),
    /weaken/,
  );
  delete raw.defaults.quality;
  raw.providers.configurations.warehouse_dev.options.deployment.rootPath =
    "/different";
  f.put("project.yaml", raw);
  assert.throws(
    () => verifyBuildBindings(f.root, "dev", f.programme),
    /Provider inputs differ/,
  );
  assert.equal(
    f.run("platform_binding_propose", f.args).diagnostics[0]?.code,
    "BINDING",
  );
});

test("binding cannot overwrite unowned files or an immutable snapshot and protects fragmented references", (t) => {
  const f = setup(t),
    proposal = f.review();
  f.put("platform-bindings/warehouse_dev.yaml", "owned by someone else");
  assert.equal(
    f.run("platform_binding_propose", f.args).diagnostics[0]?.code,
    "OWNER",
  );
  // A second configuration exercises a nested mapping while the unowned file remains intact.
  f.args.configuration = "nested";
  f.project.platformBindings = { $resolve: "./definitions/bindings.yaml" };
  f.put("definitions/bindings.yaml", {});
  f.put("project.yaml", f.project);
  const nested = f.review(),
    applied = f.apply(nested);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(
    new Configuration(f.root, {}).load().platformBindings.nested.configuration,
    "nested",
  );
  assert.equal(
    readFileSync(join(f.root, "platform-bindings/warehouse_dev.yaml"), "utf8"),
    "owned by someone else",
  );
  const snapshot = `platform-bindings/snapshots/${proposal.sourceDigest}.json`;
  f.put(snapshot, readFileSync(join(f.root, snapshot), "utf8") + " ");
  assert.equal(
    f.run("platform_binding_propose", f.args).diagnostics[0]?.code,
    "OWNER",
  );
});

test("shared environment fragments and YAML aliases cannot silently couple environments", (t) => {
  const f = setup(t);
  f.project.environments.uat = { $resolve: "./environments/dev.yaml" };
  f.put("project.yaml", f.project);
  assert.equal(
    f.run("platform_binding_propose", f.args).diagnostics[0]?.code,
    "OWNER",
  );
  f.project.environments.uat = { $resolve: "./environments/uat.yaml" };
  f.put("project.yaml", f.project);
  f.put(
    "environments/dev.yaml",
    "apiVersion: ingestron.environment/v1\nvalues: &shared {}\nbindings: *shared\n",
  );
  assert.equal(
    f.run("platform_binding_propose", f.args).diagnostics[0]?.code,
    "AUTHORING",
  );
});

test("altered review writes and provider cache changes are refused before materialisation", (t) => {
  const f = setup(t),
    proposal = f.review();
  const altered = structuredClone(proposal);
  altered.proposal.changes[0].after += "# changed\n";
  assert.equal(f.apply(altered).diagnostics[0]?.code, "STALE");
  assert.equal(existsSync(join(f.root, "platform-bindings")), false);
  const lock = parse(readFileSync(join(f.root, "packages.lock.yaml"), "utf8"));
  // Changing the lock itself invalidates a reviewed package/project revision.
  writeFileSync(
    join(f.root, "packages.lock.yaml"),
    stringify(lock) + "# changed\n",
  );
  assert.equal(f.apply(proposal).diagnostics[0]?.code, "STALE");
});
