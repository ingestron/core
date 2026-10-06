/** Immutable installed compiler/CLI/MCP plan boundary parity and locked synthetic provider rendering. */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
const required = (name) => {
  const value = process.env["INGESTRON_ACCEPTANCE_" + name];
  assert.ok(value, "Set acceptance " + name);
  return resolve(value);
};
const cliRoot = realpathSync(required("CLI_PACKAGE")),
  coreRoot = realpathSync(resolve(cliRoot, "../@ingestron/core"));
const { execute } = await import(
  pathToFileURL(resolve(coreRoot, "dist/sdk/index.js")).href
);
const require = createRequire(resolve(cliRoot, "package.json"));
const { stringify } = require("yaml");
const { Client } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js"))
    .href
);
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js"))
    .href
);
assert.equal(
  JSON.parse(readFileSync(resolve(coreRoot, "package.json"))).version,
  "0.12.20",
);
mkdirSync(required("OUTPUT"), { recursive: true });
const root = mkdtempSync(resolve(required("OUTPUT"), "boundaries-"));
const put = (path, value) => {
  const file = resolve(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : stringify(value));
};
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
};
const passed = (response) => {
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result;
};
const context = {
  root,
  allowWrite: false,
  allowExecute: false,
  allowNetwork: false,
};
const reference = "example/schedule-fixture@1.0.0";
put("fixture-origin/plugin/provider.yaml", {
  apiVersion: "ingestron.provider/v1",
  id: "fixture",
  version: "1.0.0",
  platform: "databricks",
  compatibility: {
    plan: "ingestron.plan/v1",
    minimumCli: "4.2.0",
    requiredFeatures: [
      "flow-schedules",
      "resolved-schedule-boundaries",
      "delivery-exports",
    ],
  },
  capabilities: {
    artifactKinds: ["native-notebook"],
    delivery: true,
    schedules: ["interval", "daily", "weekly", "monthly"],
    handovers: [],
    packContracts: {},
  },
  configurationSchema: { type: "object" },
  planner: {
    apiVersion: "ingestron.provider-planning/v1",
    module: "./index.mjs",
  },
  renderer: {
    apiVersion: "ingestron.provider-generation/v1",
    module: "./index.mjs",
  },
  lifecycle: {
    apiVersion: "ingestron.provider-lifecycle/v1",
    module: "./index.mjs",
  },
  activities: { "lakeflow-ingest": "./activity.yaml" },
});
put("fixture-origin/plugin/activity.yaml", {
  apiVersion: "ingestron.activity/v1",
  id: "lakeflow-ingest",
  version: "1.0.0",
  platform: "databricks",
  description: "Synthetic schedule metadata fixture",
  input: "source",
  output: "relation",
  effect: "read",
  optionsSchema: { type: "object" },
  generator: { kind: "native-notebook" },
});
put(
  "fixture-origin/plugin/index.mjs",
  `
export function expand(request){return {steps:Object.keys(request.flow.tables).map(table=>({id:'ingest_'+table,uses:'lakeflow-ingest@v1',select:[table],with:{}})),recovery:{}};}
export function model(request){return {with:request.node.with,datasets:{},targets:[request.node.flow+"_"+request.tableName]};}
export function validate(){}
export function validateOutput(){return {documents:[]};}
export function render(plan){return {"reviewed-boundaries.json":{format:"json",value:{boundaries:plan.scheduleBoundaries??{},flows:plan.flows.map(flow=>flow.id)}}};}
`,
);
const git = (...args) =>
  execFileSync("git", args, {
    cwd: resolve(root, "fixture-origin"),
    stdio: "pipe",
  });
