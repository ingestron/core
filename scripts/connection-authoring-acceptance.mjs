/** Installed all-source authoring parity; synthetic configuration only, no source execution. */
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
for (const key of [
  "INGESTRON_ACCEPTANCE_CLI_PACKAGE",
  "INGESTRON_ACCEPTANCE_FIXTURE",
  "INGESTRON_ACCEPTANCE_OUTPUT",
  "INGESTRON_ACCEPTANCE_PROOF",
])
  assert.ok(process.env[key], "Set " + key);
const cliRoot = realpathSync(process.env.INGESTRON_ACCEPTANCE_CLI_PACKAGE),
  coreRoot = realpathSync(resolve(cliRoot, "../@ingestron/core")),
  cli = resolve(cliRoot, "build/cli/cli/index.js"),
  require = createRequire(resolve(cliRoot, "package.json"));
const { parse, stringify } = require("yaml"),
  { execute, executeAsync } = await import(
    pathToFileURL(resolve(coreRoot, "dist/sdk/index.js")).href
  );
const { Client } = await import(
    pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js"))
      .href
  ),
  { StdioClientTransport } = await import(
    pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js"))
      .href
  );
const seed = JSON.parse(
  readFileSync(resolve(process.env.INGESTRON_ACCEPTANCE_FIXTURE), "utf8"),
);
assert.equal(seed.result, "passed");
assert.equal(seed.records.length, 16);
const base = resolve(process.env.INGESTRON_ACCEPTANCE_OUTPUT);
mkdirSync(base, { recursive: true });
const root = mkdtempSync(resolve(base, "connection-authoring-"));
for (const path of [
  "project.yaml",
  "packages.lock.yaml",
  ".ingestron/packages",
])
  cpSync(resolve(seed.root, path), resolve(root, path), { recursive: true });
const path = resolve(root, "project.yaml"),
  original = readFileSync(path, "utf8"),
  project = parse(original),
  lockBefore = readFileSync(resolve(root, "packages.lock.yaml"), "utf8");
