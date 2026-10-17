/** Installed provider-owned settings review across SDK, CLI and read-only MCP. */
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const required = (key) => {
  const value = process.env["INGESTRON_ACCEPTANCE_" + key];
  assert.ok(value, key);
  return resolve(value);
};
const cliRoot = realpathSync(required("CLI_PACKAGE")),
  coreRoot = realpathSync(resolve(cliRoot, "../@ingestron/core")),
  cli = resolve(cliRoot, "build/cli/cli/index.js");
assert.equal(
  JSON.parse(readFileSync(resolve(coreRoot, "package.json"))).version,
  "0.12.22",
);
const { execute } = await import(
  pathToFileURL(resolve(coreRoot, "dist/sdk/index.js")).href
);
const require = createRequire(resolve(cliRoot, "package.json")),
  { parse, stringify } = require("yaml");
const { Client } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js"))
    .href
);
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js"))
    .href
);
const seed = JSON.parse(readFileSync(required("FIXTURE"), "utf8"));
assert.equal(seed.result, "passed");
mkdirSync(required("OUTPUT"), { recursive: true });
const root = mkdtempSync(resolve(required("OUTPUT"), "provider-settings-"));
cpSync(seed.root, root, {
  recursive: true,
  filter: (p) =>
    !["build", "runs", "jobs", "source-access", "runtime-cache"].includes(
      p.split("/").at(-1),
    ),
});
mkdirSync(resolve(root, "settings"), { recursive: true });
const projectFile = resolve(root, "project.yaml"),
  optionsFile = resolve(root, "settings/provider-options.yaml");
const project = parse(readFileSync(projectFile, "utf8"));
const view = {
  kind: "azure-sql",
  linkedService: "source_manifest",
  schema: "governance",
  view: "frozen_manifest",
};
project.providers.configurations.landing.options = {
  $resolve: "./settings/provider-options.yaml#/options",
};
writeFileSync(projectFile, stringify(project));
writeFileSync(
  optionsFile,
  "# Keep source-owner notes\noptions:\n  timeout: 00.01:00:00 # keep timeout\n  scheduleInputs:\n    manual:\n      kind: sql-server\n      linkedService: manual_manifest\n      schema: governance\n      view: manual_manifest # keep manual view\nelsewhere: keep\n",
);
const initialProject = readFileSync(projectFile, "utf8"),
  initialOptions = readFileSync(optionsFile, "utf8");
const hash = (file) =>
    createHash("sha256").update(readFileSync(file)).digest("hex"),
  lockHash = hash(resolve(root, "packages.lock.yaml"));
