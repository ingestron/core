import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { installPackage } from "../../src/core/packages.js";
import { friendlyReference } from "../../src/core/package-references.js";
import { initialise, apply, addFlow } from "../../src/core/authoring.js";

test("installed nested provider manifests survive project and flow authoring with exact locked paths", (t) => {
  const base = mkdtempSync(join(tmpdir(), "ingestron-nested-provider-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repository"),
    root = join(base, "project"),
    dir = join(repo, "current-provider/plugin");
  mkdirSync(dir, { recursive: true });
  mkdirSync(root);
  writeFileSync(
    join(dir, "provider.yaml"),
    stringify({
      apiVersion: "ingestron.provider/v1",
      id: "nested-provider",
      version: "1.0.0",
      platform: "synthetic",
      activities: {},
      lifecycle: {
        apiVersion: "ingestron.provider-lifecycle/v1",
        module: "./author.mjs",
      },
    }),
  );
  writeFileSync(
    join(dir, "author.mjs"),
    `export function author(r) { if(r.operation === 'initialise') return {files:{'project.yaml':JSON.stringify({apiVersion:'ingestron.project/v1',id:r.options.id,providers:{packages:{native:r.provider},configurations:{native:{package:'native',binding:'runtime'}}},defaults:{provider:'native'},environments:{dev:{$resolve:'environments/dev.yaml'}},flows:[]}),'environments/dev.yaml':JSON.stringify({apiVersion:'ingestron.environment/v1',environment:'dev',bindings:{runtime:{kind:'synthetic'}},values:{}})}}; return {files:{['flows/'+r.options.id+'/flow.yaml']:JSON.stringify({apiVersion:'ingestron.flow/v1',id:r.options.id,kind:'ingestion',provider:r.configuration,defaults:{source:{},with:{}},ingestion:{standard:'synthetic@v1'},tables:{}})}}; }`,
  );
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repo,
      stdio: "ignore",
    });
  git(["init", "-q"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@example.invalid",
    "commit",
    "-qm",
    "synthetic",
  ]);
  git(["tag", "package-1.0.0"]);
  const reference =
    "example/provider/current-provider/plugin/provider.yaml@1.0.0";
  const lock = installPackage(root, reference, {
    fromGit: repo,
    tagPrefix: "package-",
  });
  assert.equal(lock.path, "current-provider/plugin/provider.yaml");
  apply(
    root,
    initialise(root, {
      id: "synthetic",
      provider: reference,
      environments: ["dev"],
    }),
  );
  const project = parse(readFileSync(join(root, "project.yaml"), "utf8"));
  assert.equal(project.packages.native, "nested-provider@1.0.0");
  apply(root, addFlow(root, { id: "orders", kind: "ingestion" }));
  assert.equal(
    parse(readFileSync(join(root, "flows/orders/flow.yaml"), "utf8")).provider,
    "native",
  );
  const sha = "a".repeat(40);
  assert.equal(friendlyReference(reference), reference);
  assert.equal(
    friendlyReference(
      `example/provider/current-provider/plugin/provider.yaml@${sha}`,
    ),
    `example/provider/current-provider/plugin/provider.yaml@${sha}`,
  );
  assert.equal(
    friendlyReference("example/provider/plugin/provider.yaml@v1.0.0"),
    "example/provider@1.0.0",
  );
  assert.equal(
    friendlyReference("example/provider/packs/provider.yaml@1.0.0"),
    "example/provider/packs/provider.yaml@1.0.0",
  );
});
