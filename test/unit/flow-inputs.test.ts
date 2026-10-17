import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { fixture } from "../support/project.js";
import { installPackage } from "../../src/core/packages.js";
import { readFlowEditor } from "../../src/core/flow-editor.js";

test("locked provider input inspection is bounded, fail-closed and does not write project definitions", (t) => {
  const f = fixture(t);
  assert.equal(readFlowEditor(f.root).providers[0].inputDatasets, undefined);
  const origin = join(f.root, "fixture-origin");
  const file = join(origin, "plugin/provider.yaml");
  const manifest = parse(readFileSync(file, "utf8"));
  manifest.version = "1.0.1";
  manifest.compatibility.requiredFeatures = [
    "flow-authoring-capabilities",
    "flow-input-inspection",
    "transformation-authoring-settings",
  ];
  manifest.authoring = {
    transformationSettingsSchema: {},
    flows: {
      apiVersion: "ingestron.flow-authoring/v1",
      kinds: ["transformation"],
      ingestionStandards: [],
      prerequisites: [],
      transformationInputs: "provider/v1",
    },
  };
  writeFileSync(file, stringify(manifest));
  writeFileSync(
    join(origin, "plugin/index.mjs"),
    `export function author(r) {
    if(r.operation !== 'flow_inputs') throw Error('unexpected operation');
    const id = r.project.id + '.source.orders.current';
    const datasets = r.configuration === 'unknown' ? ['other.source.current'] : r.configuration === 'duplicate' ? [id,id] : r.configuration === 'empty' ? [] : [id];
    return {files:{'inputs.json':r.configuration === 'malformed' ? '{}' : JSON.stringify({apiVersion:'ingestron.flow-inputs/v1', datasets})}};
  }`,
  );
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
    "inputs",
  );
  git("tag", "1.0.1");
  installPackage(f.root, "example/fixture@1.0.1", { fromGit: origin });
  f.project.providers.packages.dbx.version = "1.0.1";
  for (const id of ["unknown", "duplicate", "malformed", "empty"])
    f.project.providers.configurations[id] = {
      package: "dbx",
      binding: "lakehouse",
    };
  f.put("project.yaml", f.project);
  const before = readFileSync(join(f.root, "project.yaml"), "utf8");
  const result = readFlowEditor(f.root);
  assert.deepEqual(
    result.providers.find((p) => p.id === "engineering")?.inputDatasets,
    ["retail.source.orders.current"],
  );
  assert.deepEqual(
    result.providers.find((p) => p.id === "empty")?.inputDatasets,
    [],
  );
  for (const id of ["unknown", "duplicate", "malformed"])
    assert.equal(result.providers.find((p) => p.id === id)?.available, false);
  assert.equal(readFileSync(join(f.root, "project.yaml"), "utf8"), before);
});