const context = {
  root,
  environment: "dev",
  allowWrite: false,
  allowExecute: false,
  allowNetwork: false,
};
const passed = (value) => {
  assert.equal(value.ok, true, JSON.stringify(value));
  return value.result;
};
const publicJson = (value) => JSON.parse(JSON.stringify(value));
const command = (operation, args, write = false) => {
  const child = spawnSync(
    process.execPath,
    [
      cli,
      "--project",
      root,
      "--env",
      "dev",
      "--json",
      "--no-input",
      "operation",
      operation,
      ...(write ? ["--allow-write"] : []),
    ],
    {
      input: JSON.stringify(args),
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.equal(child.error, undefined);
  assert.ok(child.stdout, child.stderr);
  return JSON.parse(child.stdout);
};
const client = new Client({
  name: "provider-options-installed",
  version: "1.0.0",
});
const checks = [];
let result = "failed";
const walk = (directory, prefix = "") =>
  Object.fromEntries(
    readdirSync(directory, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? Object.entries(
            walk(resolve(directory, e.name), prefix + e.name + "/"),
          )
        : [[prefix + e.name, hash(resolve(directory, e.name))]],
    ),
  );
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "--project", root, "advanced", "mcp", "serve"],
      stderr: "pipe",
    }),
  );
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const operation of [
    "provider_configuration_inspect",
    "provider_configuration_propose",
  ])
    assert.ok(names.includes("ingestron_" + operation));
  assert.ok(!names.includes("ingestron_apply"));
  assert.ok(!names.includes("ingestron_build"));
  const parity = async (operation, args, ok) => {
    const sdk = execute(context, operation, args);
    assert.equal(sdk.ok, ok, JSON.stringify(sdk));
    assert.deepEqual(command(operation, args), publicJson(sdk));
    const wire = await client.callTool({
      name: "ingestron_" + operation,
      arguments: args,
    });
    assert.deepEqual(JSON.parse(wire.content[0].text), publicJson(sdk));
    return sdk;
  };
  const inspected = passed(
    await parity(
      "provider_configuration_inspect",
      { configuration: "landing" },
      true,
    ),
  );
  assert.equal(inspected.available, true);
  assert.equal(inspected.valid, true);
  assert.equal(inspected.executionEnabled, false);
  assert.deepEqual(inspected.definition, {
    path: "settings/provider-options.yaml",
    pointer: ["options"],
  });
  assert.deepEqual(inspected.affectedFlows, [
    { id: "manual", default: true, profiles: [] },
    { id: "source", default: true, profiles: [] },
  ]);
  assert.equal(readFileSync(projectFile, "utf8"), initialProject);
  assert.equal(readFileSync(optionsFile, "utf8"), initialOptions);
  checks.push({
    check:
      "Actual immutable SDK/CLI/read-only MCP provider schema inspection and affected default flows; no source or execution permission",
    configuration: "landing",
    definition: inspected.definition,
  });
  assert.equal(execute(context, "plan", { flow: "source" }).ok, false);
  const options = {
    ...inspected.options,
    scheduleInputs: { ...inspected.options.scheduleInputs, source: view },
  };
  const args = {
    configuration: "landing",
    options,
    expectedDigest: inspected.digest,
  };
  const proposal = passed(
    await parity("provider_configuration_propose", args, true),
  );
  assert.equal(proposal.changes.length, 1);
  assert.equal(proposal.changes[0].path, "settings/provider-options.yaml");
  for (const comment of [
    "Keep source-owner notes",
    "keep timeout",
    "keep manual view",
  ])
    assert.ok(proposal.changes[0].after.includes(comment));
  assert.equal(readFileSync(optionsFile, "utf8"), initialOptions);
  assert.equal(
    execute(context, "apply", { proposal }).diagnostics[0].code,
    "PERMISSION",
  );
  assert.equal(
    command("apply", { proposal }).diagnostics[0].code,
    "PERMISSION",
  );
  passed(command("apply", { proposal }, true));
  assert.deepEqual(
    passed(
      await parity(
        "provider_configuration_inspect",
        { configuration: "landing" },
        true,
      ),
    ).options,
    options,
  );
  assert.equal(readFileSync(projectFile, "utf8"), initialProject);
  assert.equal(parse(readFileSync(optionsFile, "utf8")).elsewhere, "keep");
  checks.push({
    check:
      "Reviewable exact SDK/CLI/MCP proposal; explicit apply permission; authoritative referenced options, comments and neighbouring flow/settings preserved",
    proposal: proposal.id,
    changes: proposal.changes.map((c) => c.path),
  });
  const plan = passed(execute(context, "plan", { flow: "source" }));
  assert.deepEqual(
    command("plan", { flow: "source" }),
    publicJson(execute(context, "plan", { flow: "source" })),
  );
  passed(
    command("build", { flow: "source", out: "build/provider-settings" }, true),
  );
  const outputs = walk(resolve(root, "build/provider-settings"));
  const manifest = JSON.parse(
    readFileSync(
      resolve(root, "build/provider-settings/adf-schedules.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.schedules.length, 1);
  assert.deepEqual(manifest.schedules[0].tables, [
    "source/customers",
    "source/orders",
    "source/products",
  ]);
  const dataset = Object.keys(outputs).find(
    (p) =>
      p.startsWith("datasets/") &&
      readFileSync(
        resolve(root, "build/provider-settings", p),
        "utf8",
      ).includes('"frozen_manifest"'),
  );
  assert.ok(
    dataset,
    "Reviewed input view must reach an actual compiled native dataset",
  );
  checks.push({
    check:
      "Reviewed provider input view reaches immutable ADF three-table plan/build and native input dataset",
    planDigest: plan.digest,
    dataset,
    outputs,
  });
  const current = passed(
    execute(context, "provider_configuration_inspect", {
      configuration: "landing",
    }),
  );
  for (const bad of [
    { ...options, unexpected: true },
    { ...options, timeout: "invalid" },
    { ...options, scheduleInputs: { source: { ...view, kind: "sftp" } } },
    {
      ...options,
      scheduleInputs: { source: { ...view, view: "view;SELECT" } },
    },
  ]) {
    const denied = await parity(
      "provider_configuration_propose",
      { ...args, options: bad, expectedDigest: current.digest },
      false,
    );
    assert.equal(denied.diagnostics[0].code, "PROVIDER");
    assert.equal(denied.result, undefined);
  }
  assert.deepEqual(walk(resolve(root, "build/provider-settings")), outputs);
  checks.push({
    check:
      "Provider schema refuses unknown fields, invalid timeout, unsupported source kind and unsafe view identifier before preview; generated files preserved",
  });
  const removed = {
    ...options,
    scheduleInputs: { manual: options.scheduleInputs.manual },
  };
  const removal = passed(
    execute(context, "provider_configuration_propose", {
      ...args,
      options: removed,
      expectedDigest: current.digest,
    }),
  );
  passed(
    execute({ ...context, allowWrite: true }, "apply", { proposal: removal }),
  );
  assert.equal(execute(context, "plan", { flow: "source" }).ok, false);
  assert.deepEqual(walk(resolve(root, "build/provider-settings")), outputs);
  assert.equal(
    (
      await parity(
        "provider_configuration_propose",
        { ...args, expectedDigest: current.digest },
        false,
      )
    ).diagnostics[0].code,
    "STALE",
  );
  const latest = passed(
    execute(context, "provider_configuration_inspect", {
      configuration: "landing",
    }),
  );
  const restored = passed(
    execute(context, "provider_configuration_propose", {
      ...args,
      expectedDigest: latest.digest,
    }),
  );
  passed(
    execute({ ...context, allowWrite: true }, "apply", { proposal: restored }),
  );
  passed(
    command("build", { flow: "source", out: "build/provider-settings" }, true),
  );
  assert.deepEqual(walk(resolve(root, "build/provider-settings")), outputs);
  checks.push({
    check:
      "Required input removal fails closed without replacing native assets; stale inspected options denied and reviewed restoration reproduces exact native assets",
  });
  const stable = passed(
    execute(context, "provider_configuration_inspect", {
      configuration: "landing",
    }),
  );
  const staleProposal = passed(
    execute(context, "provider_configuration_propose", {
      ...args,
      options: { ...options, timeout: "00.02:00:00" },
      expectedDigest: stable.digest,
    }),
  );
  const schemaPath = Object.keys(staleProposal.inputs).find((p) =>
    p.endsWith("configuration.schema.json"),
  );
  assert.ok(schemaPath);
  const schemaBytes = readFileSync(resolve(root, schemaPath), "utf8");
  writeFileSync(resolve(root, schemaPath), schemaBytes + "\n");
  const before = readFileSync(optionsFile, "utf8");
  assert.equal(
    command("apply", { proposal: staleProposal }, true).diagnostics[0].code,
    "STALE",
  );
  assert.equal(readFileSync(optionsFile, "utf8"), before);
  writeFileSync(resolve(root, schemaPath), schemaBytes);
  assert.equal(hash(resolve(root, "packages.lock.yaml")), lockHash);
  checks.push({
    check:
      "Locked provider schema byte change invalidates an already reviewed proposal before writes; original schema and lock restored",
    schemaPath,
  });
  result = "passed";
} finally {
  await client.close();
  writeFileSync(
    required("PROOF"),
    JSON.stringify(
      {
        apiVersion: "ingestron.provider-configuration-installed/v1",
        result,
        root,
        cli,
        coreVersion: "0.12.22",
        cliVersion: "0.17.10",
        provider: seed.provider,
        archives: Object.fromEntries(
          ["CORE_ARCHIVE", "CLI_ARCHIVE"].map((key) => [
            key,
            { path: required(key), sha256: hash(required(key)) },
          ]),
        ),
        checks,
        limits:
          "Immutable installed SDK/CLI/read-only MCP and locked native ADF asset preparation only; no source reads, native deployment/activation/execution, visual browser/editor or source consistency qualification.",
      },
      null,
      2,
    ) + "\n",
  );
}
console.log(JSON.stringify({ result, checks: checks.length }));