git("init", "--quiet");
git("add", ".");
git(
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "commit",
  "-qm",
  "synthetic schedule metadata fixture",
);
git("tag", "1.0.0");
passed(
  execute({ ...context, allowWrite: true }, "packages_install", {
    reference,
    fromGit: "fixture-origin",
  }),
);
const lockHash = hash(resolve(root, "packages.lock.yaml"));
const contract = (id) => ({
  apiVersion: "v3.1.0",
  kind: "DataContract",
  id,
  name: id,
  version: "1.0.0",
  status: "draft",
  schema: [
    {
      name: id,
      logicalType: "object",
      physicalType: "table",
      properties: [
        {
          name: "id",
          logicalType: "integer",
          physicalType: "BIGINT",
          required: true,
          primaryKey: true,
        },
      ],
    },
  ],
});
for (const table of ["customers", "orders"])
  put("contracts/" + table + ".yaml", contract(table));
const baseFlow = {
  apiVersion: "ingestron.flow/v1",
  kind: "ingestion",
  id: "source",
  ingestion: {
    standard: "snapshot-with-history@v1",
    pipeline: "source",
    target: { schema: "current", historySchema: "history" },
    source: {
      delivery: "complete-snapshot",
      scope: "full-table",
      deletes: "missing-keys",
    },
    retention: { sourceDeliveries: "not-retained" },
  },
  defaults: {
    source: {
      binding: "files",
      format: "parquet",
      path: "/Volumes/synthetic/landing/{{table.id}}",
      deliveryIndex: "/Volumes/synthetic/landing/{{table.id}}/deliveries.json",
    },
  },
  tables: Object.fromEntries(
    ["customers", "orders"].map((id) => [
      id,
      { source: {}, contract: { $resolve: "./contracts/" + id + ".yaml" } },
    ]),
  ),
};
const project = {
  apiVersion: "ingestron.project/v1",
  id: "schedule_metadata",
  providers: {
    packages: {
      fixture: { source: "example/schedule-fixture", version: "1.0.0" },
    },
    configurations: {
      engineering: { package: "fixture", binding: "lakehouse" },
    },
  },
  defaults: { provider: "engineering" },
  environments: {
    dev: {
      apiVersion: "ingestron.environment/v1",
      environment: "dev",
      bindings: {
        lakehouse: {
          kind: "databricks",
          host: "https://example.invalid",
          catalog: "synthetic",
        },
        files: { kind: "adls" },
      },
      values: {},
    },
  },
  flows: [],
};
const base = {
  apiVersion: "ingestron.schedule/v1",
  enabled: false,
  timeZone: "UTC",
  start: "2026-10-05T00:00:17Z",
  overlap: "native",
  missed: "native",
  recurrence: { kind: "daily", times: ["09:15", "17:45"] },
};
const models = [
  {
    id: "interval",
    schedule: { ...base, recurrence: { kind: "interval", minutes: 15 } },
    local: "2026-10-05T00:00:17",
    offset: "+00:00",
    ambiguous: false,
  },
  {
    id: "daily",
    schedule: {
      ...base,
      timeZone: "Pacific/Auckland",
      start: "2026-09-26T13:30:17Z",
      end: "2026-09-26T14:30:17Z",
    },
    local: "2026-09-27T01:30:17",
    offset: "+12:00",
    ambiguous: false,
    endLocal: "2026-09-27T03:30:17",
    endOffset: "+13:00",
  },
  {
    id: "weekly",
    schedule: {
      ...base,
      timeZone: "Pacific/Chatham",
      recurrence: {
        kind: "weekly",
        weekDays: ["Monday", "Friday"],
        times: ["09:15", "17:45"],
      },
    },
    local: "2026-10-05T13:45:17",
    offset: "+13:45",
    ambiguous: false,
  },
  {
    id: "monthly",
    schedule: {
      ...base,
      timeZone: "US/Eastern",
      start: "2026-11-01T06:30:17Z",
      recurrence: { kind: "monthly", monthDays: [1, 31], times: ["01:30"] },
    },
    local: "2026-11-01T01:30:17",
    offset: "-05:00",
    ambiguous: true,
    possibilities: [
      { instant: "2026-11-01T05:30:17Z", offset: "-04:00" },
      { instant: "2026-11-01T06:30:17Z", offset: "-05:00" },
    ],
  },
  {
    id: "half_hour_fold",
    schedule: {
      ...base,
      timeZone: "Australia/Lord_Howe",
      start: "2026-04-04T15:15:00Z",
    },
    local: "2026-04-05T01:45:00",
    offset: "+10:30",
    ambiguous: true,
    possibilities: [
      { instant: "2026-04-04T14:45:00Z", offset: "+11:00" },
      { instant: "2026-04-04T15:15:00Z", offset: "+10:30" },
    ],
  },
  {
    id: "skipped_date",
    schedule: {
      ...base,
      timeZone: "Pacific/Apia",
      start: "2011-12-30T09:59:59Z",
      end: "2011-12-30T10:00:00Z",
    },
    local: "2011-12-29T23:59:59",
    offset: "-10:00",
    ambiguous: false,
    endLocal: "2011-12-31T00:00:00",
    endOffset: "+14:00",
  },
];
project.flows = [
  ...models.map((model) => ({
    ...structuredClone(baseFlow),
    id: model.id,
    schedule: model.schedule,
  })),
  { ...structuredClone(baseFlow), id: "manual" },
];
put("project.yaml", project);
const projectHash = hash(resolve(root, "project.yaml"));
const cli = resolve(cliRoot, "build/cli/cli/index.js");
const run = (operation, args = {}, selectedCli = cli) => {
  const child = spawnSync(
    process.execPath,
    [
      selectedCli,
      "--project",
      root,
      "--json",
      "--no-input",
      "operation",
      operation,
    ],
    { input: JSON.stringify(args), encoding: "utf8", timeout: 30000 },
  );
  assert.equal(child.error, undefined);
  assert.ok(child.stdout, child.stderr);
  return JSON.parse(child.stdout);
};
let result = "failed",
  client;
