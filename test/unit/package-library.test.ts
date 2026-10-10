import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { fixture } from "../support/project.js";
import { execute } from "../../src/core/operations.js";
import { resolvePackage } from "../../src/core/packages.js";
const ok = (r: any) => {
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  return r.result;
};

test("general library installation preserves exact pack references and reviews registration without executing providers", (t) => {
  const f = fixture(t),
    origin = join(f.root, "fixture-origin");
  writeFileSync(
    join(origin, "model.yaml"),
    stringify({
      apiVersion: "ingestron.extension-pack/v2",
      kind: "model",
      id: "business",
      version: "2.0.0",
      description: "Synthetic model",
      contracts: {
        customers: parse(
          readFileSync(
            join(f.root, "flows/source/contracts/customers.yaml"),
            "utf8",
          ),
        ),
      },
      provenance: {
        sources: ["Synthetic test"],
        retrieved: "2026-10-11",
        status: "documented-projection",
        notes: "Synthetic fixture only",
      },
    }),
  );
  writeFileSync(
    join(origin, "report.yaml"),
    stringify({
      apiVersion: "ingestron.extension-pack/v3",
      kind: "report",
      id: "report",
      version: "2.0.0",
      description: "Synthetic report",
      platform: "example",
      model: "example/fixture/model.yaml@2.0.0",
      contractVersion: "1.0.0",
      report: {},
    }),
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
    "model and report fixtures",
  );
  git("tag", "packs-v2.0.0");
  const ctx = { root: f.root },
    write = { ...ctx, allowWrite: true };
  for (const name of ["model", "report"]) {
    const args = {
      reference: `example/fixture/${name}.yaml@2.0.0`,
      fromGit: "fixture-origin",
      tagPrefix: "packs-",
    };
    const before = readFileSync(join(f.root, "packages.lock.yaml"), "utf8");
    assert.equal(
      execute(ctx, "package_install_review", { reference: args.reference })
        .diagnostics[0].code,
      "PERMISSION",
    );
    const review = ok(execute(ctx, "package_install_review", args));
    assert.equal(
      readFileSync(join(f.root, "packages.lock.yaml"), "utf8"),
      before,
    );
    assert.equal(review.proposal.kind, `${name}-pack`);
    assert.equal(review.executionEnabled, false);
    assert.equal(review.proposal.reference, args.reference);
    const request = { proposal: review.proposal, fromGit: args.fromGit };
    assert.equal(
      execute(ctx, "package_install_apply", request).diagnostics[0].code,
      "PERMISSION",
    );
    assert.equal(
      execute(write, "package_install_apply", {
        ...request,
        proposal: { ...review.proposal, packageDigest: "0".repeat(64) },
      }).diagnostics[0].code,
      "STALE",
    );
    const result = ok(execute(write, "package_install_apply", request));
    assert.equal(result.commit, review.proposal.commit);
    assert.equal(
      resolvePackage(f.root, args.reference).entry.commit,
      result.commit,
    );
    assert.equal(
      execute(write, "package_install_apply", request).diagnostics[0].code,
      "STALE",
    );
  }
  const library = ok(execute(ctx, "package_library", {}));
  assert.equal(
    library.packages.find((p: any) => p.id === "report").presentation,
    true,
  );
  const model = library.packages.find((p: any) => p.id === "business");
  const before = readFileSync(join(f.root, "project.yaml"), "utf8");
  const proposal = ok(
    execute(ctx, "package_configure_review", {
      reference: model.reference,
      name: "business",
    }),
  );
  assert.equal(readFileSync(join(f.root, "project.yaml"), "utf8"), before);
  ok(execute(write, "apply", { proposal }));
  assert.equal(
    parse(readFileSync(join(f.root, "project.yaml"), "utf8")).modelPacks
      .business.version,
    "2.0.0",
  );
  assert.equal(
    execute(ctx, "package_configure_review", {
      reference: "example/fixture/report.yaml@2.0.0",
      name: "report",
    }).diagnostics[0].code,
    "CAPABILITY",
  );
});

test("general provider review accepts lifecycle packages without guided cloud bindings and rejects a stale project", (t) => {
  const f = fixture(t),
    ctx = { root: f.root };
  const review = ok(
    execute(ctx, "package_install_review", {
      reference: "example/fixture@1.0.0",
      fromGit: "fixture-origin",
    }),
  );
  assert.equal(review.proposal.kind, "provider");
  f.put("project.yaml", { ...f.project, description: "Changed after review" });
  assert.equal(
    execute({ ...ctx, allowWrite: true }, "package_install_apply", {
      proposal: review.proposal,
      fromGit: "fixture-origin",
    }).diagnostics[0].code,
    "STALE",
  );
});

test("offline command providers receive reviewed namespaced bindings without replacing project defaults", (t) => {
  const f = fixture(t),
    origin = join(f.root, "fixture-origin");
  const manifest = parse(
    readFileSync(join(origin, "plugin/provider.yaml"), "utf8"),
  );
  for (const key of [
    "lifecycle",
    "planner",
    "renderer",
    "authoring",
    "configurationSchema",
    "platformBinding",
  ])
    delete manifest[key];
  manifest.id = "reporting";
  manifest.commands = {
    apiVersion: "ingestron.provider-commands/v1",
    execution: "offline-json",
    module: "./report-command.mjs",
    definitions: [
      {
        name: "report build",
        description: "Synthetic offline command",
        inputSchema: { type: "object", additionalProperties: false },
      },
    ],
  };
  writeFileSync(join(origin, "plugin/reporting.yaml"), stringify(manifest));
  writeFileSync(
    join(origin, "plugin/report-command.mjs"),
    "export function command() { return {synthetic:true}; }",
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
    "command provider",
  );
  const reference = `example/fixture/plugin/reporting.yaml@${git("rev-parse", "HEAD").trim()}`;
  const ctx = { root: f.root },
    write = { ...ctx, allowWrite: true };
  const review = ok(
    execute(ctx, "package_install_review", {
      reference,
      fromGit: "fixture-origin",
    }),
  );
  ok(
    execute(write, "package_install_apply", {
      proposal: review.proposal,
      fromGit: "fixture-origin",
    }),
  );
  const proposal = ok(
    execute(ctx, "package_configure_review", { reference, name: "reporting" }),
  );
  ok(execute(write, "apply", { proposal }));
  const saved = parse(readFileSync(join(f.root, "project.yaml"), "utf8"));
  assert.deepEqual(saved.defaults, f.project.defaults);
  assert.deepEqual(
    saved.environments.dev.bindings.lakehouse,
    f.project.environments.dev.bindings.lakehouse,
  );
  assert.deepEqual(saved.environments.dev.bindings.reporting_command, {
    kind: manifest.platform,
  });
  assert.equal(
    saved.providers.configurations.reporting.binding,
    "reporting_command",
  );
  const command = ok(
    execute(ctx, "provider_command", {
      configuration: "reporting",
      command: "report build",
      input: {},
    }),
  );
  assert.deepEqual(command.result, { synthetic: true });
});
