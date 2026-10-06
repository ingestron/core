/** Actual immutable installed SDK, CLI and read-only MCP clock parity. */
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
const required = (key) => {
  const value = process.env["INGESTRON_ACCEPTANCE_" + key];
  assert.ok(value, key);
  return resolve(value);
};
const cliRoot = realpathSync(required("CLI_PACKAGE")),
  coreRoot = realpathSync(resolve(cliRoot, "../@ingestron/core"));
assert.equal(
  JSON.parse(readFileSync(resolve(coreRoot, "package.json"))).version,
  "0.12.18",
);
const cli = resolve(cliRoot, "build/cli/cli/index.js");
const { execute } = await import(
  pathToFileURL(resolve(coreRoot, "dist/sdk/index.js")).href
);
const require = createRequire(resolve(cliRoot, "package.json"));
const { Client } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js"))
    .href
);
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js"))
    .href
);
mkdirSync(required("OUTPUT"), { recursive: true });
const root = mkdtempSync(resolve(required("OUTPUT"), "portable-clock-"));
const context = {
  root,
  allowWrite: false,
  allowExecute: false,
  allowNetwork: false,
};
const base = {
  apiVersion: "ingestron.schedule/v1",
  enabled: false,
  timeZone: "UTC",
  start: "2026-01-01T00:00:00Z",
  recurrence: { kind: "daily", times: ["09:15", "17:45"] },
};
const models = [
  {
    schedule: {
      ...base,
      recurrence: { kind: "interval", minutes: 15 },
      start: "2026-10-05T00:00:17Z",
      end: "2026-10-05T01:00:17Z",
    },
    from: "2026-10-05T00:15:18Z",
    to: "2026-10-06T00:00:00Z",
    expected: ["2026-10-05T00:30:17Z", "2026-10-05T00:45:17Z"],
  },
  {
    schedule: base,
    from: "2026-10-05T00:00:00Z",
    to: "2026-10-06T00:00:00Z",
    expected: ["2026-10-05T09:15:00Z", "2026-10-05T17:45:00Z"],
  },
  {
    schedule: {
      ...base,
      timeZone: "Pacific/Chatham",
      recurrence: { kind: "weekly", weekDays: ["Monday"], times: ["09:15"] },
    },
    from: "2026-10-04T00:00:00Z",
    to: "2026-10-06T00:00:00Z",
    expected: ["2026-10-04T19:30:00Z"],
  },
  {
    schedule: {
      ...base,
      start: "2024-01-01T00:00:00Z",
      recurrence: { kind: "monthly", monthDays: [29, 31], times: ["09:15"] },
    },
    from: "2024-02-01T00:00:00Z",
    to: "2024-03-02T00:00:00Z",
    expected: ["2024-02-29T09:15:00Z"],
  },
  {
    schedule: {
      ...base,
      timeZone: "US/Eastern",
      daylightSaving: { gap: "skip", fold: "both" },
      recurrence: { kind: "daily", times: ["01:30"] },
    },
    from: "2026-11-01T00:00:00Z",
    to: "2026-11-02T00:00:00Z",
    expected: ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"],
  },
  {
    schedule: {
      ...base,
      timeZone: "Australia/Lord_Howe",
      daylightSaving: { gap: "shift-forward", fold: "earlier" },
      recurrence: { kind: "daily", times: ["02:15"] },
    },
    from: "2026-10-03T14:00:00Z",
    to: "2026-10-04T14:00:00Z",
    expected: ["2026-10-03T15:45:00Z"],
  },
  {
    schedule: {
      ...base,
      start: "2011-12-29T00:00:00Z",
      timeZone: "Pacific/Apia",
      daylightSaving: { gap: "shift-forward", fold: "both" },
      recurrence: { kind: "daily", times: ["12:00"] },
    },
    from: "2011-12-30T10:00:00Z",
    to: "2011-12-31T10:00:00Z",
    expected: ["2011-12-30T22:00:00Z"],
  },
];
const records = [];
let result = "failed",
  client;