const records = [];
try {
  client = new Client({
    name: "schedule-boundaries-acceptance",
    version: "1.0.0",
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "--project", root, "advanced", "mcp", "serve"],
      stderr: "pipe",
    }),
  );
  const tools = (await client.listTools()).tools;
  assert.ok(tools.some((tool) => tool.name === "ingestron_plan"));
  assert.ok(
    !tools.some((tool) =>
      [
        "ingestron_generate",
        "ingestron_apply",
        "ingestron_execution_start",
      ].includes(tool.name),
    ),
  );
  const whole = passed(execute(context, "plan", {}));
  assert.deepEqual(
    Object.keys(whole.scheduleBoundaries).sort(),
    models.map((model) => model.id).sort(),
  );
  for (const model of models) {
    const args = { flow: model.id };
    const sdk = execute(context, "plan", args);
    const plan = passed(sdk);
    assert.deepEqual(Object.keys(plan.scheduleBoundaries), [model.id]);
    const value = plan.scheduleBoundaries[model.id];
    assert.equal(value.apiVersion, "ingestron.schedule-boundaries/v1");
    assert.equal(value.timeZone, model.schedule.timeZone);
    assert.equal(value.start.instant, model.schedule.start);
    assert.equal(value.start.localTime, model.local);
    assert.equal(value.start.offset, model.offset);
    assert.equal(value.start.ambiguous, model.ambiguous);
    if (model.possibilities)
      assert.deepEqual(value.start.possibleInstants, model.possibilities);
    if (model.endLocal) {
      assert.equal(value.end.instant, model.schedule.end);
      assert.equal(value.end.localTime, model.endLocal);
      assert.equal(value.end.offset, model.endOffset);
    } else assert.equal(Object.hasOwn(value, "end"), false);
    assert.deepEqual(run("plan", args), JSON.parse(JSON.stringify(sdk)));
    const wire = await client.callTool({
      name: "ingestron_plan",
      arguments: args,
    });
    assert.deepEqual(
      JSON.parse(wire.content[0].text),
      JSON.parse(JSON.stringify(sdk)),
    );
    assert.deepEqual(execute(context, "plan", args), sdk);
    put("reviewed-plan.json", JSON.stringify(plan));
    passed(
      execute({ ...context, allowWrite: true }, "generate", {
        plan: "reviewed-plan.json",
        out: "generated/" + model.id,
      }),
    );
    const rendered = JSON.parse(
      readFileSync(
        resolve(root, "generated/" + model.id + "/reviewed-boundaries.json"),
        "utf8",
      ),
    );
    assert.deepEqual(rendered, {
      boundaries: plan.scheduleBoundaries,
      flows: [model.id],
    });
    records.push({
      check:
        "Exact reviewed bound and sandbox rendering with SDK/CLI/MCP parity",
      model: model.id,
      kind: model.schedule.recurrence.kind,
      timeZone: value.timeZone,
      boundaries: value,
    });
  }
  const manual = passed(execute(context, "plan", { flow: "manual" }));
  assert.equal(Object.hasOwn(manual, "scheduleBoundaries"), false);
  assert.equal(
    passed(execute(context, "plan", { flow: "weekly", table: "orders" })).nodes
      .length,
    1,
  );
  const old = run("plan", { flow: "daily" }, required("OLD_CLI"));
  assert.equal(old.ok, false);
  assert.equal(old.diagnostics[0].code, "COMPATIBILITY");
  assert.match(old.diagnostics[0].message, /resolved-schedule-boundaries/);
  records.push({
    check:
      "Manual and table selection preserve scope; older immutable host refuses required boundary feature",
    oldHostDiagnostic: old.diagnostics[0],
  });
  const reviewed = passed(execute(context, "plan", { flow: "daily" }));
  for (const mutate of [
    (value) => {
      value.scheduleBoundaries.daily.clock.timeZoneData = "changed-clock";
    },
    (value) => {
      value.scheduleBoundaries.daily.start.offset = "+00:00";
    },
    (value) => {
      delete value.scheduleBoundaries;
    },
    (value) => {
      value.scheduleBoundaries.foreign = structuredClone(
        value.scheduleBoundaries.daily,
      );
    },
  ]) {
    const changed = structuredClone(reviewed);
    mutate(changed);
    const { digest: old, ...body } = changed;
    changed.digest = createHash("sha256").update(canonical(body)).digest("hex");
    put("altered-plan.json", JSON.stringify(changed));
    const denied = execute({ ...context, allowWrite: true }, "generate", {
      plan: "altered-plan.json",
      out: "denied-output",
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.diagnostics[0].code, "SCHEDULE_BOUNDARIES");
    assert.equal(existsSync(resolve(root, "denied-output")), false);
  }
  records.push({
    check:
      "Generation refuses stale clock, altered, missing and foreign boundary metadata even with recomputed plan digest; no output written",
  });
  const malformed = structuredClone(project);
  malformed.flows[0].schedule.start = "2026-02-30T00:00:00Z";
  put("project.yaml", malformed);
  assert.equal(execute(context, "plan", {}).ok, false);
  put("project.yaml", project);
  assert.equal(hash(resolve(root, "packages.lock.yaml")), lockHash);
  assert.equal(hash(resolve(root, "project.yaml")), projectHash);
  assert.equal(existsSync(resolve(root, ".ingestron/runs")), false);
  records.push({
    check:
      "Invalid boundary refused; locked provider and definitions unchanged; no runtime runs",
  });
  result = "passed";
} finally {
  if (client) await client.close();
  writeFileSync(
    required("PROOF"),
    JSON.stringify(
      {
        apiVersion: "ingestron.schedule-boundaries-acceptance/v1",
        result,
        root,
        coreVersion: "0.12.20",
        cliVersion: JSON.parse(readFileSync(resolve(cliRoot, "package.json")))
          .version,
        archives: Object.fromEntries(
          ["CORE_ARCHIVE", "CLI_ARCHIVE"].map((name) => [
            name,
            { path: required(name), sha256: hash(required(name)) },
          ]),
        ),
        provider: { reference, lockSha256: lockHash },
        records,
        limits:
          "Synthetic locked metadata provider, actual immutable Node SDK/CLI/read-only MCP and sandbox generation. No vendor execution, browser qualification, native activation or source request.",
      },
      null,
      2,
    ) + "\n",
  );
}
console.log(JSON.stringify({ result, checks: records.length }));