const context = {
    root,
    environment: "dev",
    allowWrite: false,
    allowExecute: false,
    allowNetwork: false,
  },
  records = [],
  checks = [],
  publicJson = (value) => JSON.parse(JSON.stringify(value));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const command = (operation, args) => {
  const value = spawnSync(
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
    ],
    {
      input: JSON.stringify(args),
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  assert.equal(value.error, undefined);
  return JSON.parse(value.stdout);
};
const client = new Client({
  name: "connection-authoring-matrix",
  version: "1.0.0",
});
let result = "failed";
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "--project", root, "advanced", "mcp", "serve"],
      stderr: "pipe",
    }),
  );
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const operation of [
    "connection_add",
    "connection_setup",
    "connection_configure",
  ])
    assert.ok(names.includes("ingestron_" + operation));
  assert.ok(!names.includes("ingestron_apply"));
  assert.ok(!names.includes("ingestron_connection_test"));
  const viaMcp = async (operation, args) =>
    JSON.parse(
      (
        await client.callTool({
          name: "ingestron_" + operation,
          arguments: args,
        })
      ).content[0].text,
    );
  const parity = async (operation, args, expected) => {
    const sdk = execute(context, operation, args),
      terminal = command(operation, args),
      mcp = await viaMcp(operation, args);
    assert.equal(sdk.ok, expected, JSON.stringify(sdk));
    assert.deepEqual(terminal, publicJson(sdk));
    assert.deepEqual(mcp, publicJson(sdk));
    return sdk;
  };
  for (const entry of seed.records) {
    const connection = project.connections[entry.id],
      id = "authored_" + entry.id.replaceAll("-", "_"),
      add = {
        id,
        package: connection.package,
        sourceId: id,
        tenantId: "synthetic",
        settings: connection.settings,
      },
      configure = {
        id: entry.id,
        sourceId: id,
        tenantId: "reviewed",
        settings: connection.settings,
      };
    const configured = await parity("connection_configure", configure, true),
      added = await parity("connection_add", add, true);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.equal(
      execute(context, "apply", { proposal: configured.result }).diagnostics[0]
        .code,
      "PERMISSION",
    );
    for (const operation of ["connection_add", "connection_configure"]) {
      const args = operation === "connection_add" ? add : configure;
      const denied = await parity(
        operation,
        {
          ...args,
          settings: { ...args.settings, unexpected: "PRIVATE_INVALID_SETTING" },
        },
        false,
      );
      assert.equal(denied.diagnostics[0].code, "CONNECTION");
      assert.equal(
        JSON.stringify(denied).includes("PRIVATE_INVALID_SETTING"),
        false,
      );
      assert.equal(denied.result, undefined);
    }
    const changed = parse(configured.result.changes[0].after);
    for (const neighbor of Object.keys(project.connections).filter(
      (name) => name !== entry.id,
    ))
      assert.deepEqual(
        changed.connections[neighbor],
        project.connections[neighbor],
      );
    assert.deepEqual(changed.connections[entry.id], {
      ...connection,
      sourceId: id,
      tenantId: "reviewed",
    });
    assert.equal(
      execute({ ...context, allowWrite: true }, "apply", {
        proposal: configured.result,
      }).ok,
      true,
    );
    const access = await executeAsync(context, "connection_access", {
      connection: entry.id,
    });
    assert.equal(access.ok, true, JSON.stringify(access));
    assert.deepEqual(access.result.actions, entry.actions);
    assert.notEqual(access.result.fingerprint, entry.fingerprint);
    writeFileSync(path, original);
    assert.equal(
      execute({ ...context, allowWrite: true }, "apply", {
        proposal: added.result,
      }).ok,
      true,
    );
    assert.deepEqual(
      parse(readFileSync(path, "utf8")).connections[id].settings,
      connection.settings,
    );
    writeFileSync(path, original);
    const unconfigured = structuredClone(project);
    delete unconfigured.packages[connection.package];
    writeFileSync(path, stringify(unconfigured));
    const unconfiguredBytes = readFileSync(path, "utf8"),
      setup = { ...add, reference: entry.reference };
    const combined = await parity("connection_setup", setup, true);
    const deniedSetup = await parity(
      "connection_setup",
      {
        ...setup,
        settings: { ...setup.settings, unexpected: "PRIVATE_INVALID_SETTING" },
      },
      false,
    );
    assert.equal(deniedSetup.diagnostics[0].code, "CONNECTION");
    assert.equal(
      JSON.stringify(deniedSetup).includes("PRIVATE_INVALID_SETTING"),
      false,
    );
    assert.equal(readFileSync(path, "utf8"), unconfiguredBytes);
    assert.equal(
      execute({ ...context, allowWrite: true }, "apply", {
        proposal: combined.result,
      }).ok,
      true,
    );
    const created = await executeAsync(context, "connection_access", {
      connection: id,
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.deepEqual(created.result.actions, entry.actions);
    writeFileSync(path, original);
    const prepared = execute(context, "connection_prepare", {
      flow: "flow_" + entry.id.replaceAll("-", "_"),
      validateOnly: true,
    });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    assert.equal(
      readFileSync(resolve(root, "packages.lock.yaml"), "utf8"),
      lockBefore,
    );
    records.push({
      ...entry,
      fingerprint: (
        await executeAsync(context, "connection_access", {
          connection: entry.id,
        })
      ).result.fingerprint,
      authoringSdkCliMcpParity: true,
      invalidBeforeProposal: true,
      unconfiguredSetupReviewed: true,
      configurationReviewed: true,
      restored: true,
    });
  }
  checks.push(
    "all16 connection_add/configure/setup SDK CLI readonly MCP parity",
    "all16 schema violations denied before proposal without values or writes",
    "all16 reviewed apply and package/sibling preservation",
    "all16 newly configured alias setup and installed access",
    "all16 source access and offline preparation share authoring validation",
    "readonly proposals available, apply/execution denied",
  );
  result = "passed";
} finally {
  writeFileSync(path, original);
  await client.close();
  const proof = {
    apiVersion: "ingestron.connection-authoring-installed-acceptance/v1",
    result,
    root,
    cli,
    core: coreRoot,
    sourceCommit: seed.sourceCommit,
    providerCommit: seed.providerCommit,
    providerReference: seed.providerReference,
    projectSha256: sha(original),
    packageLockSha256: sha(lockBefore),
    records,
    checks,
    limits:
      "Synthetic configuration only; no credentials read, source runtime launched or vendor/cloud requests. Native settings remain provider-owned.",
  };
  writeFileSync(
    resolve(process.env.INGESTRON_ACCEPTANCE_PROOF),
    JSON.stringify(proof, null, 2) + "\n",
  );
}
assert.equal(result, "passed");
console.log(
  "Installed source authoring parity passed for " + records.length + " sources",
);