const run = (args) => {
  const child = spawnSync(
    process.execPath,
    [
      cli,
      "--project",
      root,
      "--json",
      "--no-input",
      "operation",
      "schedule_occurrences",
    ],
    { input: JSON.stringify(args), encoding: "utf8", timeout: 30000 },
  );
  assert.equal(child.error, undefined);
  return JSON.parse(child.stdout);
};
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
try {
  client = new Client({ name: "portable-clock-acceptance", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "--project", root, "advanced", "mcp", "serve"],
      stderr: "pipe",
    }),
  );
  const tools = await client.listTools();
  assert.ok(
    tools.tools.some((tool) => tool.name === "ingestron_schedule_occurrences"),
  );
  assert.ok(
    !tools.tools.some((tool) =>
      [
        "ingestron_apply",
        "ingestron_build",
        "ingestron_execution_start",
      ].includes(tool.name),
    ),
  );
  const mcp = async (args) =>
    JSON.parse(
      (
        await client.callTool({
          name: "ingestron_schedule_occurrences",
          arguments: args,
        })
      ).content[0].text,
    );
  for (const { expected, ...args } of models) {
    const sdk = execute(context, "schedule_occurrences", args);
    assert.equal(sdk.ok, true, JSON.stringify(sdk));
    assert.deepEqual(
      sdk.result.occurrences.map((item) => item.at),
      expected,
    );
    assert.equal(sdk.result.executionEnabled, false);
    assert.deepEqual(run(args), JSON.parse(JSON.stringify(sdk)));
    assert.deepEqual(await mcp(args), JSON.parse(JSON.stringify(sdk)));
    assert.deepEqual(execute(context, "schedule_occurrences", args), sdk);
    records.push({
      timeZone: args.schedule.timeZone,
      kind: args.schedule.recurrence.kind,
      occurrences: expected,
      sdkCliMcpIdentical: true,
    });
  }
  const invalid = { ...models[4] };
  delete invalid.expected;
  delete invalid.schedule.daylightSaving;
  for (const [args, code] of [
    [invalid, "SCHEDULE_DST_REVIEW"],
    [
      { ...invalid, schedule: { ...invalid.schedule, missed: "native" } },
      "SCHEDULE_NATIVE_CLOCK",
    ],
    [{ ...invalid, to: "2028-01-01T00:00:00Z" }, "SCHEMA"],
  ]) {
    const sdk = execute(context, "schedule_occurrences", args);
    assert.equal(sdk.ok, false);
    assert.equal(sdk.diagnostics[0].code, code);
    assert.deepEqual(run(args), JSON.parse(JSON.stringify(sdk)));
    if (code === "SCHEMA") {
      const denied = await client.callTool({
        name: "ingestron_schedule_occurrences",
        arguments: args,
      });
      assert.equal(denied.isError, true);
      assert.match(
        denied.content[0].text,
        /MCP error -32602: Input validation error/,
      );
      assert.match(
        denied.content[0].text,
        /Choose a later end within 366 elapsed days/,
      );
      records.push({
        rejection: code,
        sdkCliIdentical: true,
        mcpRejectedBeforeOperation: true,
      });
    } else {
      assert.deepEqual(await mcp(args), JSON.parse(JSON.stringify(sdk)));
      records.push({ rejection: code, sdkCliMcpIdentical: true });
    }
  }
  result = "passed";
} finally {
  if (client) await client.close();
  writeFileSync(
    required("PROOF"),
    JSON.stringify(
      {
        result,
        root,
        cli,
        coreRoot,
        records,
        archives: Object.fromEntries(
          ["CORE_ARCHIVE", "CLI_ARCHIVE"].map((key) => [
            key,
            { path: required(key), sha256: hash(required(key)) },
          ]),
        ),
        limits:
          "Installed archive clock evaluation only; no source requests, work execution, cloud calls or native clock qualification.",
      },
      null,
      2,
    ) + "\n",
  );
}
console.log(JSON.stringify({ result, checks: records.length }));
