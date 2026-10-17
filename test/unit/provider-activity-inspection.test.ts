import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import { fixture } from "../support/project.js";
import { installPackage, resolvePackage } from "../../src/core/packages.js";
import { providerActivityInspect } from "../../src/core/development.js";
import { execute } from "../../src/core/operations.js";

function inspectedFixture(t: any, code = "./generator.py") {
  const f = fixture(t),
    origin = resolve(f.root, "fixture-origin");
  const providerPath = resolve(origin, "plugin/provider.yaml");
  const provider = parse(readFileSync(providerPath, "utf8"));
  provider.version = "1.1.0";
  writeFileSync(providerPath, stringify(provider));
  const activityPath = resolve(origin, "plugin/activity.yaml");
  const activity = parse(readFileSync(activityPath, "utf8"));
  activity.version = "1.1.0";
  activity.generator.code = code;
  activity.templates = [
    {
      source: "./query.sql.j2",
      output: "queries/{{table.id}}.sql",
      format: "sql",
    },
  ];
  writeFileSync(activityPath, stringify(activity));
  writeFileSync(
    resolve(origin, "plugin/generator.py"),
    "raise RuntimeError('inspection must not execute this')\n",
  );
  writeFileSync(
    resolve(origin, "plugin/query.sql.j2"),
    "SELECT {{ table.id }};\n",
  );
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: origin,
      stdio: "ignore",
    });
  git(["add", "."]);
  git([
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@example.invalid",
    "commit",
    "-qm",
    "inspection fixture",
  ]);
  git(["tag", "1.1.0"]);
  installPackage(f.root, "example/fixture@1.1.0", { fromGit: origin });
  return f;
}
test("exact provider activity inspection reads templates and generator text without executing code or saving files", (t) => {
  const f = inspectedFixture(t);
  const before = ["project.yaml", "packages.lock.yaml"].map((p) =>
    readFileSync(resolve(f.root, p), "utf8"),
  );
  const result = execute({ root: f.root }, "provider_activity_inspect", {
    reference: "example/fixture@1.1.0",
    activity: "lakeflow-ingest",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(
    result.result.reference,
    "example/fixture/plugin/provider.yaml@1.1.0",
  );
  assert.match(
    result.result.generationSource,
    /inspection must not execute this/,
  );
  assert.equal(result.result.templates[0].content, "SELECT {{ table.id }};\n");
  assert.equal(result.result.templates[0].output, "queries/{{table.id}}.sql");
  assert.equal(Object.keys(result.result.sourceDigests).length, 4);
  assert.ok(Object.hasOwn(result.result.sourceDigests, "plugin/provider.yaml"));
  assert.deepEqual(
    ["project.yaml", "packages.lock.yaml"].map((p) =>
      readFileSync(resolve(f.root, p), "utf8"),
    ),
    before,
  );
  assert.throws(
    () => providerActivityInspect(f.root, "example/fixture@1.1.0", "toString"),
    /Choose an activity/,
  );
  assert.throws(
    () =>
      providerActivityInspect(
        f.root,
        "example/fixture@1.1.0",
        "../project.yaml",
      ),
    /Choose an activity/,
  );
});
test("inspection never follows a generator source outside the selected installed package", (t) => {
  const f = inspectedFixture(t, "../../../../../project.yaml");
  assert.throws(
    () =>
      providerActivityInspect(
        f.root,
        "example/fixture@1.1.0",
        "lakeflow-ingest",
      ),
    /Reference leaves the project/,
  );
});
test("inspection refuses changed cached sources before returning any content", (t) => {
  const f = inspectedFixture(t),
    selected = resolvePackage(f.root, "example/fixture@1.1.0");
  writeFileSync(resolve(selected.root, "plugin/query.sql.j2"), "changed\n");
  assert.throws(
    () =>
      providerActivityInspect(
        f.root,
        "example/fixture@1.1.0",
        "lakeflow-ingest",
      ),
    /Package integrity failed/,
  );
});
