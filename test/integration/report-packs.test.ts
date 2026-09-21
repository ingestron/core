import { apply } from "../../src/core/authoring.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { stringify, parse } from "yaml";
import { fixture } from "../support/project.js";
import { installPackage } from "../../src/core/packages.js";
import { runProviderCommand } from "../../src/core/provider-commands.js";
import { exportProviderArtifacts } from "../../src/core/development.js";
import { taggedVersions } from "../../src/core/package-references.js";
test("report pack and common model resolve from immutable installed inventories", (t) => {
  const f = fixture(t),
    repo = resolve(f.root, "report-package");
  mkdirSync(resolve(repo, "plugin"), { recursive: true });
  mkdirSync(resolve(repo, "packs"));
  const model = {
    apiVersion: "ingestron.extension-pack/v2",
    kind: "model",
    id: "model",
    version: "1.0.0",
    description: "Synthetic model",
    contracts: {
      customers: parse(
        readFileSync(
          resolve(f.root, "flows/source/contracts/customers.yaml"),
          "utf8",
        ),
      ),
    },
    provenance: {
      sources: ["https://example.invalid"],
      retrieved: "2026-09-15",
      status: "recorded-schema",
      notes: "Synthetic",
    },
  };
  const pack = {
    apiVersion: "ingestron.extension-pack/v3",
    kind: "report",
    id: "report",
    version: "1.0.0",
    description: "Synthetic report",
    platform: "adf",
    model: "example/report/packs/model.yaml@1.0.0",
    contractVersion: "1.0.0",
    report: { title: "Test" },
  };
  const provider = {
    apiVersion: "ingestron.provider/v1",
    id: "reporter",
    version: "1.0.0",
    platform: "adf",
    activities: {},
    commands: {
      apiVersion: "ingestron.provider-commands/v1",
      execution: "offline-json",
      module: "./index.mjs",
      definitions: [
        {
          name: "report build",
          description: "Synthetic renderer",
          reportPack: true,
          inputSchema: {
            type: "object",
            required: ["reportPack"],
            additionalProperties: false,
            properties: { reportPack: { type: "string" } },
          },
        },
      ],
    },
  };
  for (const [file, value] of [
    ["packs/model.yaml", model],
    ["packs/report.yaml", pack],
    ["plugin/provider.yaml", provider],
  ] as const)
    writeFileSync(resolve(repo, file), stringify(value));
  writeFileSync(
    resolve(repo, "plugin/index.mjs"),
    "export function command(r){return {model:r.input.modelPack.id,pack:r.input.reportPack.id,lock:r.input.reportLock};}",
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  git("tag", "1.0.0");
  for (const p of [
    "plugin/provider.yaml",
    "packs/report.yaml",
    "packs/model.yaml",
  ])
    installPackage(f.root, `example/report/${p}@1.0.0`, { fromGit: repo });
  f.project.providers.packages.dbx = {
    source: "example/report",
    version: "1.0.0",
  };
  f.put("project.yaml", f.project);
  const result = runProviderCommand(f.root, "dev", {
    configuration: "engineering",
    command: "report build",
    input: { reportPack: "example/report/packs/report.yaml@1.0.0" },
  });
  assert.equal(result.result.model, "model");
  assert.equal(result.result.pack, "report");
  assert.match(String(result.reportLock?.modelCommit), /^[a-f0-9]{40}$/);
  assert.throws(
    () =>
      runProviderCommand(f.root, "dev", {
        configuration: "engineering",
        command: "report build",
        input: { reportPack: "example/missing@1.0.0" },
      }),
    /install|lock|locked/i,
  );
});
test("nested native assets export create-only and reject traversal", (t) => {
  const f = fixture(t);
  const value = {
    apiVersion: "ingestron.provider-command-result/v1",
    execution: "offline-json",
    result: {
      apiVersion: "ingestron.artifact-proposal/v1",
      artifacts: {
        "Report.Report/definition/pages/page/page.json": "{}",
        "Report.pbip": "{}",
        "Report.Report/StaticResources/logo.svg": "<svg/>",
      },
    },
  };
  f.put("result.json", JSON.stringify(value));
  apply(f.root, exportProviderArtifacts(f.root, "result.json", "report"));
  assert.throws(
    () => exportProviderArtifacts(f.root, "result.json", "report"),
    /Existing artifact/,
  );
  value.result.artifacts = { "../outside.json": "{}" } as any;
  f.put("result.json", JSON.stringify(value));
  assert.throws(
    () => exportProviderArtifacts(f.root, "result.json", "report"),
    /artifact/,
  );
});
test("component tag prefixes keep co-located packs independently versioned", () => {
  const a = "a".repeat(40),
    b = "b".repeat(40);
  const list = `${a}\trefs/tags/finance-model-v0.1.0\n${b}\trefs/tags/finance-report-v0.1.0\n${b}\trefs/tags/v0.1.0`;
  assert.equal(taggedVersions(list, "finance-model-")[0].commit, a);
  assert.equal(taggedVersions(list, "finance-report-")[0].commit, b);
  assert.equal(
    taggedVersions(list, "finance-model-")[0].tag,
    "finance-model-v0.1.0",
  );
  assert.equal(taggedVersions(list).length, 1);
});
