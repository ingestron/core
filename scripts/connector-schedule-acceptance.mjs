/** Immutable installed host/CLI/MCP handover parity. No production adapter or source execution. */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
const required = (key) => {
  const value = process.env["INGESTRON_ACCEPTANCE_" + key];
  assert.ok(value, key);
  return resolve(value);
};
const cliRoot = realpathSync(required("CLI_PACKAGE"));
const coreRoot = realpathSync(resolve(cliRoot, "../@ingestron/core"));
assert.equal(
  JSON.parse(readFileSync(resolve(coreRoot, "package.json"))).version,
  "0.12.24",
);
const { execute } = await import(
  pathToFileURL(resolve(coreRoot, "dist/sdk/index.js")).href
);
const {
  canonical,
  digest,
  connectorScheduleHandover,
  validateConnectorScheduleHandover,
} = await import(pathToFileURL(resolve(coreRoot, "dist/sdk/adapter.js")).href);
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
const cli = resolve(cliRoot, "build/cli/cli/index.js");
const output = required("OUTPUT");
mkdirSync(output, { recursive: true });
const root = mkdtempSync(resolve(output, "connector-schedule-"));
const context = {
  root,
  environment: "dev",
  allowWrite: false,
  allowNetwork: false,
  allowExecute: false,
};
const records = [];
const put = (path, value) => {
  const target = resolve(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === "string" ? value : stringify(value));
};
const passed = (value) => {
  assert.equal(value.ok, true, JSON.stringify(value));
  return value.result;
};
const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const text = { type: "string", minLength: 1 };
const capability = {
  apiVersion: "ingestron.connector-schedule/v1",
  clock: "portable",
  recurrences: ["interval", "daily", "weekly", "monthly"],
};
const variants = {
  portable: capability,
  native: { ...capability, clock: "platform-native" },
  legacy: null,
  daily: { ...capability, recurrences: ["daily"] },
  undeclared: capability,
};
for (const [name, scheduling] of Object.entries(variants)) {
  put(`fixture-origin/${name}/provider.yaml`, {
    apiVersion: "ingestron.provider/v1",
    id: name,
    version: "1.0.0",
    platform: "test",
    activities: {},
    compatibility: {
      plan: "ingestron.plan/v1",
      minimumCli: "4.2.0",
      requiredFeatures: [
        "connector-runtime-capabilities",
        ...(scheduling && name !== "undeclared"
          ? ["connector-schedule-handover"]
          : []),
      ],
    },
    connectorRuntimes: {
      "ingestron.snapshot/python/v1": {
        selectionSchema: { type: "object", additionalProperties: true },
        executionSchema: object({ mode: { type: "string", enum: ["local"] } }),
        prepareCommand: "connection prepare",
        executionPlatforms: ["test"],
        ...(scheduling ? { scheduling } : {}),
      },
    },
    commands: {
      apiVersion: "ingestron.provider-commands/v1",
      execution: "offline-json",
      module: "./commands.mjs",
      definitions: [
        {
          name: "connection prepare",
          description: "Synthetic handover receiver; never executes",
          inputSchema: { type: "object", additionalProperties: true },
        },
      ],
    },
  });
  put(
    `fixture-origin/${name}/commands.mjs`,
    `export function command(request){return {apiVersion:"ingestron.artifact-proposal/v1",applied:false,artifacts:{"prepared-request.json":JSON.stringify(request.input)},execution:"synthetic-handover-only"};}\n`,
  );
}
const runtimeAssets = JSON.stringify({
  "runtime.py": "# Synthetic non-executable fixture\n",
});
put("fixture-origin/source/runtime.json", runtimeAssets);
put("fixture-origin/source/licence.txt", "Synthetic test fixture licence.\n");
put("fixture-origin/source/connector.yaml", {
  apiVersion: "ingestron.connector/v1",
  id: "synthetic",
  version: "1.0.0",
  description: "Synthetic schedule handover source",
  connector: "fixture:source@1.0.0",
  documentation: "https://example.invalid/docs",
  upstream: {
    ecosystem: "singer",
    variant: "synthetic",
    package: "synthetic",
    version: "1.0.0",
    repository: "https://example.invalid/source",
    licence: "LicenseRef-Synthetic",
    licenceFile: "source/licence.txt",
    licenceStatus: "evidenced",
  },
  runtime: {
    contract: "ingestron.snapshot/python/v1",
    path: "source/runtime.json",
    sha256: digest(runtimeAssets),
  },
  definition: {
    settingsSchema: object({ host: text }),
    selectionSchema: { type: "object", additionalProperties: true },
  },
  execution: { test: { modes: ["local"], evidence: "synthetic only" } },
});
const git = (...args) =>
  execFileSync("git", args, {
    cwd: resolve(root, "fixture-origin"),
    stdio: "pipe",
  });
