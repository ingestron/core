/** Actual installed scheduling operations with a locked synthetic Python adapter. */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { schedulerFixture } from "./fixtures/scheduler-fixture.mjs";
const required = (key) => {
  const value = process.env["INGESTRON_ACCEPTANCE_" + key];
  assert.ok(value, key);
  return resolve(value);
};
const cliRoot = realpathSync(required("CLI_PACKAGE")),
  coreRoot = realpathSync(resolve(cliRoot, "../@ingestron/core"));
const { execute, executeAsync } = await import(
  pathToFileURL(resolve(coreRoot, "dist/sdk/index.js")).href
);
const { digest } = await import(
  pathToFileURL(resolve(coreRoot, "dist/sdk/adapter.js")).href
);
const require = createRequire(resolve(cliRoot, "package.json")),
  { stringify } = require("yaml");
const { Client } = await import(
    pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js"))
      .href
  ),
  { StdioClientTransport } = await import(
    pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js"))
      .href
  );
assert.equal(
  JSON.parse(readFileSync(resolve(coreRoot, "package.json"))).version,
  "0.12.25",
);
assert.equal(
  JSON.parse(readFileSync(resolve(cliRoot, "package.json"))).version,
  "0.17.11",
);
const base = required("OUTPUT");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(resolve(base, "scheduler-"));
const start = new Date(Math.floor((Date.now() + 25000) / 1000) * 1000)
  .toISOString()
  .replace(".000Z", "Z");
const { from } = schedulerFixture({ root, execute, stringify, digest, start });
const context = {
  root,
  environment: "dev",
  allowWrite: true,
  allowExecute: true,
  allowNetwork: false,
};
const passed = (value) => {
  assert.equal(value.ok, true, JSON.stringify(value));
  return value.result;
};
const sdk = (op, args = {}) =>
  executeAsync(context, op, { flow: "bronze", ...args });
