import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { execute } from "../../src/core/operations.js";
import { fixture, installFixture } from "../support/project.js";
import { parse, stringify } from "yaml";
import { planProject } from "../../src/core/planner.js";
import { renderProject, writeOutput } from "../../src/core/generate.js";
import { installPackage, resolvePackage } from "../../src/core/packages.js";

test("authoring previews are read-only, stale proposals fail, and init protects existing files", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "ingestron-author-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  installFixture(root);
  const ctx = { root, environment: "dev", allowWrite: true };
  const proposal = execute(ctx, "initialise", {
    id: "retail",
    provider: "example/fixture@1.0.0",
  });
  assert.equal(proposal.ok, true);
  assert.equal(
    execute({ ...ctx, allowWrite: false }, "apply", {
      proposal: proposal.result,
    }).ok,
    false,
  );
  assert.equal(execute(ctx, "apply", { proposal: proposal.result }).ok, true);
  const created = parse(readFileSync(resolve(root, "project.yaml"), "utf8"));
  assert.deepEqual(created.packages, { native: "fixture@1.0.0" });
  assert.equal(created.providers.packages, undefined);
  assert.equal(execute(ctx, "validate", { mode: "draft" }).ok, true);
  const flow = execute(ctx, "flow_add", {
    id: "erp",
    kind: "ingestion",
    standard: "snapshot-with-history@v1",
    provider: "default",
    sourceKind: "azure-sql",
  });
  assert.equal(flow.ok, true, JSON.stringify(flow.diagnostics));
  const config = execute(ctx, "config_set", {
    path: "values.team",
    value: "engineering",
  });
  assert.equal(config.ok, true);
  assert.equal(execute(ctx, "apply", { proposal: config.result }).ok, true);
  const stale = execute(ctx, "apply", { proposal: flow.result });
  assert.equal(stale.diagnostics[0].code, "STALE");
  const other = resolve(root, "other");
  mkdirSync(other);
  installFixture(other);
  writeFileSync(resolve(other, "README.md"), "My notes");
  assert.equal(
    execute({ root: other }, "initialise", {
      id: "other",
      provider: "example/fixture@1.0.0",
    }).diagnostics[0].code,
    "OWNER",
  );
});

test("Git @v1 freezes an immutable source inventory and detects tampering", (t) => {
  const { root } = fixture(t);
  const repository = resolve(root, "library");
  mkdirSync(repository);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repository, encoding: "utf8" });
  git("init", "--quiet");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Synthetic test");
  writeFileSync(
    resolve(repository, "provider.yaml"),
    stringify({
      apiVersion: "ingestron.provider/v1",
      id: "sample",
      version: "1.0.0",
      platform: "databricks",
      activities: {},
    }),
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "sample");
  git("tag", "v1");
  const ref = "example/sample/provider.yaml@v1";
  const first = installPackage(root, ref, { fromGit: repository });
  writeFileSync(resolve(repository, "notes.md"), "second revision");
  git("add", ".");
  git("commit", "--quiet", "-m", "update");
  git("tag", "-f", "v1");
  assert.equal(
    installPackage(root, ref, { fromGit: repository, frozen: true }).commit,
    first.commit,
  );
  assert.notEqual(
    installPackage(root, ref, { fromGit: repository, update: true }).commit,
    first.commit,
  );
  const cached = resolvePackage(root, ref);
  writeFileSync(cached.file, "tampered");
  assert.throws(() => resolvePackage(root, ref), /integrity/);
  assert.equal(
    execute({ root, allowWrite: false }, "packages_install", {
      reference: ref,
      fromGit: repository,
    }).ok,
    false,
  );
});

test("regeneration removes obsolete owned files while preserving unowned notes", (t) => {
  const { root, flow, put } = fixture(t);
  const directory = resolve(root, "output");
  let plan = planProject(root);
  writeOutput(directory, plan, renderProject(root, plan));
  writeFileSync(resolve(directory, "review-notes.md"), "Engineer review");
  delete flow.tables.orders;
  put("flows/source/flow.yaml", flow);
  plan = planProject(root);
  writeOutput(directory, plan, renderProject(root, plan));
  assert.equal(
    readFileSync(resolve(directory, "review-notes.md"), "utf8"),
    "Engineer review",
  );
  assert.throws(() =>
    readFileSync(resolve(directory, "pipelines/source/orders.ipynb")),
  );
  put("plan.json", JSON.stringify(plan));
  assert.equal(
    execute({ root, environment: "prod", allowWrite: true }, "generate", {
      plan: "plan.json",
      out: "wrong-environment",
    }).diagnostics[0].code,
    "ENVIRONMENT",
  );
});

test("managed and team exports protect engineer edits", (t) => {
  const { root } = fixture(t);
  const plan = planProject(root);
  const files = renderProject(root, plan);
  for (const ownership of ["managed", "team"] as const) {
    const out = resolve(root, ownership);
    writeOutput(out, plan, files, ownership);
    const edited = resolve(out, "databricks.yml");
    const source = readFileSync(edited, "utf8") + "\n# Team review\n";
    writeFileSync(edited, source);
    assert.throws(
      () => writeOutput(out, plan, files, ownership),
      ownership === "team" ? /team-maintained/ : /edited or removed/,
    );
    assert.equal(readFileSync(edited, "utf8"), source);
  }
});

test("explicit repository shorthand shares canonical locks and integrity checks", (t) => {
  const { root } = fixture(t);
  const repository = resolve(root, "library");
  mkdirSync(resolve(repository, "plugin"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repository, encoding: "utf8" });
  git("init", "--quiet");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Synthetic test");
  writeFileSync(
    resolve(repository, "plugin/provider.yaml"),
    stringify({
      apiVersion: "ingestron.provider/v1",
      id: "adf",
      version: "1.1.0",
      platform: "adf",
      activities: {},
    }),
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture");
  git("tag", "1.1.0");
  const installed = execute({ root, allowWrite: true }, "packages_install", {
    reference: "example/provider@1.1.0",
    fromGit: "library",
  });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  for (const ref of [
    "example/provider@1.1.0",
    "example/provider@v1.1.0",
    "example/provider/plugin/provider.yaml@1.1.0",
  ]) {
    assert.equal(installPackage(root, ref, { frozen: true }).cached, true);
    assert.equal(
      resolvePackage(root, ref).entry.repository,
      "example/provider",
    );
  }
  assert.equal(
    Object.keys(
      parse(readFileSync(resolve(root, "packages.lock.yaml"), "utf8")).packages,
    ).length,
    2,
  );
  assert.throws(
    () => installPackage(root, "unknown@1.1.0", { fromGit: repository }),
    /Unknown plugin/,
  );
  assert.throws(
    () =>
      installPackage(root, "example/provider@latest", { fromGit: repository }),
    /exact semantic version/,
  );
  writeFileSync(
    resolvePackage(root, "example/provider@1.1.0").file,
    "tampered",
  );
  assert.throws(
    () => resolvePackage(root, "example/provider@v1.1.0"),
    /integrity/,
  );
});
