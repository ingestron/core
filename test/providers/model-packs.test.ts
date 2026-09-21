import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ecosystem } from "../support/ecosystem.js";
import { planProject } from "../../src/core/planner.js";
import { validateModelPack } from "../../src/core/model-pack-schema.js";
import {
  canonicalPackageReference,
  installPackage,
  resolvePackage,
} from "../../src/core/packages.js";
import { execute } from "../../src/core/operations.js";
import { apply } from "../../src/core/authoring.js";
import { parse } from "yaml";
function model(t: any) {
  const f = ecosystem(t);
  const contract = parse(
    readFileSync(
      resolve(f.root, "flows/source/contracts/customers.yaml"),
      "utf8",
    ),
  );
  const pack: any = {
    apiVersion: "ingestron.extension-pack/v2",
    kind: "model",
    id: "sample",
    version: "1.0.0",
    description: "Synthetic reusable model",
    contracts: { customers: contract },
    relationships: [],
    provenance: {
      sources: ["synthetic fixture"],
      retrieved: "2026-09-14",
      status: "recorded-schema",
      notes: "No real source data",
    },
  };
  f.put("models/pack.yaml", pack);
  (f.project as any).modelPacks = {
    sample: { source: "./models/pack.yaml", version: "1.0.0" },
  };
  for (const flow of f.project.flows as any[])
    flow.publishes.customers.contract = { $model: "sample:customers" };
  f.save();
  return { ...f, modelPack: pack };
}
test("one model reaches distinct providers unchanged and is fingerprinted", (t) => {
  const f = model(t);
  const p = planProject(f.root, "dev", { delivery: true });
  assert.equal(new Set(p.nodes.map((n) => n.platform)).size, 2);
  for (const node of p.nodes)
    assert.deepEqual(node.contract, f.modelPack.contracts.customers);
  const first = JSON.stringify(p);
  f.modelPack.contracts.customers.description = {
    purpose: "Reviewed revision",
  };
  f.put("models/pack.yaml", f.modelPack);
  assert.notEqual(
    JSON.stringify(planProject(f.root, "dev", { delivery: true })),
    first,
  );
});
test("model packs reject hooks, directives, invalid ODCS and invalid relationships", (t) => {
  const f = model(t);
  for (const change of [
    (p: any) => (p.renderer = { module: "evil.mjs" }),
    (p: any) => (p.contracts.customers = { $resolve: "../outside.yaml" }),
    (p: any) => (p.contracts.customers.apiVersion = "wrong"),
    (p: any) =>
      (p.relationships = [
        {
          id: "bad",
          from: "customers",
          fields: ["name"],
          to: "customers",
          references: ["missing"],
        },
      ]),
    (p: any) =>
      (p.relationships = [
        {
          id: "bad",
          from: "customers",
          fields: ["name"],
          to: "customers",
          references: ["id"],
        },
      ]),
  ]) {
    const p = structuredClone(f.modelPack);
    change(p);
    assert.throws(() => validateModelPack(p));
  }
});
test("unknown models, selector mismatches and inline overrides fail closed", (t) => {
  const f = model(t);
  (f.project as any).modelPacks.sample.version = "9.0.0";
  f.save();
  assert.throws(() => planProject(f.root), /version differs/);
  (f.project as any).modelPacks.sample.version = "1.0.0";
  (f.project.flows as any[])[0].publishes.customers.contract = {
    $model: "sample:missing",
  };
  f.save();
  assert.throws(() => planProject(f.root), /Unknown model/);
  (f.project.flows as any[])[0].publishes.customers.contract = {
    $model: "sample:customers",
    description: "override",
  };
  f.save();
  assert.throws(() => planProject(f.root), /overrides/);
});
test("installed model packs lock, configure without a provider and reject cache tampering", (t) => {
  const f = model(t);
  const origin = resolve(f.root, "models");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: origin, stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "model",
  );
  git("tag", "1.0.0");
  const ref = "test/models/pack.yaml@1.0.0";
  installPackage(f.root, ref, { fromGit: origin });
  installPackage(f.root, ref, { fromGit: origin, frozen: true });
  const r: any = execute({ root: f.root }, "pack_configure", {
    reference: ref,
    name: "installed",
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  apply(f.root, r.result);
  assert.equal(
    execute({ root: f.root }, "pack_configure", {
      reference: ref,
      name: "bad",
      provider: "load",
    }).ok,
    false,
  );
  assert.equal(
    execute({ root: f.root }, "pack_configure", {
      reference: ref,
      name: "installed",
    }).ok,
    false,
  );
  planProject(f.root, "dev", { delivery: true });
  const file = resolvePackage(f.root, ref).file;
  writeFileSync(file, readFileSync(file, "utf8") + "\n# changed\n");
  assert.throws(() => planProject(f.root), /integrity|changed|digest|hash/i);
  assert.equal(
    canonicalPackageReference("example/models/packs/model.yaml@v0.1.0"),
    "example/models/packs/model.yaml@0.1.0",
  );
  assert.throws(
    () => canonicalPackageReference("unknown@0.1.0"),
    /explicit owner/,
  );
});
