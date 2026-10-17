/** Synthetic locked adapter only. It writes attempt identities, never reads source data. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
export function schedulerFixture({ root, execute, stringify, digest, start }) {
  const put = (name, value) => {
    const file = resolve(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : stringify(value));
  };
  const object = (properties) => ({
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  const text = { type: "string", minLength: 1 };
  const python = `import json,sys\nfrom pathlib import Path\nr=json.load(sys.stdin)\np=Path(__file__).resolve().parent/'data'\np.mkdir(exist_ok=True)\nwith (p/'events.jsonl').open('a') as f: f.write(json.dumps({'id':r['runId'],'action':r['action']})+'\\n')\nfailed=(p/'fail-once').exists()\nif failed: (p/'fail-once').unlink()\nprint(json.dumps({'apiVersion':'ingestron.execution-result/v1','status':'failed' if failed else 'succeeded','message':'Synthetic failure' if failed else 'Synthetic completion','flows':[{'flow':v,'status':'succeeded','tables':['orders']} for v in r['flows']]}))\nsys.exit(1 if failed else 0)\n`;
  put("fixture-origin/plugin/provider.yaml", {
    apiVersion: "ingestron.provider/v1",
    id: "fixture",
    version: "1.0.0",
    platform: "local",
    activities: {},
    compatibility: {
      plan: "ingestron.plan/v1",
      minimumCli: "4.2.0",
      requiredFeatures: [
        "connector-runtime-capabilities",
        "connector-schedule-handover",
        "portable-scheduler",
        "provider-execution",
        "project-assembly",
      ],
    },
    execution: {
      apiVersion: "ingestron.execution/v1",
      transport: "local-python/v1",
      entryPoint: "execute.py",
      actions: ["run"],
      status: "receipt",
      retry: "same-run-id",
      cancellation: "interrupt",
    },
    connectorRuntimes: {
      "ingestron.snapshot/python/v1": {
        selectionSchema: { type: "object", additionalProperties: true },
        executionSchema: object({ mode: { type: "string", enum: ["local"] } }),
        prepareCommand: "connection prepare",
        executionPlatforms: ["local"],
        scheduling: {
          apiVersion: "ingestron.connector-schedule/v1",
          clock: "portable",
          recurrences: ["interval", "daily", "weekly", "monthly"],
        },
      },
    },
    projectAssembly: {
      apiVersion: "ingestron.project-assembly/v1",
      command: "project assemble",
    },
    commands: {
      apiVersion: "ingestron.provider-commands/v1",
      execution: "offline-json",
      module: "./commands.mjs",
      definitions: ["connection prepare", "project assemble"].map((name) => ({
        name,
        description: "Synthetic scheduler adapter",
        inputSchema: { type: "object", additionalProperties: true },
      })),
    },
  });
  put(
    "fixture-origin/plugin/commands.mjs",
    `const python=${JSON.stringify(python)};export function command(r){const i=r.input;if(r.command==='connection prepare'){const {runtimeAssets,...lock}=i;return {apiVersion:'ingestron.artifact-proposal/v1',applied:false,artifacts:{...runtimeAssets,'connector.json':JSON.stringify({apiVersion:'ingestron.singer/v1',projectLock:lock,sourceSettings:lock.settings})}};}if(i.phase==='configure')return {execution:i.execution};const artifacts={'execute.py':python};for(const c of i.connections)for(const [name,value]of Object.entries(c.artifacts))artifacts['flows/'+c.flow+'/'+name]=value;return {apiVersion:'ingestron.project-package/v1',artifacts,details:{execution:'synthetic-only'}};}\n`,
  );
  const runtime = JSON.stringify({
    "runtime.py": "# Synthetic non-executable source fixture\n",
  });
  put("fixture-origin/runtime.json", runtime);
  put("fixture-origin/licence.txt", "Synthetic fixture licence.\n");
  put("fixture-origin/connector.yaml", {
    apiVersion: "ingestron.connector/v1",
    id: "synthetic",
    version: "1.0.0",
    description: "Non-executable synthetic scheduler fixture",
    connector: "fixture:source@1.0.0",
    documentation: "https://example.invalid/docs",
    upstream: {
      ecosystem: "singer",
      variant: "synthetic",
      package: "synthetic",
      version: "1.0.0",
      repository: "https://example.invalid/source",
      licence: "LicenseRef-Synthetic",
      licenceFile: "licence.txt",
      licenceStatus: "evidenced",
    },
    runtime: {
      contract: "ingestron.snapshot/python/v1",
      path: "runtime.json",
      sha256: digest(runtime),
    },
    definition: {
      settingsSchema: object({ host: text }),
      selectionSchema: { type: "object", additionalProperties: true },
    },
    execution: {
      local: { modes: ["local"], evidence: "Synthetic scheduler adapter only" },
    },
    quality: {
      library: {
        nullValues: "at-load",
        missingValues: "at-load",
        invalidValues: "at-load",
        duplicateValues: "at-load",
        rowCount: "at-load",
      },
      sql: "unsupported",
      engines: [],
    },
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
    "synthetic scheduler execution fixture",
  );
  git("tag", "1.0.0");
  const context = {
    root,
    environment: "dev",
    allowWrite: true,
    allowNetwork: false,
    allowExecute: false,
  };
  for (const reference of [
    "synthetic/scheduler/plugin/provider.yaml@1.0.0",
    "synthetic/scheduler/connector.yaml@1.0.0",
  ]) {
    const value = execute(context, "packages_install", {
      reference,
      fromGit: "fixture-origin",
    });
    if (!value.ok) throw Error(JSON.stringify(value));
  }
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
      packages: {
        local: {
          source: "synthetic/scheduler/plugin/provider.yaml",
          version: "1.0.0",
        },
        source: {
          source: "synthetic/scheduler/connector.yaml",
          version: "1.0.0",
        },
      },
      configurations: { local: { package: "local", binding: "compute" } },
    },
    defaults: { provider: "local" },
    environments: {
      dev: {
        apiVersion: "ingestron.environment/v1",
        environment: "dev",
        values: {},
        bindings: { compute: { kind: "local" } },
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
        provider: "local",
        ingestion: { connection: "erp", execution: { mode: "local" } },
        schedule: {
          apiVersion: "ingestron.schedule/v1",
          enabled: true,
          timeZone: "UTC",
          start,
          recurrence: { kind: "interval", minutes: 1 },
          overlap: "queue",
          missed: "latest",
        },
        tables: { orders: { source: { stream: "orders" }, contract } },
      },
    ],
  };
  put("project.yaml", project);
  const built = execute(context, "build", {
    flow: "bronze",
    out: "build/scheduled",
  });
  if (!built.ok) throw Error(JSON.stringify(built));
  return { project, from: "build/scheduled" };
}
