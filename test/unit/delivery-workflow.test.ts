import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fixture } from "../support/project.js";
import { installPackage, resolvePackage } from "../../src/core/packages.js";
import { writeOutput } from "../../src/core/generate.js";
import { compilerIdentity } from "../../src/core/compiler-identity.js";
import { digest } from "../../src/core/errors.js";
import { executeAsync } from "../../src/core/operations.js";
const ok = (r: any) => {
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  return r.result;
};
function setup(t: any, platform = "local") {
  const f = fixture(t),
    origin = resolve(f.root, "local-origin");
  f.put("local-origin/plugin/provider.yaml", {
    apiVersion: "ingestron.provider/v1",
    id: "local-fixture",
    version: "1.0.0",
    platform,
    activities: {},
    compatibility: {
      plan: "ingestron.plan/v1",
      minimumCli: "4.2.0",
      requiredFeatures: ["provider-execution"],
    },
    renderer: {
      apiVersion: "ingestron.provider-generation/v1",
      module: "./index.mjs",
    },
    execution: {
      apiVersion: "ingestron.execution/v1",
      transport: "local-python/v1",
      entryPoint: "execute.py",
      actions: ["prepare", "run", "review"],
      status: "receipt",
      retry: "same-run-id",
      cancellation: "interrupt",
    },
  });
  f.put(
    "local-origin/plugin/index.mjs",
    "export function render(){return {}};",
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: origin, stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "synthetic local runtime",
  );
  git("tag", "1.0.0");
  const reference = "example/local@1.0.0";
  installPackage(f.root, reference, { fromGit: origin });
  f.project.packages = { local: reference };
  f.project.providers.configurations.local = {
    package: "local",
    binding: "local",
  };
  f.project.environments.dev.bindings.local = { kind: platform };
  f.project.environments.test = {
    ...structuredClone(f.project.environments.dev),
    environment: "test",
  };
  f.flow.provider = "local";
  f.put("flows/source/flow.yaml", f.flow);
  f.put("project.yaml", f.project);
  const compiler = compilerIdentity(),
    pkg = resolvePackage(f.root, reference);
  const build = {
    apiVersion: "ingestron.project-build/v1",
    project: "retail",
    environment: "dev",
    selection: {},
    planDigest: "b".repeat(64),
    sourceFiles: {
      "project.yaml": digest(readFileSync(resolve(f.root, "project.yaml"))),
    },
    packageLockSha256: digest(
      readFileSync(resolve(f.root, "packages.lock.yaml")),
    ),
    compilerVersion: compiler.version,
    compilerDigest: compiler.digest,
    packages: [
      {
        configuration: "local",
        reference: pkg.reference,
        commit: pkg.entry.commit,
        directory: ".",
        scope: { flows: ["source"] },
      },
    ],
  };
  writeOutput(
    resolve(f.root, "build/dev"),
    { project: "retail", environment: "dev", digest: "b".repeat(64) } as any,
    {
      "ingestron-project.json": JSON.stringify(build),
      "flows/source/connector.json": JSON.stringify({
        sourceSettings: {
          password: { $secret: { env: "SYNTHETIC_PASSWORD" } },
        },
      }),
      "execute.py":
        "import json,sys\nr=json.load(sys.stdin)\nprint(json.dumps({'apiVersion':'ingestron.execution-result/v1','status':'succeeded','privateResult':'not-for-the-workspace'}))\n",
    },
    "managed",
  );
  const context = {
    root: f.root,
    environment: "dev",
    allowWrite: true,
    allowExecute: true,
  };
  const run = (operation: any, args: any = {}, patch: any = {}) =>
    executeAsync({ ...context, ...patch }, operation, args);
  const input = { action: "run", flow: "source", from: "build/dev" };
  return { ...f, context, run, input };
}
test("reviewed local execution scopes its build, requires permissions and returns bounded run evidence", async (t) => {
  const f = setup(t);
  const review = ok(await f.run("delivery_execution_review", f.input));
  assert.equal(review.deploymentExecuted, false);
  assert.deepEqual(review.secretNames, ["SYNTHETIC_PASSWORD"]);
  assert.equal(existsSync(resolve(f.root, ".ingestron/runs")), false);
  assert.equal(
    (
      await f.run(
        "delivery_execution_apply",
        { review },
        { allowExecute: false },
      )
    ).diagnostics[0].code,
    "PERMISSION",
  );
  const result = ok(await f.run("delivery_execution_apply", { review }));
  assert.equal(result.run.status, "succeeded");
  assert.equal(JSON.stringify(result).includes("privateResult"), false);
  assert.equal((await f.run("delivery_execution_apply", { review })).ok, false);
  const read = ok(await f.run("delivery_inspect"));
  assert.equal(read.runs.length, 1);
  assert.equal(read.runs[0].id, review.request.runId);
  assert.equal(read.providers.find((p: any) => p.name === "local").local, true);
  assert.equal(read.backgroundWorkerStarted, false);
  assert.equal(JSON.stringify(read).includes("not-for-the-workspace"), false);
  const other = ok(
    await f.run("delivery_inspect", {}, { environment: "test" }),
  );
  assert.equal(other.runs.length, 0);
  const retry = ok(
    await f.run("delivery_execution_review", {
      ...f.input,
      action: "retry",
      original: result.run.id,
    }),
  );
  const again = ok(await f.run("delivery_execution_apply", { review: retry }));
  assert.equal(again.run.id, result.run.id);
  assert.equal(again.run.attempt, 2);
});
test("reviewed execution rejects stale definitions, native targets and dependency preparation without network permission", async (t) => {
  const f = setup(t);
  const review = ok(await f.run("delivery_execution_review", f.input));
  f.put(
    "project.yaml",
    readFileSync(resolve(f.root, "project.yaml"), "utf8") +
      "\n# edited since review\n",
  );
  assert.equal(
    (await f.run("delivery_execution_apply", { review })).diagnostics[0].code,
    "STALE",
  );
  const native = setup(t, "databricks");
  assert.equal(
    (await native.run("delivery_execution_review", native.input)).diagnostics[0]
      .code,
    "CAPABILITY",
  );
  const prep = setup(t);
  const prepared = ok(
    await prep.run("delivery_execution_review", {
      ...prep.input,
      action: "prepare",
    }),
  );
  assert.equal(prepared.networkDependencies, true);
  assert.equal(
    (await prep.run("delivery_execution_apply", { review: prepared }))
      .diagnostics[0].code,
    "PERMISSION",
  );
  assert.equal(
    (
      await prep.run("delivery_execution_review", {
        ...prep.input,
        from: "../outside",
      })
    ).diagnostics[0].code,
    "SCHEMA",
  );
});
