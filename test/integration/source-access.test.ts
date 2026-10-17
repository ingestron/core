import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { fixture } from "../support/project.js";
import { installPackage } from "../../src/core/packages.js";
import { digest } from "../../src/core/errors.js";
import { execute, executeAsync } from "../../src/core/operations.js";
function setup(
  t: any,
  options: {
    sourceAccess?: boolean;
    inventoryScope?: boolean;
    metadataOptions?: boolean;
    leakedSample?: boolean;
    hostAccess?: boolean;
    failing?: boolean;
    interruptible?: boolean;
    sample?: "valid" | "overflow" | "wrong-action";
  } = {},
) {
  const f = fixture(t),
    origin = resolve(f.root, "source-fixture");
  mkdirSync(resolve(origin, "plugin"), { recursive: true });
  const assets = JSON.stringify({ "source.py": "# synthetic fixture" });
  writeFileSync(resolve(origin, "runtime.json"), assets);
  writeFileSync(resolve(origin, "licence.txt"), "Synthetic test licence");
  const object = (properties: any) => ({
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  writeFileSync(
    resolve(origin, "connector.yaml"),
    stringify({
      apiVersion: "ingestron.connector/v1",
      id: "fixture",
      version: "1.0.0",
      description: "Synthetic source",
      connector: "example:fixture@1.0.0",
      documentation: "https://example.invalid/docs",
      upstream: {
        ecosystem: "example",
        variant: "fixture",
        package: "fixture",
        version: "1.0.0",
        repository: "https://example.invalid/repo",
        licence: "LicenseRef-Synthetic",
        licenceFile: "licence.txt",
        licenceStatus: "evidenced",
      },
      runtime: {
        path: "runtime.json",
        sha256: digest(assets),
        contract: "ingestron.snapshot/python/v1",
      },
      definition: {
        settingsSchema: object({
          host: { type: "string" },
          password: object({ $secret: object({ env: { type: "string" } }) }),
        }),
        selectionSchema: { type: "object", additionalProperties: true },
        tableSourceSchema: object({
          schema: { type: "string" },
          table: { type: "string" },
        }),
      },
      execution: { local: { modes: ["local"], evidence: "synthetic" } },
      ...(options.sourceAccess === false
        ? {}
        : {
            sourceAccess: {
              apiVersion: "ingestron.source-access/v1",
              entryPoint: "source.py",
              actions: ["test", "inventory", "metadata", "sample"],
              ...(options.metadataOptions
                ? {
                    metadataOptionsSchema: object({
                      sampleRecords: {
                        type: "boolean",
                        enum: [true],
                        title: "Explicit record sampling",
                      },
                      limit: { type: "integer", minimum: 1, maximum: 50 },
                    }),
                  }
                : {}),
              ...(options.inventoryScope
                ? {
                    inventoryScopeSchema: object({
                      directory: {
                        type: "string",
                        minLength: 1,
                        maxLength: 4000,
                      },
                    }),
                  }
                : {}),
            },
          }),
    }),
  );
  writeFileSync(
    resolve(origin, "plugin/provider.yaml"),
    stringify({
      apiVersion: "ingestron.provider/v1",
      id: "fixture",
      version: "1.0.0",
      platform: "local",
      activities: {},
      compatibility: {
        plan: "ingestron.plan/v1",
        minimumCli: "4.2.0",
        requiredFeatures: [],
      },
      ...(options.hostAccess === false
        ? {}
        : {
            sourceAccess: {
              apiVersion: "ingestron.source-access-host/v1",
              transport: "local-python/v1",
              entryPoint: "source_host.py",
            },
          }),
    }),
  );
  writeFileSync(
    resolve(origin, "plugin/source_host.py"),
    `import json,sys,os,pathlib,hashlib\n${options.interruptible ? "import time; time.sleep(30)\n" : ""}r=json.load(sys.stdin)\ns=json.loads((pathlib.Path(r['directory'])/'source-access.json').read_text())\nassert 'unexpected' not in os.environ\na=s['action']\nx={'apiVersion':'ingestron.source-access-result/v1','status':'${options.failing ? "failed" : "succeeded"}','action':a,'scope':'metadata','tables':[],'code':'ACCESS_AUTH'}\nif a=='metadata':\n assert s.get('options') == ${options.metadataOptions ? "{'sampleRecords':True,'limit':2}" : "None"}\n x['tables']=[{'id':'table_'+hashlib.sha256(json.dumps(o,sort_keys=True,separators=(',',':')).encode()).hexdigest()[:16],'name':o.get('schema','dbo')+'.'+o.get('table','Orders'),'kind':'table','source':o,'columns':[{'name':'id','type':'integer','nullable':False,'key':True},{'name':'geography','type':'string','nullable':True,'supported':False,'sourceType':'geography'}]} for i,o in enumerate(s['tables'])]\nif a=='inventory' and s.get('scope'):\n x['tables']=[{'id':'table_'+hashlib.sha256(json.dumps(s['scope'],sort_keys=True,separators=(',',':')).encode()).hexdigest()[:16],'name':s['scope']['directory'],'kind':'table','source':{'schema':'reviewed','table':'Orders'}}]\nif a=='sample':\n x.update(action='${options.sample === "wrong-action" ? "metadata" : "sample"}',scope='data',sample={'columns':['id','label'],'rows':${options.sample === "overflow" ? "[[1,'business-preview-only'],[2,'overflow']]" : "[[1,'business-preview-only']]"},'truncated':False})\n${options.leakedSample ? "if a=='metadata':\n x['sample']={'columns':['id'], 'rows':[['PRIVATE_LEAK']], 'truncated':False}\n" : ""}if a=='prepare':\n x={'apiVersion':'ingestron.source-access-prepared/v1','status':'succeeded','reused':True}\nprint(json.dumps({'apiVersion':'ingestron.execution-result/v1','status':'succeeded','result':x}))\n`,
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: origin, stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  git("tag", "1.0.0");
  installPackage(f.root, "example/source/connector.yaml@1.0.0", {
    fromGit: origin,
  });
  installPackage(f.root, "example/host@1.0.0", { fromGit: origin });
  f.project.providers = {
    packages: {
      source: { source: "example/source/connector.yaml", version: "1.0.0" },
    },
    configurations: {},
  };
  f.project.defaults = {};
  f.project.flows = [];
  f.project.connections = {
    sales: {
      package: "source",
      sourceId: "sales",
      tenantId: "demo",
      settings: {
        host: "db.example.invalid",
        password: { $secret: { env: "SOURCE_ACCESS_TEST_SECRET" } },
      },
    },
  };
  f.put("project.yaml", f.project);
  f.put(
    ".private.env",
    "SOURCE_ACCESS_TEST_SECRET=synthetic-only\nunexpected=must-not-pass\n",
  );
  return f;
}

test("explicit adapter selection keeps two tables and their contracts in one reviewed flow", async (t) => {
  const f = setup(t);
  installPackage(f.root, "example/other-host@1.0.0", {
    fromGit: resolve(f.root, "source-fixture"),
  });
  const ctx = {
    root: f.root,
    environment: "dev",
    allowWrite: true,
    allowExecute: true,
  };
  const ambiguous = await executeAsync(ctx, "connection_access", {
    connection: "sales",
  });
  assert.equal(ambiguous.ok, true, JSON.stringify(ambiguous));
  assert.match(ambiguous.result.reason, /exact-version/);
  const executor = "example/host/plugin/provider.yaml@1.0.0";
  const access = await executeAsync(ctx, "connection_access", {
    connection: "sales",
    executor,
  });
  assert.equal(access.ok, true, JSON.stringify(access));
  assert.equal(access.result.executor, executor);
  const metadata = await executeAsync(ctx, "connection_metadata", {
    connection: "sales",
    executor,
    envFile: ".private.env",
    tables: [
      { schema: "dbo", table: "Orders" },
      { schema: "dbo", table: "Customers" },
    ],
  });
  assert.equal(metadata.ok, true, JSON.stringify(metadata));
  const drafts = await executeAsync(ctx, "connection_contracts", {
    connection: "sales",
    executor,
    receipt: metadata.result.receipt,
    tables: metadata.result.tables.map((table: any) => ({
      id: table.id,
      name: table.source.table,
    })),
  });
  assert.equal(drafts.ok, true, JSON.stringify(drafts));
  assert.equal(drafts.result.tables.length, 2);
  f.project.providers.packages.local = {
    source: "example/host/plugin/provider.yaml",
    version: "1.0.0",
  };
  f.project.providers.configurations.local = {
    package: "local",
    binding: "local",
  };
  f.put("project.yaml", f.project);
  const request = {
    id: "sales_bronze",
    connection: "sales",
    provider: "local",
    receipt: metadata.result.receipt,
    tables: drafts.result.tables.map((table: any) => ({
      id: table.id,
      table: table.name,
      contract: table.file,
    })),
  };
  const missing = execute(ctx, "connection_flow_review", request);
  assert.equal(missing.ok, false);
  const proposal = execute(
    { ...ctx, allowExecute: false },
    "connection_flow_review",
    { ...request, executor },
  );
  assert.equal(proposal.ok, true, JSON.stringify(proposal));
  const applied = execute(ctx, "apply", { proposal: proposal.result });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const flow = parse(
    readFileSync(resolve(f.root, "flows/sales_bronze/flow.yaml"), "utf8"),
  );
  assert.deepEqual(Object.keys(flow.tables), ["Orders", "Customers"]);
  assert.equal(flow.ingestion.connection, "sales");
  assert.equal(flow.provider, "local");
  assert.deepEqual(flow.tables.Orders.source, {
    schema: "dbo",
    table: "Orders",
  });
  assert.deepEqual(flow.tables.Customers.source, {
    schema: "dbo",
    table: "Customers",
  });
  assert.notEqual(
    flow.tables.Orders.contract.$resolve,
    flow.tables.Customers.contract.$resolve,
  );
  assert.equal(
    parse(readFileSync(resolve(f.root, "project.yaml"), "utf8")).flows.length,
    1,
  );
});
test("source access works with no provider configuration, flow or contract and fails closed for legacy/native routes", async (t) => {
  const f = setup(t);
  const context = { root: f.root };
  const info = await executeAsync(context, "connection_access", {
    connection: "sales",
  });
  assert.equal(info.ok, true);
  assert.deepEqual(info.result.actions, [
    "test",
    "inventory",
    "metadata",
    "sample",
  ]);
  assert.equal(info.result.executor, "example/host/plugin/provider.yaml@1.0.0");
  for (const operation of [
    "connection_runtime_prepare",
    "connection_test",
    "connection_inventory",
    "connection_metadata",
  ] as const) {
    const args = {
      connection: "sales",
      ...(operation === "connection_metadata"
        ? { tables: [{ schema: "dbo", table: "Orders" }] }
        : {}),
    };
    const denied = await executeAsync(context, operation, args);
    assert.equal(denied.ok, false);
    assert.equal(denied.diagnostics[0].code, "PERMISSION");
  }
  f.project.connections.sales = {
    package: "source",
    kind: "azure-sql",
    route: "native",
    sourceId: "sales",
    tenantId: "demo",
    settings: {},
  };
  f.put("project.yaml", f.project);
  const native = await executeAsync(context, "connection_access", {
    connection: "sales",
  });
  assert.equal(native.ok, true);
  assert.deepEqual(native.result.actions, []);
  assert.match(native.result.reason, /platform/);
  const legacy = setup(t, { sourceAccess: false });
  assert.deepEqual(
    (
      await executeAsync({ root: legacy.root }, "connection_access", {
        connection: "sales",
      })
    ).result.actions,
    [],
  );
});
test("explicit testing passes only named secrets, stores a receipt and never writes source values", async (t) => {
  const f = setup(t);
  const ctx = {
    root: f.root,
    allowWrite: true,
    allowExecute: true,
    allowNetwork: true,
  };
  const result = await executeAsync(ctx, "connection_test", {
    connection: "sales",
    envFile: ".private.env",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.status, "succeeded");
  const receipt = readFileSync(
    resolve(f.root, `.ingestron/source-access/${result.result.receipt}.json`),
    "utf8",
  );
  assert.doesNotMatch(receipt, /synthetic-only|must-not-pass/);
  const invalid = await executeAsync(ctx, "connection_test", {
    connection: "sales",
    source: { table: "Orders", password: "no" },
    envFile: ".private.env",
  });
  assert.equal(invalid.diagnostics[0].code, "CONNECTION");
  f.project.connections.sales.settings.password = {
    $secret: { env: "PYTHONPATH" },
  };
  f.put("project.yaml", f.project);
  const bad = await executeAsync(ctx, "connection_test", {
    connection: "sales",
    envFile: ".private.env",
  });
  assert.equal(bad.diagnostics[0].code, "SECRET");
});
test("metadata writes isolated review drafts, reports unsupported fields and rejects stale receipts", async (t) => {
  const f = setup(t);
  const ctx = { root: f.root, allowWrite: true, allowExecute: true };
  const before = readFileSync(resolve(f.root, "project.yaml"), "utf8");
  const data = await executeAsync(ctx, "connection_metadata", {
    connection: "sales",
    tables: [{ schema: "dbo", table: "Orders" }],
    envFile: ".private.env",
  });
  assert.equal(data.ok, true, JSON.stringify(data));
  const request = {
    connection: "sales",
    receipt: data.result.receipt,
    tables: [{ id: data.result.tables[0].id, name: "Orders" }],
  };
  const draft = await executeAsync(
    { ...ctx, allowExecute: false },
    "connection_contracts",
    request,
  );
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.equal(draft.result.tables[0].fields, 1);
  assert.equal(draft.result.tables[0].skipped[0].name, "geography");
  assert.equal(draft.result.applied, false);
  assert.equal(readFileSync(resolve(f.root, "project.yaml"), "utf8"), before);
  f.project.connections.sales.settings.host = "other.example.invalid";
  f.put("project.yaml", f.project);
  const stale = await executeAsync(ctx, "connection_contracts", request);
  assert.equal(stale.diagnostics[0].code, "STALE");
});
test("failed authentication is a failing operation with a sanitised receipt", async (t) => {
  const f = setup(t, { failing: true });
  const result = await executeAsync(
    { root: f.root, allowWrite: true, allowExecute: true },
    "connection_test",
    { connection: "sales", envFile: ".private.env" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, "SOURCE_ACCESS");
  assert.match(result.diagnostics[0].message, /ACCESS_AUTH/);
  assert.equal(
    result.diagnostics[0].hint,
    "ACCESS_AUTH",
    "Async operations must preserve safe connector codes for host recovery",
  );
  assert.doesNotMatch(JSON.stringify(result), /synthetic-only/);
});

test("reviewed source flow uses receipt mappings and rejects changed drafts before apply", async (t) => {
  const f = setup(t);
  const ctx = {
    root: f.root,
    environment: "dev",
    allowWrite: true,
    allowExecute: true,
  };
  const metadata = await executeAsync(ctx, "connection_metadata", {
    connection: "sales",
    tables: [{ schema: "dbo", table: "Orders" }],
    envFile: ".private.env",
  });
  assert.equal(metadata.ok, true, JSON.stringify(metadata));
  const drafts = await executeAsync(ctx, "connection_contracts", {
    connection: "sales",
    receipt: metadata.result.receipt,
    tables: [{ id: metadata.result.tables[0].id, name: "Orders" }],
  });
  assert.equal(drafts.ok, true, JSON.stringify(drafts));
  f.project.providers.packages.local = {
    source: "example/host/plugin/provider.yaml",
    version: "1.0.0",
  };
  f.project.providers.configurations.local = {
    package: "local",
    binding: "local",
  };
  f.put("project.yaml", f.project);
  const request = {
    id: "sales_bronze",
    connection: "sales",
    provider: "local",
    receipt: metadata.result.receipt,
    tables: [
      {
        id: metadata.result.tables[0].id,
        table: "Orders",
        contract: drafts.result.tables[0].file,
      },
    ],
  };
  const proposal = execute(
    { ...ctx, allowExecute: false },
    "connection_flow_review",
    request,
  );
  assert.equal(proposal.ok, true, JSON.stringify(proposal));
  assert.match(
    proposal.result.changes.find((c: any) => c.path.endsWith("flow.yaml"))
      .after,
    /schema: dbo/,
  );
  assert.equal(f.project.flows.length, 0);
  f.put(
    drafts.result.tables[0].file,
    readFileSync(resolve(f.root, drafts.result.tables[0].file), "utf8") +
      "# edited after review\n",
  );
  const stale = execute(ctx, "apply", { proposal: proposal.result });
  assert.equal(stale.diagnostics[0].code, "STALE");
  const fresh = execute(ctx, "connection_flow_review", request);
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  const applied = execute(ctx, "apply", { proposal: fresh.result });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.match(
    readFileSync(resolve(f.root, "flows/sales_bronze/flow.yaml"), "utf8"),
    /Orders:/,
  );
  assert.doesNotMatch(
    readFileSync(resolve(f.root, "flows/sales_bronze/flow.yaml"), "utf8"),
    /executionProfiles:/,
    "Local-only execution uses its default binding without a duplicate test profile",
  );
  assert.equal(
    execute(ctx, "connection_flow_review", request).diagnostics[0].code,
    "OWNER",
  );
  assert.equal(
    execute(ctx, "connection_flow_review", {
      ...request,
      id: "other",
      tables: [request.tables[0], request.tables[0]],
    }).diagnostics[0].code,
    "SELECT",
  );
  f.project.connections.sales.settings.host = "changed.example.invalid";
  f.put("project.yaml", f.project);
  assert.equal(
    execute(ctx, "connection_flow_review", { ...request, id: "other" })
      .diagnostics[0].code,
    "STALE",
  );
});

test("one reviewed source flow keeps target delivery and local testing on identical tables and contracts", async (t) => {
  const f = setup(t);
  const ctx = {
    root: f.root,
    environment: "dev",
    allowWrite: true,
    allowExecute: true,
  };
  const metadata = await executeAsync(ctx, "connection_metadata", {
    connection: "sales",
    tables: [{ schema: "dbo", table: "Orders" }],
    envFile: ".private.env",
  });
  const drafts = await executeAsync(ctx, "connection_contracts", {
    connection: "sales",
    receipt: metadata.result.receipt,
    tables: [{ id: metadata.result.tables[0].id, name: "Orders" }],
  });
  const origin = resolve(f.root, "source-fixture");
  writeFileSync(
    resolve(origin, "plugin/target.yaml"),
    stringify({
      apiVersion: "ingestron.provider/v1",
      id: "target",
      version: "2.0.0",
      platform: "adf",
      activities: {},
      standards: [
        {
          id: "snapshot@v1",
          description: "Synthetic snapshot",
          sourceKinds: ["azure-sql"],
        },
      ],
    }),
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
    "synthetic target",
  );
  git("tag", "2.0.0");
  installPackage(f.root, "example/target/plugin/target.yaml@2.0.0", {
    fromGit: origin,
  });
  f.project.providers.packages.local = {
    source: "example/host/plugin/provider.yaml",
    version: "1.0.0",
  };
  f.project.providers.packages.target = {
    source: "example/target/plugin/target.yaml",
    version: "2.0.0",
  };
  f.project.providers.configurations.local = {
    package: "local",
    binding: "local",
  };
  f.project.providers.configurations.target = {
    package: "target",
    binding: "platform",
  };
  f.put("project.yaml", f.project);
  const journey = execute(ctx, "connection_journey", { connection: "sales" });
  assert.equal(journey.ok, true, JSON.stringify(journey));
  assert.equal(
    journey.result.providers.find((p: any) => p.id === "target")?.standards[0]
      ?.id,
    "snapshot@v1",
    "Legacy native providers remain available through declared ingestion standards",
  );
  const request = {
    id: "shared",
    connection: "sales",
    provider: "local",
    receipt: metadata.result.receipt,
    tables: [
      {
        id: metadata.result.tables[0].id,
        table: "Orders",
        contract: drafts.result.tables[0].file,
      },
    ],
    target: {
      provider: "target",
      source: { kind: "azure-sql", linkedService: "northwind" },
      ingestion: {
        standard: "snapshot@v1",
        target: { fileSystem: "bronze", path: "orders" },
      },
    },
  };
  const proposal = execute(
    { ...ctx, allowExecute: false },
    "connection_flow_review",
    request,
  );
  assert.equal(proposal.ok, true, JSON.stringify(proposal));
  const { parse } = await import("yaml");
  const flow = parse(
    proposal.result.changes.find((c: any) => c.path.endsWith("flow.yaml"))
      .after,
  );
  assert.equal(flow.provider, "target");
  assert.equal(flow.ingestion.standard, "snapshot@v1");
  assert.equal(flow.executionProfiles.local_test.provider, "local");
  assert.equal(flow.executionProfiles.local_test.ingestion.connection, "sales");
  assert.equal(flow.executionProfiles.local_test.tables, undefined);
  assert.equal(flow.tables.Orders.source.schema, "dbo");
  assert.ok(flow.tables.Orders.contract.$resolve.includes("Orders.odcs.yaml"));
  const nativeRequest = { ...request, id: "native_only", provider: undefined };
  const native = execute(
    { ...ctx, allowExecute: false },
    "connection_flow_review",
    nativeRequest,
  );
  assert.equal(native.ok, true, JSON.stringify(native));
  const nativeFlow = parse(
    native.result.changes.find((c: any) => c.path.endsWith("flow.yaml")).after,
  );
  assert.equal(nativeFlow.provider, "target");
  assert.equal(nativeFlow.executionProfiles, undefined);
  assert.equal(nativeFlow.ingestion.connection, undefined);
  assert.deepEqual(nativeFlow.tables, flow.tables);
  assert.equal(
    execute(ctx, "connection_flow_review", {
      ...nativeRequest,
      target: undefined,
    }).ok,
    false,
  );
  assert.equal(
    execute(ctx, "connection_flow_review", {
      ...nativeRequest,
      runtime: "example/host@1.0.0",
    }).ok,
    false,
  );
  for (const target of [
    { ...request.target, provider: "missing" },
    { ...request.target, ingestion: { standard: "unqualified@v1" } },
    { ...request.target, source: { kind: "files" } },
    { ...request.target, source: { kind: "azure-sql", table: "different" } },
    { ...request.target, source: { kind: "azure-sql", schema: "different" } },
  ]) {
    assert.equal(
      execute(ctx, "connection_flow_review", { ...request, target }).ok,
      false,
    );
  }
  const batch = await executeAsync(ctx, "connection_drafts", {
    connection: "sales",
    envFile: ".private.env",
    tables: Array.from({ length: 101 }, (_, index) => ({
      name: `object_${String(index).padStart(3, "0")}`,
      source: { schema: "dbo", table: `object_${index}` },
    })),
  });
  assert.equal(batch.ok, true, JSON.stringify(batch));
  const groupedRequest = {
    ...request,
    id: "estate",
    receipt: batch.result.receipt,
    groupFields: ["group", "pipeline"],
    target: {
      ...request.target,
      ingestion: {
        ...request.target.ingestion,
        group: "customer_group",
        pipeline: "customer_pipeline",
      },
    },
    tables: batch.result.tables.map((table: any) => ({
      id: table.id,
      table: table.name,
      contract: table.file,
      receipt: table.receipt,
    })),
  };
  const grouped = execute(
    { ...ctx, allowWrite: false, allowExecute: false },
    "connection_flows_review",
    groupedRequest,
  );
  assert.equal(grouped.ok, true, JSON.stringify(grouped));
  const groups = grouped.result.changes
    .filter((change: any) => change.path.endsWith("flow.yaml"))
    .map((change: any) => parse(change.after));
  assert.deepEqual(
    groups.map((flow: any) => flow.ingestion.group),
    ["customer_group_001", "customer_group_002"],
  );
  assert.deepEqual(
    groups.map((flow: any) => flow.ingestion.pipeline),
    ["customer_pipeline_001", "customer_pipeline_002"],
  );
  assert.deepEqual(
    groups.map((flow: any) => Object.keys(flow.tables).length),
    [100, 1],
  );
  assert.ok(
    groups.every(
      (flow: any) =>
        flow.executionProfiles.local_test.ingestion.connection === "sales" &&
        flow.provider === "target",
    ),
  );
  for (const groupFields of [
    ["standard"],
    ["connection"],
    ["missing"],
    ["group", "group"],
  ])
    assert.equal(
      execute(ctx, "connection_flows_review", {
        ...groupedRequest,
        groupFields,
      }).diagnostics[0].code,
      "PROFILE",
    );
  assert.equal(execute(ctx, "apply", { proposal: proposal.result }).ok, true);
});

test("samples need explicit execution and keep business rows out of receipts", async (t) => {
  const f = setup(t, { sample: "valid" });
  const args = {
    connection: "sales",
    envFile: ".private.env",
    source: { schema: "dbo", table: "Orders" },
    limit: 1,
  };
  const denied = await executeAsync(
    { root: f.root, allowWrite: true },
    "connection_sample",
    args,
  );
  assert.equal(denied.ok, false);
  const result = await executeAsync(
    { root: f.root, allowWrite: true, allowExecute: true },
    "connection_sample",
    args,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.sample.rows[0][1], "business-preview-only");
  const receipt = readFileSync(
    resolve(f.root, `.ingestron/source-access/${result.result.receipt}.json`),
    "utf8",
  );
  assert.doesNotMatch(receipt, /business-preview-only/);
  assert.deepEqual(JSON.parse(receipt).result.sample, {
    columns: ["id", "label"],
    rowCount: 1,
    truncated: false,
  });
});
test("sample validation rejects connector overflow, mismatched action and invalid limits", async (t) => {
  for (const sample of ["overflow", "wrong-action"] as const) {
    const f = setup(t, { sample });
    const context = { root: f.root, allowWrite: true, allowExecute: true };
    const args = {
      connection: "sales",
      envFile: ".private.env",
      source: { schema: "dbo", table: "Orders" },
      limit: 1,
    };
    const result = await executeAsync(context, "connection_sample", args);
    assert.equal(result.ok, false, JSON.stringify(result));
    const invalid = await executeAsync(context, "connection_sample", {
      ...args,
      limit: 51,
    });
    assert.equal(invalid.ok, false);
  }
});

test("500-object estate discovers bounded schemas and applies five deterministic flows atomically", async (t) => {
  const f = setup(t);
  const context = {
    root: f.root,
    environment: "dev",
    allowWrite: true,
    allowExecute: true,
  };
  const tables = Array.from({ length: 500 }, (_, index) => ({
    name: `orders_${String(index).padStart(3, "0")}`,
    source: {
      schema: index < 250 ? "sales" : "finance",
      table: `orders_${index}`,
    },
  }));
  const denied = await executeAsync(
    { ...context, allowExecute: false },
    "connection_drafts",
    {
      connection: "sales",
      envFile: ".private.env",
      tables,
    },
  );
  assert.equal(denied.diagnostics[0].code, "PERMISSION");
  const drafts = await executeAsync(context, "connection_drafts", {
    connection: "sales",
    envFile: ".private.env",
    tables: [...tables].reverse(),
  });
  assert.equal(drafts.ok, true, JSON.stringify(drafts));
  assert.equal(drafts.result.tables.length, 500);
  assert.equal(drafts.result.receipts.length, 5);
  assert.equal(
    new Set(drafts.result.tables.map((table: any) => table.id)).size,
    500,
  );
  for (const receipt of drafts.result.receipts) {
    const saved = JSON.parse(
      readFileSync(
        resolve(f.root, `.ingestron/source-access/${receipt}.json`),
        "utf8",
      ),
    );
    assert.equal(saved.result.tables.length, 100);
  }
  // Preserved neighbours and comments are part of the project-owned registry.
  f.project.providers.packages.local = {
    source: "example/host/plugin/provider.yaml",
    version: "1.0.0",
  };
  f.project.providers.configurations.local = {
    package: "local",
    binding: "local",
  };
  f.put("project.yaml", stringify(f.project) + "# preserve estate ownership\n");
  const request = {
    id: "sales_bronze",
    connection: "sales",
    provider: "local",
    receipt: drafts.result.receipt,
    tables: drafts.result.tables.map((table: any) => ({
      id: table.id,
      table: table.name,
      contract: table.file,
      receipt: table.receipt,
    })),
  };
  const proposal = execute(
    { ...context, allowWrite: false, allowExecute: false },
    "connection_flows_review",
    request,
  );
  assert.equal(proposal.ok, true, JSON.stringify(proposal));
  assert.equal(proposal.result.changes.length, 6);
  assert.equal(Object.keys(proposal.result.inputs).length, 505);
  const reversed = execute(context, "connection_flows_review", {
    ...request,
    tables: [...request.tables].reverse(),
  });
  assert.equal(reversed.ok, true, JSON.stringify(reversed));
  assert.deepEqual(
    reversed.result,
    proposal.result,
    "selection order must not change grouping or review identity",
  );
  assert.match(
    proposal.result.changes.find(
      (change: any) => change.path === "project.yaml",
    ).after,
    /preserve estate ownership/,
  );
  const duplicate = execute(context, "connection_flows_review", {
    ...request,
    tables: [...request.tables.slice(0, 499), request.tables[0]],
  });
  assert.equal(duplicate.diagnostics[0].code, "SELECT");
  const changedPath = drafts.result.tables[499].file;
  const original = readFileSync(resolve(f.root, changedPath), "utf8");
  f.put(changedPath, original + "# edited after review\n");
  assert.equal(
    execute(context, "apply", { proposal: proposal.result }).diagnostics[0]
      .code,
    "STALE",
  );
  assert.equal(
    parse(readFileSync(resolve(f.root, "project.yaml"), "utf8")).flows.length,
    0,
  );
  f.put(changedPath, original);
  const applied = execute(context, "apply", { proposal: proposal.result });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const project = parse(readFileSync(resolve(f.root, "project.yaml"), "utf8"));
  assert.equal(project.flows.length, 5);
  assert.deepEqual(
    project.flows.map((flow: any) => flow.$resolve),
    Array.from(
      { length: 5 },
      (_, i) => `./flows/sales_bronze_00${i + 1}/flow.yaml`,
    ),
  );
  const all = project.flows.flatMap((flow: any) => {
    const value = parse(readFileSync(resolve(f.root, flow.$resolve), "utf8"));
    assert.equal(Object.keys(value.tables).length, 100);
    assert.equal(value.provider, "local");
    assert.equal(value.ingestion.connection, "sales");
    return Object.entries(value.tables).map(([name, table]: any) => [
      name,
      table.source,
    ]);
  });
  assert.deepEqual(
    all,
    tables.map((t) => [t.name, t.source]),
  );
  assert.equal(
    execute(context, "connection_flows_review", request).diagnostics[0].code,
    "OWNER",
  );
});

test("inventory scope comes from the locked source schema and reaches the source adapter only after validation", async (t) => {
  const f = setup(t, { inventoryScope: true });
  const context = { root: f.root, allowWrite: true, allowExecute: true };
  const info = await executeAsync({ root: f.root }, "connection_access", {
    connection: "sales",
  });
  assert.equal(info.ok, true);
  assert.deepEqual(info.result.inventoryScopeSchema.required, ["directory"]);
  for (const scope of [
    undefined,
    {},
    { directory: 12 },
    { directory: "" },
    { directory: "reviewed", credential: "PRIVATE_SCOPE_VALUE" },
  ]) {
    const result = await executeAsync(context, "connection_inventory", {
      connection: "sales",
      envFile: ".private.env",
      ...(scope === undefined ? {} : { scope }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0].code, "CONNECTION");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SCOPE_VALUE/);
    assert.equal(
      existsSync(resolve(f.root, ".ingestron/source-access")),
      false,
    );
  }
  const result = await executeAsync(context, "connection_inventory", {
    connection: "sales",
    envFile: ".private.env",
    scope: { directory: "approved-folder" },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.tables[0].name, "approved-folder");
});
test("unscoped connectors reject caller-supplied inventory scope instead of silently ignoring it", async (t) => {
  const f = setup(t);
  const result = await executeAsync(
    { root: f.root, allowWrite: true, allowExecute: true },
    "connection_inventory",
    { connection: "sales", scope: { directory: "unreviewed" } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, "CAPABILITY");
  assert.equal(existsSync(resolve(f.root, ".ingestron/source-access")), false);
});

test("source-owned metadata options are validated before execution and propagated through every draft batch", async (t) => {
  const f = setup(t, { metadataOptions: true });
  const context = { root: f.root, allowWrite: true, allowExecute: true };
  const info = await executeAsync({ root: f.root }, "connection_access", {
    connection: "sales",
  });
  assert.equal(info.ok, true);
  assert.equal(info.result.metadataOptionsSchema.properties.limit.maximum, 50);
  for (const options of [
    {},
    { sampleRecords: false, limit: 2 },
    { sampleRecords: true, limit: 51 },
    { sampleRecords: true, limit: 2, secret: "PRIVATE_OPTIONS" },
    { sampleRecords: true, limit: 2, extra: "x".repeat(100001) },
  ]) {
    const denied = await executeAsync(context, "connection_metadata", {
      connection: "sales",
      tables: [{ schema: "dbo", table: "A" }],
      options,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.diagnostics[0].code, "CONNECTION");
    assert.doesNotMatch(JSON.stringify(denied), /PRIVATE_OPTIONS/);
    assert.equal(
      existsSync(resolve(f.root, ".ingestron/source-access")),
      false,
    );
  }
  const drafts = await executeAsync(context, "connection_drafts", {
    connection: "sales",
    envFile: ".private.env",
    options: { sampleRecords: true, limit: 2 },
    tables: Array.from({ length: 101 }, (_, i) => ({
      source: { schema: "dbo", table: `T${i}` },
      name: `T${i}`,
    })),
  });
  assert.equal(drafts.ok, true, JSON.stringify(drafts));
  assert.equal(drafts.result.receipts.length, 2);
  assert.equal(drafts.result.tables.length, 101);
});

test("undeclared metadata options and record payloads in metadata are refused", async (t) => {
  const f = setup(t, { leakedSample: true });
  const context = { root: f.root, allowWrite: true, allowExecute: true };
  const args = {
    connection: "sales",
    envFile: ".private.env",
    tables: [{ schema: "dbo", table: "A" }],
  };
  const denied = await executeAsync(context, "connection_metadata", {
    ...args,
    options: { sampleRecords: true },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.diagnostics[0].code, "CAPABILITY");
  assert.equal(existsSync(resolve(f.root, ".ingestron/source-access")), false);
  const leak = await executeAsync(context, "connection_metadata", args);
  assert.equal(leak.ok, false);
  assert.equal(leak.diagnostics[0].code, "SOURCE_ACCESS");
  assert.doesNotMatch(JSON.stringify(leak), /PRIVATE_LEAK/);
  const receiptFiles = (await import("node:fs"))
    .readdirSync(resolve(f.root, ".ingestron/source-access"))
    .filter((n) => n.endsWith(".json"));
  for (const file of receiptFiles)
    assert.doesNotMatch(
      readFileSync(resolve(f.root, ".ingestron/source-access", file), "utf8"),
      /PRIVATE_LEAK/,
    );
});

test("missing credentials fail before launch and retain a private failed receipt", async (t) => {
  const f = setup(t);
  const missing =
    "INGESTRON_SOURCE_ACCESS_MISSING_" +
    (await import("node:crypto")).randomUUID().replaceAll("-", "");
  assert.equal(process.env[missing], undefined);
  f.project.connections.sales.settings.password = { $secret: { env: missing } };
  f.put("project.yaml", f.project);
  const result = await executeAsync(
    { root: f.root, allowWrite: true, allowExecute: true },
    "connection_test",
    { connection: "sales" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, "SECRET");
  const files = (await import("node:fs")).readdirSync(
    resolve(f.root, ".ingestron/source-access"),
  );
  assert.equal(
    files.length,
    1,
    "Private task directory is removed before returning",
  );
  const receipt = JSON.parse(
    readFileSync(resolve(f.root, ".ingestron/source-access", files[0]), "utf8"),
  );
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.result, undefined);
  assert.doesNotMatch(
    JSON.stringify(receipt),
    new RegExp(missing + "|password|synthetic-only"),
  );
});

test("unacknowledged read-only provider failure is a repeatable failed source receipt", async (t) => {
  const f = setup(t);
  const origin = resolve(f.root, "source-fixture");
  writeFileSync(
    resolve(origin, "plugin/source_host.py"),
    "raise RuntimeError('PRIVATE_UPSTREAM_FAILURE')\n",
  );
  const manifestPath = resolve(origin, "plugin/provider.yaml");
  const manifest = parse(readFileSync(manifestPath, "utf8"));
  manifest.version = "1.0.1";
  writeFileSync(manifestPath, stringify(manifest));
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
    "Failed provider fixture",
  );
  git("tag", "1.0.1");
  const executor = "example/failed-host/plugin/provider.yaml@1.0.1";
  installPackage(f.root, executor, { fromGit: origin });
  const result = await executeAsync(
    { root: f.root, allowWrite: true, allowExecute: true },
    "connection_test",
    { connection: "sales", executor, envFile: ".private.env" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, "RUNTIME");
  const files = (await import("node:fs")).readdirSync(
    resolve(f.root, ".ingestron/source-access"),
  );
  assert.equal(files.length, 1);
  const receipt = JSON.parse(
    readFileSync(resolve(f.root, ".ingestron/source-access", files[0]), "utf8"),
  );
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.result, undefined);
  assert.doesNotMatch(
    JSON.stringify([receipt, result]),
    /PRIVATE_UPSTREAM_FAILURE|synthetic-only|recover the same run|rebuilding/,
  );
});

test("explicit source cancellation remains interrupted and cleans private task files", async (t) => {
  const f = setup(t, { interruptible: true });
  const previous = process.listenerCount("SIGINT");
  const pending = executeAsync(
    { root: f.root, allowWrite: true, allowExecute: true },
    "connection_test",
    { connection: "sales", envFile: ".private.env" },
  );
  assert.ok(
    process.listenerCount("SIGINT") > previous,
    "Execution installs its cancellation handler before waiting",
  );
  process.emit("SIGINT");
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, "INTERRUPTED");
  assert.equal(process.listenerCount("SIGINT"), previous);
  const files = (await import("node:fs")).readdirSync(
    resolve(f.root, ".ingestron/source-access"),
  );
  assert.equal(files.length, 1);
  const receipt = JSON.parse(
    readFileSync(resolve(f.root, ".ingestron/source-access", files[0]), "utf8"),
  );
  assert.equal(receipt.status, "interrupted");
  assert.equal(receipt.result, undefined);
});

test("saved inventory survives reopening but never grants metadata or contract authority", async (t) => {
  const f = setup(t),
    ctx = {
      root: f.root,
      environment: "dev",
      allowWrite: true,
      allowExecute: true,
    };
  const inventory = await executeAsync(ctx, "connection_inventory", {
    connection: "sales",
    envFile: ".private.env",
  });
  assert.equal(inventory.ok, true, JSON.stringify(inventory));
  const saved = execute(ctx, "connection_journey", { connection: "sales" });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.deepEqual(saved.result.inventory.tables, inventory.result.tables);
  assert.equal(saved.result.receipt, "");
  assert.deepEqual(saved.result.tables, []);
  assert.deepEqual(saved.result.drafts, []);
  assert.doesNotMatch(JSON.stringify(saved), /synthetic-only/);
  const wrongEnvironment = execute(
    { ...ctx, environment: "prod" },
    "connection_journey",
    { connection: "sales" },
  );
  if (wrongEnvironment.ok)
    assert.deepEqual(wrongEnvironment.result.inventory.tables, []);
  f.project.connections.sales.settings.host = "changed.invalid";
  f.put("project.yaml", f.project);
  const stale = execute(ctx, "connection_journey", { connection: "sales" });
  assert.deepEqual(stale.result.inventory.tables, []);
});

test("saved discovery resumes only current metadata and its isolated contract selection without execution", async (t) => {
  const f = setup(t);
  const ctx = {
    root: f.root,
    environment: "dev",
    allowWrite: true,
    allowExecute: true,
  };
  const metadata = await executeAsync(ctx, "connection_metadata", {
    connection: "sales",
    tables: [{ schema: "dbo", table: "Orders" }],
    envFile: ".private.env",
  });
  assert.equal(metadata.ok, true, JSON.stringify(metadata));
  const drafts = await executeAsync(ctx, "connection_contracts", {
    connection: "sales",
    receipt: metadata.result.receipt,
    tables: [{ id: metadata.result.tables[0].id, name: "Orders" }],
  });
  assert.equal(drafts.ok, true, JSON.stringify(drafts));
  const resume = () =>
    execute({ root: f.root, environment: "dev" }, "connection_journey", {
      connection: "sales",
    });
  const saved = resume();
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.result.receipt, metadata.result.receipt);
  assert.equal(saved.result.drafts[0].file, drafts.result.tables[0].file);
  assert.equal(saved.result.tables[0].source.table, "Orders");
  assert.equal(saved.result.receipts.length, 1);
  const selectionFile = resolve(
    f.root,
    drafts.result.tables[0].file.replace(/[^/]+$/, "selection.json"),
  );
  const selectionText = readFileSync(selectionFile, "utf8");
  const malformed = JSON.parse(selectionText);
  malformed.tables[0].fields = { unsafe: "synthetic-untrusted-payload" };
  writeFileSync(selectionFile, JSON.stringify(malformed));
  assert.deepEqual(resume().result.drafts, []);
  writeFileSync(selectionFile, selectionText);

  assert.doesNotMatch(JSON.stringify(saved), /synthetic-only/);
  f.project.connections.sales.settings.host = "changed.invalid";
  f.put("project.yaml", f.project);
  const stale = resume();
  assert.equal(stale.ok, true, JSON.stringify(stale));
  assert.equal(stale.result.receipt, "");
  assert.deepEqual(stale.result.drafts, []);
  assert.equal(
    execute({ root: f.root, environment: "dev" }, "connection_journey", {
      connection: "sales",
      receipt: metadata.result.receipt,
    }).diagnostics[0].code,
    "STALE",
  );
});

test("saved source journey combines distinct current metadata batches with their original receipt identities", async (t) => {
  const f = setup(t),
    ctx = {
      root: f.root,
      environment: "dev",
      allowWrite: true,
      allowExecute: true,
    };
  const receipts: string[] = [];
  for (const name of ["Orders", "Customers"]) {
    const meta = await executeAsync(ctx, "connection_metadata", {
      connection: "sales",
      tables: [{ schema: "dbo", table: name }],
      envFile: ".private.env",
    });
    assert.equal(meta.ok, true, JSON.stringify(meta));
    receipts.push(meta.result.receipt);
    const draft = await executeAsync(ctx, "connection_contracts", {
      connection: "sales",
      receipt: meta.result.receipt,
      tables: [{ id: meta.result.tables[0].id, name }],
    });
    assert.equal(draft.ok, true, JSON.stringify(draft));
  }
  const saved = execute(ctx, "connection_journey", { connection: "sales" });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.result.drafts.length, 2);
  assert.deepEqual(
    new Set(saved.result.drafts.map((d: any) => d.receipt)),
    new Set(receipts),
  );
  assert.equal(saved.result.draftsTruncated, false);
});

test("portable live discovery reuses current metadata receipts without target generation or extra source access", async (t) => {
  const f = setup(t),
    ctx = {
      root: f.root,
      environment: "dev",
      allowWrite: true,
      allowExecute: true,
    };
  const metadata = await executeAsync(ctx, "connection_metadata", {
    connection: "sales",
    envFile: ".private.env",
    tables: [
      { schema: "dbo", table: "Orders" },
      { schema: "dbo", table: "Customers" },
    ],
  });
  assert.equal(metadata.ok, true, JSON.stringify(metadata.diagnostics));
  const inventory = execute(ctx, "discovery_read", { connection: "sales" });
  assert.equal(inventory.ok, true, JSON.stringify(inventory.diagnostics));
  const review = execute(
    { root: f.root, environment: "dev" },
    "discovery_review",
    {
      connection: "sales",
      revision: inventory.result.revision,
      receipts: [metadata.result.receipt],
    },
  );
  assert.equal(review.ok, true, JSON.stringify(review.diagnostics));
  assert.equal(review.result.input.snapshot.coverage.complete, false);
  assert.equal(review.result.input.snapshot.objects.length, 2);
  assert.equal(review.result.input.snapshot.connector.version, "1.0.0");
  const saved = execute({ root: f.root, allowWrite: true }, "discovery_apply", {
    input: review.result.input,
    proposalId: review.result.proposal.id,
  });
  assert.equal(saved.ok, true, JSON.stringify(saved.diagnostics));
  const stale = f.project.connections.sales.settings as any;
  stale.host = "changed.invalid";
  f.put("project.yaml", f.project);
  const current = execute(ctx, "discovery_read", { connection: "sales" });
  const rejected = execute(ctx, "discovery_review", {
    connection: "sales",
    revision: current.result.revision,
    receipts: [metadata.result.receipt],
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.diagnostics[0].code, "STALE");
});