git("init", "-q");
git("add", ".");
git(
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "commit",
  "-qm",
  "immutable synthetic connector schedule adapters",
);
git("tag", "1.0.0");
const install = (reference) =>
  passed(
    execute({ ...context, allowWrite: true }, "packages_install", {
      reference,
      fromGit: "fixture-origin",
    }),
  );
for (const name of Object.keys(variants))
  install(`synthetic/schedules/${name}/provider.yaml@1.0.0`);
install("synthetic/schedules/source/connector.yaml@1.0.0");
const contract = {
  apiVersion: "v3.1.0",
  kind: "DataContract",
  id: "orders",
  name: "Orders",
  version: "1.0.0",
  status: "draft",
  schema: [
    {
      name: "orders",
      logicalType: "object",
      physicalType: "table",
      properties: [
        {
          name: "id",
          logicalType: "integer",
          physicalType: "BIGINT",
          required: true,
        },
      ],
    },
  ],
};
const project = {
  apiVersion: "ingestron.project/v1",
  id: "retail",
  providers: {
    packages: Object.fromEntries(
      [...Object.keys(variants), "source"].map((name) => [
        name,
        {
          source: `synthetic/schedules/${name}/${name === "source" ? "connector" : "provider"}.yaml`,
          version: "1.0.0",
        },
      ]),
    ),
    configurations: Object.fromEntries(
      Object.keys(variants).map((name) => [
        name,
        { package: name, binding: "compute" },
      ]),
    ),
  },
  defaults: { provider: "portable" },
  environments: {
    dev: {
      apiVersion: "ingestron.environment/v1",
      environment: "dev",
      values: {},
      bindings: { compute: { kind: "test" } },
    },
  },
  connections: {
    erp: {
      package: "source",
      sourceId: "erp",
      tenantId: "synthetic",
      settings: { host: "synthetic.invalid" },
    },
  },
  flows: [
    {
      apiVersion: "ingestron.flow/v1",
      id: "bronze",
      kind: "ingestion",
      provider: "portable",
      ingestion: { connection: "erp", execution: { mode: "local" } },
      tables: { orders: { source: { stream: "orders" }, contract } },
    },
  ],
};
const save = () => put("project.yaml", project);
save();
const hash = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const lockHash = hash(resolve(root, "packages.lock.yaml"));
const command = (operation, args) => {
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
    ],
    {
      input: JSON.stringify(args),
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  assert.equal(child.error, undefined);
  return JSON.parse(child.stdout);
};
const client = new Client({
  name: "connector-schedule-acceptance",
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
  assert.ok(names.includes("ingestron_connection_prepare"));
  assert.ok(!names.includes("ingestron_run"));
  assert.ok(!names.includes("ingestron_apply"));
  const parity = async (expected) => {
    const before = hash(resolve(root, "project.yaml"));
    const args = { flow: "bronze" };
    const sdk = execute(context, "connection_prepare", args),
      terminal = command("connection_prepare", args);
    const mcp = JSON.parse(
      (
        await client.callTool({
          name: "ingestron_connection_prepare",
          arguments: args,
        })
      ).content[0].text,
    );
    assert.equal(sdk.ok, expected, JSON.stringify(sdk));
    assert.deepEqual(terminal, JSON.parse(JSON.stringify(sdk)));
    assert.deepEqual(mcp, JSON.parse(JSON.stringify(sdk)));
    assert.equal(hash(resolve(root, "project.yaml")), before);
    assert.equal(hash(resolve(root, "packages.lock.yaml")), lockHash);
    return sdk;
  };
  const preparedInput = (value) =>
    JSON.parse(value.result.result.artifacts["prepared-request.json"]);
  const manual = preparedInput(await parity(true));
  assert.ok(!Object.hasOwn(manual, "schedule"));
  const base = {
    apiVersion: "ingestron.schedule/v1",
    enabled: false,
    timeZone: "Pacific/Auckland",
    start: "2026-09-26T13:30:17Z",
    end: "2027-09-26T13:30:17Z",
    recurrence: { kind: "daily", times: ["09:15", "17:45"] },
    overlap: "queue",
    missed: "latest",
    daylightSaving: { gap: "skip", fold: "both" },
  };
  const definitions = [
    {
      ...base,
      timeZone: "UTC",
      daylightSaving: undefined,
      recurrence: { kind: "interval", minutes: 17 },
    },
    base,
    {
      ...base,
      recurrence: {
        kind: "weekly",
        weekDays: ["Monday", "Friday"],
        times: ["09:15", "17:45"],
      },
    },
    {
      ...base,
      recurrence: {
        kind: "monthly",
        monthDays: [1, 29, 31],
        times: ["09:15", "17:45"],
      },
    },
  ];
  for (const definition of definitions) {
    project.flows[0].schedule = definition;
    save();
    const input = preparedInput(await parity(true));
    const owner = {
      project: project.id,
      environment: "dev",
      flow: "bronze",
      connection: "erp",
    };
    assert.deepEqual(
      input.schedule,
      connectorScheduleHandover(definition, capability, owner),
    );
    assert.deepEqual(
      validateConnectorScheduleHandover(
        input.schedule,
        capability,
        owner,
        definition,
      ),
      input.schedule,
    );
    const { specificationSha256, runtimeAssets: _assets, ...body } = input;
    assert.equal(specificationSha256, digest(canonical(body)));
    assert.notEqual(specificationSha256, manual.specificationSha256);
    assert.equal(input.schedule.boundaries.start.instant, definition.start);
    assert.equal(input.schedule.boundaries.end.instant, definition.end);
    const fullyRebuilt = connectorScheduleHandover(
      { ...definition, enabled: true },
      capability,
      owner,
    );
    assert.throws(() =>
      validateConnectorScheduleHandover(
        fullyRebuilt,
        capability,
        owner,
        definition,
      ),
    );
    records.push({
      scenario: "portable complete intent",
      recurrence: definition.recurrence.kind,
      specificationSha256,
      scheduleDigest: input.schedule.digest,
      enabled: input.schedule.definition.enabled,
    });
  }
  project.flows[0].provider = "native";
  project.flows[0].schedule = {
    ...base,
    daylightSaving: undefined,
    overlap: "native",
    missed: "native",
  };
  save();
  const native = preparedInput(await parity(true));
  assert.equal(native.schedule.clock, "platform-native");
  records.push({
    scenario: "native explicit policies",
    scheduleDigest: native.schedule.digest,
  });
  for (const [provider, definition, code] of [
    ["legacy", base, "SCHEDULE_UNSUPPORTED"],
    ["daily", definitions[2], "SCHEDULE_UNSUPPORTED"],
    ["portable", project.flows[0].schedule, "SCHEDULE_POLICY"],
    ["native", base, "SCHEDULE_POLICY"],
    ["undeclared", base, "COMPATIBILITY"],
  ]) {
    project.flows[0].provider = provider;
    project.flows[0].schedule = definition;
    save();
    const denied = await parity(false);
    assert.equal(denied.diagnostics[0].code, code);
    assert.equal(denied.result, undefined);
    records.push({ scenario: "refusal", provider, code });
  }
  project.flows[0].provider = "portable";
  project.flows[0].schedule = base;
  save();
  const original = preparedInput(await parity(true));
  project.connections.erp.settings.host = "another.synthetic.invalid";
  save();
  const changed = preparedInput(await parity(true));
  assert.notEqual(changed.specificationSha256, original.specificationSha256);
  assert.equal(changed.schedule.digest, original.schedule.digest);
  project.connections.erp.settings.host = "synthetic.invalid";
  delete project.flows[0].schedule;
  save();
  assert.deepEqual(preparedInput(await parity(true)), manual);
  records.push({ scenario: "source settings bound and exact manual recovery" });
  result = "passed";
} finally {
  await client.close();
  const evidence = {
    checkedAt: new Date().toISOString(),
    result,
    root,
    coreVersion: "0.12.24",
    cliVersion: JSON.parse(readFileSync(resolve(cliRoot, "package.json")))
      .version,
    records,
    packages: {
      core: {
        path: required("CORE_ARCHIVE"),
        sha256: hash(required("CORE_ARCHIVE")),
      },
      cli: {
        path: required("CLI_ARCHIVE"),
        sha256: hash(required("CLI_ARCHIVE")),
      },
    },
    lockSha256: lockHash,
    scope:
      "Immutable installed SDK/CLI/read-only MCP synthetic schedule handover; no production adapter scheduling, dispatch, source access, browser or native activation qualification",
  };
  writeFileSync(required("PROOF"), JSON.stringify(evidence, null, 2) + "\n");
}
console.log(JSON.stringify({ result, root, scenarios: records.length }));