const cli = resolve(cliRoot, "build/cli/cli/index.js");
const command = (op, args = {}, allow = false) => {
  const child = spawnSync(
    process.execPath,
    [
      cli,
      "--project",
      root,
      "--json",
      "--no-input",
      "operation",
      op,
      ...(allow ? ["--allow-write", "--allow-execute"] : []),
    ],
    {
      input: JSON.stringify({ flow: "bronze", ...args }),
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  assert.equal(child.error, undefined);
  return JSON.parse(child.stdout);
};
const readonly = new Client({ name: "scheduler-readonly", version: "1.0.0" }),
  full = new Client({ name: "scheduler-execution", version: "1.0.0" });
const checks = [];
let result = "failed";
try {
  await readonly.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "--project", root, "advanced", "mcp", "serve"],
      stderr: "pipe",
    }),
  );
  await full.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        cli,
        "--project",
        root,
        "advanced",
        "mcp",
        "serve",
        "--allow-write",
        "--allow-execute",
      ],
      stderr: "pipe",
    }),
  );
  const ro = (await readonly.listTools()).tools.map((t) => t.name),
    rw = (await full.listTools()).tools.map((t) => t.name);
  for (const op of [
    "scheduler_register",
    "scheduler_tick",
    "scheduler_pause",
    "scheduler_cancel",
    "scheduler_retry",
  ]) {
    assert.ok(!ro.includes("ingestron_" + op));
    assert.ok(rw.includes("ingestron_" + op));
  }
  assert.ok(ro.includes("ingestron_scheduler_status"));
  checks.push("MCP mutations require both explicit permissions");
  const call = async (client, op, args = {}) =>
    JSON.parse(
      (
        await client.callTool({
          name: "ingestron_" + op,
          arguments: { flow: "bronze", ...args },
        })
      ).content[0].text,
    );
  const inspected = await sdk("scheduler_inspect", { from });
  passed(inspected);
  assert.deepEqual(
    command("scheduler_inspect", { from }),
    JSON.parse(JSON.stringify(inspected)),
  );
  assert.deepEqual(
    await call(readonly, "scheduler_inspect", { from }),
    JSON.parse(JSON.stringify(inspected)),
  );
  checks.push("actual SDK/CLI/read-only MCP preflight parity");
  const denied = command("scheduler_register", {
    from,
    expectedDigest: inspected.result.digest,
  });
  assert.equal(denied.diagnostics[0].code, "PERMISSION");
  const registered = passed(
    await sdk("scheduler_register", {
      from,
      expectedDigest: inspected.result.digest,
    }),
  );
  assert.ok(
    registered.cursor <= start,
    "fixture must register before its first future slot",
  );
  assert.deepEqual(
    passed(
      command(
        "scheduler_register",
        { from, expectedDigest: inspected.result.digest },
        true,
      ),
    ),
    JSON.parse(JSON.stringify(registered)),
  );
  checks.push(
    "review digest, explicit register and idempotent CLI registration",
  );
  const metadata = JSON.parse(
      readFileSync(resolve(root, from, "ingestron-project.json")),
    ),
    pkg = metadata.packages[0],
    packageRoot = resolve(root, from, pkg.directory);
  mkdirSync(resolve(packageRoot, "data"), { recursive: true });
  writeFileSync(resolve(packageRoot, "data/fail-once"), "synthetic failure\n");
  const delay = Math.max(0, Date.parse(start) + 50 - Date.now());
  assert.ok(delay < 60000);
  await new Promise((done) => setTimeout(done, delay));
  const first = passed(await sdk("scheduler_tick"));
  assert.equal(first.outcomes.length, 1);
  assert.equal(first.state.work[0].status, "failed");
  checks.push(
    "actual local Python failure retains durable occurrence and claim",
  );
  const row = first.state.work[0];
  const recovered = passed(
    await call(full, "scheduler_retry", {
      occurrence: row.id,
      expectedDigest: registered.bindingDigest,
    }),
  );
  assert.equal(recovered.outcomes[0].status, "succeeded");
  assert.equal(recovered.state.work[0].runId, row.runId);
  assert.equal(recovered.state.work[0].attempt, 2);
  checks.push(
    "MCP recovery uses actual core run retry and same business identity",
  );
  const events = () =>
    readFileSync(resolve(packageRoot, "data/events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  assert.equal(events().length, 2);
  assert.equal(events()[0].id, events()[1].id);
  const repeated = passed(command("scheduler_tick", {}, true));
  assert.equal(repeated.outcomes.length, 0);
  assert.equal(events().length, 2);
  checks.push("repeated CLI tick commits no duplicate occurrence");
  const paused = passed(
    await call(full, "scheduler_pause", {
      expectedDigest: registered.bindingDigest,
    }),
  );
  assert.equal(paused.enabled, false);
  writeFileSync(
    resolve(root, "project.yaml"),
    readFileSync(resolve(root, "project.yaml"), "utf8") +
      "\n# changed reviewed project input\n",
  );
  const stale = await sdk("scheduler_tick");
  assert.equal(stale.ok, false);
  assert.equal(stale.diagnostics[0].code, "STALE");
  assert.equal(events().length, 2);
  const status = await sdk("scheduler_status");
  passed(status);
  assert.equal(status.result.state.enabled, false);
  assert.deepEqual(
    command("scheduler_status"),
    JSON.parse(JSON.stringify(status)),
  );
  assert.deepEqual(
    await call(readonly, "scheduler_status"),
    JSON.parse(JSON.stringify(status)),
  );
  checks.push(
    "changed input refuses execution; paused state remains inspectable across all surfaces",
  );
  result = "passed";
} finally {
  await readonly.close();
  await full.close();
  const sha = (path) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  writeFileSync(
    required("PROOF"),
    JSON.stringify(
      {
        result,
        checkedAt: new Date().toISOString(),
        root,
        checks,
        coreVersion: "0.12.25",
        cliVersion: "0.17.11",
        coreArchive: {
          path: required("CORE_ARCHIVE"),
          sha256: sha(required("CORE_ARCHIVE")),
        },
        cliArchive: {
          path: required("CLI_ARCHIVE"),
          sha256: sha(required("CLI_ARCHIVE")),
        },
        scope:
          "Actual installed SDK/CLI/MCP durable scheduling with locked synthetic Python adapter, no production source package scheduling, browser or native platform qualification",
      },
      null,
      2,
    ) + "\n",
  );
}
console.log(JSON.stringify({ result, root, checks: checks.length }));
