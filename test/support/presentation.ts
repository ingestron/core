import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { fixture } from "./project.js";
import { installPackage } from "../../src/core/packages.js";
import { digest } from "../../src/core/errors.js";
export function presentationFixture(t: any) {
  const f = fixture(t),
    origin = resolve(f.root, "fixture-origin");
  const manifest = parse(
    readFileSync(resolve(origin, "plugin/provider.yaml"), "utf8"),
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
  manifest.id = "reporter";
  manifest.version = "2.2.0";
  manifest.commands = {
    apiVersion: "ingestron.provider-commands/v1",
    execution: "offline-json",
    module: "./report.mjs",
    definitions: [
      {
        name: "report build",
        description: "Synthetic report generation",
        reportPack: true,
        inputSchema: {
          type: "object",
          required: [
            "reportPack",
            "receipt",
            "location",
            "lineage",
            "branding",
          ],
          properties: {
            reportPack: { type: "string" },
            receipt: { type: "object", additionalProperties: true },
            location: { type: "string" },
            lineage: { type: "object", additionalProperties: true },
            branding: { type: "object", additionalProperties: true },
          },
          additionalProperties: false,
        },
      },
    ],
  };
  f.put("fixture-origin/plugin/reporting.yaml", manifest);
  f.put(
    "fixture-origin/plugin/report.mjs",
    'export function command(r){return {apiVersion:"ingestron.artifact-proposal/v1",artifacts:{"README.md":"Synthetic reporting fixture", "report.json":JSON.stringify({model:r.input.modelPack.id,branding:r.input.branding,snapshot:r.input.receipt.sourceSnapshotId})}};}',
  );
  f.put("fixture-origin/model.yaml", {
    apiVersion: "ingestron.extension-pack/v2",
    kind: "model",
    id: "model",
    version: "2.2.0",
    description: "Synthetic",
    contracts: {
      customers: parse(
        readFileSync(
          resolve(f.root, "flows/source/contracts/customers.yaml"),
          "utf8",
        ),
      ),
    },
    provenance: {
      sources: ["Synthetic fixture"],
      retrieved: "2026-10-11",
      status: "documented-projection",
      notes: "Synthetic",
    },
  });
  f.put("fixture-origin/report.yaml", {
    apiVersion: "ingestron.extension-pack/v3",
    kind: "report",
    id: "report",
    version: "2.2.0",
    description: "Synthetic",
    platform: manifest.platform,
    model: "example/fixture/model.yaml@2.2.0",
    contractVersion: "1.0.0",
    report: {},
  });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: origin, stdio: "pipe" });
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "presentation fixture",
  );
  git("tag", "v2.2.0");
  for (const path of ["model.yaml", "report.yaml", "plugin/reporting.yaml"])
    installPackage(f.root, `example/fixture/${path}@2.2.0`, {
      fromGit: origin,
    });
  f.project.providers.packages.reporting = {
    source: "example/fixture/plugin/reporting.yaml",
    version: "2.2.0",
  };
  f.project.providers.configurations.reporting = {
    package: "reporting",
    binding: "lakehouse",
  };
  f.put("project.yaml", f.project);
  // Hash/ownership fixture, not evidence of a native Parquet runtime.
  f.put("snapshots/synthetic/customers.parquet", "synthetic-hash-fixture");
  f.put(
    "snapshots/synthetic/receipt.json",
    JSON.stringify({
      apiVersion: "ingestron.fixture-receipt/v1",
      status: "Succeeded",
      version: "1.0.0",
      sourceSnapshotId: "synthetic",
      synthetic: true,
      files: [
        {
          table: "customers",
          path: "customers.parquet",
          rows: 0,
          schema: [],
          sha256: digest("synthetic-hash-fixture"),
        },
      ],
    }),
  );
  const input = {
    name: "board",
    release: "r1",
    provider: "reporting",
    reportPack: "example/fixture/report.yaml@2.2.0",
    receipt: "snapshots/synthetic/receipt.json",
    command: "report build" as const,
    branding: { company: "Synthetic", primary: "#4338ca", accent: "#0891b2" },
    lineage: {
      source: "Synthetic fixture",
      mapping: "Synthetic model",
      execution: "Offline test",
      snapshotLabel: "Synthetic",
      synthetic: true,
      checks: ["Fixture hash"],
      limitations: ["Not a native runtime test"],
    },
  };
  return { ...f, input };
}
