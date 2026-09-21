import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { stringify } from "yaml";
import { fixture } from "../support/project.js";
import { execute } from "../../src/core/operations.js";
import { installPackage, resolvePackage } from "../../src/core/packages.js";

function setup(
  t: any,
  code = `export function command(request) { return {echo:request.input, context:request.context}; }`,
  schema: any = {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: { name: { type: "string" } },
  },
  namespace?: string,
) {
  const f = fixture(t),
    repo = resolve(f.root, "package");
  mkdirSync(resolve(repo, "plugin"), { recursive: true });
  writeFileSync(
    resolve(repo, "plugin/provider.yaml"),
    stringify({
      apiVersion: "ingestron.provider/v1",
      id: "synthetic",
      version: "1.0.0",
      platform: "adf",
      activities: {},
      compatibility: { plan: "ingestron.plan/v1", minimumCli: "2.4.0" },
      commands: {
        apiVersion: "ingestron.provider-commands/v1",
        execution: "offline-json",
        ...(namespace ? { namespace } : {}),
        module: "./commands.mjs",
        definitions: [
          {
            name: "discover import",
            description: "Synthetic import",
            inputSchema: schema,
          },
        ],
      },
    }),
  );
  writeFileSync(resolve(repo, "plugin/commands.mjs"), code);
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
  installPackage(f.root, "example/commands@1.0.0", { fromGit: repo });
  f.project.providers.packages.dbx = {
    source: "example/commands",
    version: "1.0.0",
  };
  writeFileSync(resolve(f.root, "project.yaml"), stringify(f.project));
  const run = (
    operation: "provider_commands" | "provider_command",
    args: any,
  ) =>
    execute(
      {
        root: f.root,
        environment: "dev",
        allowWrite: false,
        allowNetwork: false,
      },
      operation,
      { configuration: "engineering", ...args },
    );
  return { ...f, run };
}

test("namespace discovery is data-only and target selection reuses provider semantics", (t) => {
  const f = setup(t);
  const ctx = { root: f.root };
  const catalogue = execute(ctx, "plugin_commands");
  assert.equal(catalogue.ok, true, JSON.stringify(catalogue));
  assert.equal(catalogue.result.bindings[0].namespace, "synthetic");
  const args = {
    namespace: "synthetic",
    command: "discover import",
    input: { name: "sample" },
  };
  assert.deepEqual(
    execute(ctx, "plugin_command", args).result,
    f.run("provider_command", { command: args.command, input: args.input })
      .result,
  );
  f.project.providers.configurations.second = {
    ...f.project.providers.configurations.engineering,
  };
  writeFileSync(resolve(f.root, "project.yaml"), stringify(f.project));
  assert.equal(
    execute(ctx, "plugin_command", args).diagnostics[0]?.code,
    "COMMAND_TARGET",
  );
  assert.equal(
    execute(ctx, "plugin_command", { ...args, target: "engineering" }).ok,
    true,
  );
  assert.equal(
    execute(ctx, "plugin_command", { ...args, target: "missing" }).ok,
    false,
  );
  const hostile = setup(t, `throw new Error("must not execute discovery");`);
  assert.equal(execute({ root: hostile.root }, "plugin_commands").ok, true);
});
test("namespace cannot shadow a core command", (t) => {
  const f = setup(
    t,
    `throw new Error("must not execute");`,
    { type: "object" },
    "plugin",
  );
  assert.equal(
    execute({ root: f.root }, "plugin_commands").diagnostics[0]?.code,
    "COMMAND_NAMESPACE",
  );
});

test("different locked packages cannot claim one namespace", (t) => {
  const f = setup(t);
  installPackage(f.root, "example/other@1.0.0", {
    fromGit: resolve(f.root, "package"),
  });
  f.project.providers.packages.other = {
    source: "example/other",
    version: "1.0.0",
  };
  f.project.providers.configurations.second = {
    ...f.project.providers.configurations.engineering,
    package: "other",
  };
  writeFileSync(resolve(f.root, "project.yaml"), stringify(f.project));
  const result = execute({ root: f.root }, "plugin_commands");
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, "COMMAND_NAMESPACE");
});
