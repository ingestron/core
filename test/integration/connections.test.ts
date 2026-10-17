import { digest, canonical } from "../../src/core/errors.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { stringify, parse } from "yaml";
import { fixture } from "../support/project.js";
import { installPackage } from "../../src/core/packages.js";
import { execute } from "../../src/core/operations.js";
import { pluginConfigure } from "../../src/core/workflows.js";
import { prepareConnection } from "../../src/core/connections.js";
test("locked connector browsing returns its authoring schema without connection values", (t) => {
  const f = setup(t, true);
  const result = execute({ root: f.root }, "plugin_browse", {
    kind: "connector",
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const [connector] = result.result;
  assert.deepEqual(connector.definition.tableSourceSchema.properties, {
    schema: { type: "string" },
    table: { type: "string" },
  });
  assert.ok(connector.definition.settingsSchema.properties.password);
  assert.equal(Object.hasOwn(connector, "settings"), false);
  assert.equal(Object.hasOwn(connector, "connection"), false);
});
function setup(
  t: any,
  perTableSource: boolean | Record<string, unknown> = false,
  connector: any = {},
  provider: any = {},
  scheduling?: any,
  indexed = false,
) {
  const f = fixture(t),
    origin = resolve(f.root, "connection-plugin");
  mkdirSync(resolve(origin, "plugin"), { recursive: true });
  const object = (properties: any, required = Object.keys(properties)) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
  const text = { type: "string" };
  writeFileSync(
    resolve(origin, "plugin/provider.yaml"),
    stringify({
      apiVersion: "ingestron.provider/v1",
      id: "fixture",
      version: "1.0.0",
      platform: "test",
      activities: {},
      compatibility: {
        plan: "ingestron.plan/v1",
        minimumCli: "4.2.0",
        requiredFeatures: [
          "connector-runtime-capabilities",
          ...(indexed ? ["connection-metadata-documents"] : []),
          ...(provider.sources ? ["source-coverage"] : []),
        ],
      },
      ...provider,
      connectorRuntimes: {
        "ingestron.snapshot/python/v1": {
          selectionSchema: { type: "object", additionalProperties: true },
          executionSchema: object({
            mode: { type: "string", enum: ["local"] },
          }),
          prepareCommand: "connection prepare",
          ...(indexed
            ? { metadataDocuments: "ingestron.metadata-documents/v1" }
            : {}),
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
            description: "Synthetic connection",
            inputSchema: { type: "object", additionalProperties: true },
          },
        ],
      },
    }),
  );
  writeFileSync(
    resolve(origin, "plugin/commands.mjs"),
    "export function command(request) {return {echo:request.input};}",
  );
  const asset = JSON.stringify({
    "runtime.py": "# synthetic, never executed\n",
  });
  const sourceManifest = {
    apiVersion: "ingestron.connector/v1",
    id: "synthetic",
    version: "1.0.0",
    description: "Synthetic source",
    connector: "example:db@1.0.0",
    documentation: "https://example.invalid/docs",
    upstream: {
      ecosystem: "singer",
      variant: "synthetic",
      package: "synthetic",
      version: "1.0.0",
      repository: "https://example.invalid/repo",
      licence: "LicenseRef-Synthetic",
      licenceFile: "upstream-terms.txt",
      licenceStatus: "evidenced",
    },
    runtime: {
      path: "runtime.json",
      sha256: digest(asset),
      contract: "ingestron.snapshot/python/v1",
      ...(indexed
        ? { metadataDocuments: "ingestron.metadata-documents/v1" }
        : {}),
    },
    definition: {
      settingsSchema: object({
        host: text,
        password: object({ $secret: object({ env: text }) }),
      }),
      selectionSchema: { type: "object", additionalProperties: true },
      ...(perTableSource
        ? {
            tableSourceSchema:
              typeof perTableSource === "object"
                ? perTableSource
                : object({ schema: text, table: text }),
          }
        : {}),
    },
    execution: { test: { modes: ["local"], evidence: "synthetic" } },
    ...connector,
  };
  writeFileSync(resolve(origin, "connector.yaml"), stringify(sourceManifest));
  writeFileSync(resolve(origin, "runtime.json"), asset);
  writeFileSync(
    resolve(origin, "upstream-terms.txt"),
    "Synthetic test licence\n",
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
  installPackage(f.root, "example/connections@1.0.0", { fromGit: origin });
  f.project.providers.packages.dbx = {
    source: "example/connections",
    version: "1.0.0",
  };
  installPackage(f.root, "example/source/connector.yaml@1.0.0", {
    fromGit: origin,
  });
  f.project.providers.packages.source = {
    source: "example/source/connector.yaml",
    version: "1.0.0",
  };
  f.project.connections = {
    sales: {
      package: "source",
      connector: "example:db@1.0.0",
      sourceId: "erp",
      tenantId: "nz",
      binding: "sales",
      settings: { host: "default" },
    },
  };
  f.project.environments.dev.bindings.sales = {
    host: "local",
    password: { $secret: { env: "SALES_PASSWORD" } },
  };
  f.project.flows = [
    {
      apiVersion: "ingestron.flow/v1",
      id: "sales",
      kind: "ingestion",
      provider: "engineering",
      tables: {
        orders: {
          source: perTableSource
            ? { schema: "dbo", table: "Orders" }
            : { stream: "orders" },
          contract: {
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
          },
        },
      },
      ingestion: {
        connection: "sales",
        execution: { mode: "local" },
      },
    },
  ];
  const run = () => {
    writeFileSync(resolve(f.root, "project.yaml"), stringify(f.project));
    return execute(
      {
        root: f.root,
        environment: "dev",
        allowWrite: false,
        allowNetwork: false,
      },
      "connection_prepare",
      { flow: "sales" },
    );
  };
  return { ...f, origin, run };
}
test("a declared source stream survives a different output table name", (t) => {
  const f = setup(t, {
    type: "object",
    properties: { stream: { type: "string", enum: ["issues"] } },
    required: ["stream"],
    additionalProperties: false,
  });
  f.project.flows[0].tables.orders.source = { stream: "issues" };
  const prepared = f.run();
  assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
  const tables = prepared.result.result.echo.tables;
  assert.deepEqual(tables.orders.source, { stream: "issues" });
  assert.equal(tables.orders.contract.id, "orders");
  f.project.flows[0].tables.duplicate = structuredClone(
    f.project.flows[0].tables.orders,
  );
  const duplicate = f.run();
  assert.equal(duplicate.ok, false);
  assert.match(
    JSON.stringify(duplicate.diagnostics),
    /Duplicate source stream/,
  );
  delete f.project.flows[0].tables.duplicate;
  f.project.flows[0].tables.orders.source.stream = "unreviewed";
  assert.equal(
    f.run().ok,
    false,
    "Declared source schema remains authoritative",
  );
});
test("connection and workflow authoring use reviewable project proposals", (t) => {
  const f = setup(t);
  const contract = f.project.flows[0].tables.orders.contract;
  f.project.connections = {};
  f.project.flows = [];
  mkdirSync(resolve(f.root, "contracts"), { recursive: true });
  writeFileSync(
    resolve(f.root, "contracts/orders.odcs.yaml"),
    stringify(contract),
  );
  writeFileSync(resolve(f.root, "project.yaml"), stringify(f.project));
  const context = {
    root: f.root,
    environment: "dev",
    allowWrite: true,
    allowNetwork: false,
  };
  const connection = execute(context, "connection_add", {
    id: "sales",
    package: "source",
    sourceId: "erp",
    tenantId: "nz",
    settings: { host: "default" },
    binding: "sales",
  });
  assert.equal(connection.ok, true, JSON.stringify(connection));
  assert.equal(
    execute(context, "apply", { proposal: connection.result }).ok,
    true,
  );
  const flow = execute(context, "connection_flow_add", {
    id: "sales",
    provider: "engineering",
    connection: "sales",
    table: "orders",
    contract: "contracts/orders.odcs.yaml",
    source: { stream: "orders" },
  });
  assert.equal(flow.ok, true, JSON.stringify(flow));
  assert.equal(execute(context, "apply", { proposal: flow.result }).ok, true);
  const prepared = execute(context, "connection_prepare", {
    flow: "sales",
    validateOnly: true,
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const discovery = "build/studio/dev/sales/flows/sales/discovery.json";
  mkdirSync(resolve(f.root, "build/studio/dev/sales/flows/sales"), {
    recursive: true,
  });
  writeFileSync(
    resolve(f.root, discovery),
    JSON.stringify({
      apiVersion: "ingestron.singer-discovery/v1",
      identity: { projectSpecSha256: prepared.result.specificationSha256 },
      catalog: {
        streams: [
          {
            stream: "orders",
            tap_stream_id: "orders",
            schema: {
              type: "object",
              properties: { id: { type: "integer" } },
            },
          },
        ],
      },
    }),
  );
  const packet = execute(context, "connection_prepare", { flow: "sales" });
  assert.equal(packet.ok, true, JSON.stringify(packet));
  const { runtimeAssets, ...savedSpecification } = packet.result.result.echo;
  const savedPath =
    "build/studio/dev/sales/flows/sales/project-connection.lock.json";
  writeFileSync(resolve(f.root, savedPath), JSON.stringify(savedSpecification));
  const mapping = execute(context, "contract_map_fields", {
    apiVersion: "ingestron.field-mapping/v1",
    flow: "sales",
    environment: "dev",
    contract: "contracts/orders.odcs.yaml",
    discovery,
    stream: "orders",
    table: "orders",
    fields: [{ source: "id", target: "customer_id" }],
  });
  assert.equal(mapping.ok, true, JSON.stringify(mapping));
  assert.equal(
    execute(context, "apply", { proposal: mapping.result }).ok,
    true,
  );
  const changed = parse(
    readFileSync(resolve(f.root, "contracts/orders.odcs.yaml"), "utf8"),
  );
  assert.equal(changed.schema[0].properties[0].name, "customer_id");
  assert.equal(changed.schema[0].properties[0].physicalName, "id");
  const next = {
    apiVersion: "ingestron.field-mapping/v1",
    flow: "sales",
    environment: "dev",
    contract: "contracts/orders.odcs.yaml",
    discovery,
    stream: "orders",
    table: "orders",
    fields: [{ source: "id", target: "account_id" }],
  };
  const remapping = execute(context, "contract_map_fields", next);
  assert.equal(remapping.ok, true, JSON.stringify(remapping));
  assert.ok(remapping.result.inputs[savedPath]);
  writeFileSync(
    resolve(f.root, savedPath),
    JSON.stringify(savedSpecification) + "\n",
  );
  const stale = execute(context, "apply", { proposal: remapping.result });
  assert.equal(stale.ok, false);
  assert.equal(stale.diagnostics[0].code, "STALE");
  const located = execute(context, "authoring_locations", {
    flow: "sales",
  }).result;
  const literal = parse(
    readFileSync(resolve(f.root, located.flow.path), "utf8"),
  );
  literal.tables.orders.source.stream = "changed_source";
  writeFileSync(resolve(f.root, located.flow.path), stringify(literal));
  const foreign = execute(context, "contract_map_fields", next);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.diagnostics[0].code, "DISCOVERY");
});
test("one connection selects multiple physical tables with contract-derived columns and short package refs", (t) => {
  const f = setup(t, true);
  f.project.packages = {
    dbx: "example/connections@1.0.0",
    source: "synthetic@1.0.0",
  };
  f.project.providers.packages = {};
  f.project.flows[0].tables.customers = {
    source: { schema: "sales", table: "Customers" },
    contract: structuredClone(f.project.flows[0].tables.orders.contract),
  };
  const prepared = f.run();
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const tables = prepared.result.result.echo.tables;
  assert.deepEqual(tables.orders.source, {
    schema: "dbo",
    table: "Orders",
    stream: "orders",
  });
  assert.deepEqual(tables.customers.source, {
    schema: "sales",
    table: "Customers",
    stream: "customers",
  });
  assert.deepEqual(tables.orders.columns, tables.customers.columns);
  f.project.flows[0].tables.customers.source.columns = ["id"];
  const rejected = f.run();
  assert.equal(rejected.ok, false);
  assert.match(
    JSON.stringify(rejected.diagnostics),
    /source|additional properties/i,
  );
});
test("connector registration writes a short package name in a top-level package map", (t) => {
  const f = setup(t, true);
  f.project.packages = {};
  f.run();
  const proposal = pluginConfigure(f.root, {
    reference: "example/source/connector.yaml@1.0.0",
    name: "synthetic",
  });
  const project = parse(
    proposal.changes.find((change) => change.path === "project.yaml")!.after,
  );
  assert.equal(project.packages.synthetic, "synthetic@1.0.0");
  assert.equal(project.providers.packages.synthetic, undefined);
});
test("project connection resolves bindings through locked schema and offline operation", (t) => {
  const f = setup(t);
  const result = f.run();
  assert.equal(result.ok, true, JSON.stringify(result));
  const input = result.result.result.echo;
  assert.equal(input.settings.host, "local");
  assert.deepEqual(input.settings.password, {
    $secret: { env: "SALES_PASSWORD" },
  });
  assert.match(input.specificationSha256, /^[a-f0-9]{64}$/);
  assert.equal(input.sourcePackage.commit, input.executionPackage.commit);
  const before = input.specificationSha256;
  f.project.connections.sales.settings.host = "unused overridden value";
  assert.equal(f.run().result.result.echo.specificationSha256, before);
  f.project.environments.dev.bindings.sales.host = "another";
  assert.notEqual(f.run().result.result.echo.specificationSha256, before);
});
test("connection preparation reuses a selected model contract", (t) => {
  const f = setup(t);
  const contract = structuredClone(f.project.flows[0].tables.orders.contract);
  const pack = {
    apiVersion: "ingestron.extension-pack/v2",
    kind: "model",
    id: "sample",
    version: "1.0.0",
    description: "Synthetic source model",
    contracts: { orders: contract },
    relationships: [],
    provenance: {
      sources: ["synthetic fixture"],
      retrieved: "2026-09-23",
      status: "recorded-schema",
      notes: "Synthetic test only",
    },
  };
  f.put("models/sample.yaml", pack);
  f.project.modelPacks = {
    sample: { source: "./models/sample.yaml", version: "1.0.0" },
  };
  f.project.flows[0].tables.orders.contract = { $model: "sample:orders" };
  const prepared = f.run();
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.deepEqual(
    prepared.result.result.echo.tables.orders.contract,
    contract,
  );
  f.project.flows[0].tables.orders.contract = { $model: "sample:missing" };
  const rejected = f.run();
  assert.equal(rejected.ok, false);
  assert.match(JSON.stringify(rejected.diagnostics), /Unknown model/);
});
test("typed installation rejects the wrong package before changing its lock", (t) => {
  const f = setup(t);
  const reference = "example/source/connector.yaml@1.0.0";
  const lock = readFileSync(resolve(f.root, "packages.lock.yaml"), "utf8");
  for (const options of [
    { kind: "provider" as const },
    { kind: "provider" as const, update: true, fromGit: f.origin },
  ])
    assert.throws(
      () => installPackage(f.root, reference, options),
      /Expected a provider package/,
    );
  assert.equal(
    readFileSync(resolve(f.root, "packages.lock.yaml"), "utf8"),
    lock,
  );
  assert.equal(
    installPackage(f.root, reference, { kind: "connector" }).cached,
    true,
  );
});
test("rejects plain credentials, $env interpolation, unknown settings and modes", (t) => {
  const f = setup(t);
  const binding = f.project.environments.dev.bindings.sales;
  binding.password = "not-a-real-password";
  assert.equal(f.run().ok, false);
  binding.password = { $env: "SALES_PASSWORD" };
  assert.equal(f.run().ok, false);
  binding.password = { $secret: { env: "SALES_PASSWORD" } };
  binding.typo = true;
  assert.equal(f.run().ok, false);
  delete binding.typo;
  f.project.flows[0].ingestion.execution.mode = "unsupported";
  assert.equal(f.run().ok, false);
});
test("rejects missing references and unsupported exact connectors", (t) => {
  const f = setup(t);
  f.project.connections.sales.binding = "absent";
  assert.equal(f.run().ok, false);
  f.project.connections.sales.binding = "sales";
  delete f.project.connections.sales.connector;
  assert.equal(f.run().ok, true);
  f.project.connections.sales.connector = "example:db@2.0.0";
  assert.equal(f.run().ok, false);
  f.project.connections.sales.connector = "example:db@1.0.0";
  f.project.flows.push({ ...f.project.flows[0] });
  assert.equal(f.run().ok, false);
});

test("ODCS table references are resolved, validated and preserved without a second selection", (t) => {
  const f = setup(t);
  const contract = {
    apiVersion: "v3.1.0",
    kind: "DataContract",
    id: "customer-contract",
    name: "Customers",
    version: "1.0.0",
    status: "draft",
    description: { purpose: "Reviewed business metadata" },
    schema: [
      {
        name: "customers",
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
  };
  writeFileSync(resolve(f.root, "customers.odcs.yaml"), stringify(contract));
  delete f.project.flows[0].ingestion.select;
  f.project.flows[0].tables = {
    customers: {
      source: { stream: "public-customers" },
      contract: { $resolve: "customers.odcs.yaml" },
    },
  };
  const result = f.run();
  assert.equal(result.ok, true, JSON.stringify(result));
  const input = result.result.result.echo;
  assert.deepEqual(input.tables.customers.contract, contract);
  assert.equal(input.selection, undefined);
  assert.equal(input.tables.customers.columns[0].key, true);
  f.project.flows[0].ingestion.select = { customers: {} };
  assert.equal(f.run().ok, false);
  delete f.project.flows[0].ingestion.select;
  writeFileSync(
    resolve(f.root, "customers.odcs.yaml"),
    stringify({ ...contract, apiVersion: "unsupported" }),
  );
  assert.equal(f.run().ok, false);
});

test("data-only source packages preserve connection semantics and reject unresolved licences", (t) => {
  const f = setup(t);
  const before = f.run();
  const origin = resolve(f.root, "source-package");
  mkdirSync(origin);
  const definition = parse(
    readFileSync(resolve(f.root, "connection-plugin/connector.yaml"), "utf8"),
  ).definition;
  const manifest: any = {
    apiVersion: "ingestron.connector/v1",
    id: "synthetic",
    version: "1.0.0",
    description: "Synthetic source definition",
    runtime: {
      path: "runtime.json",
      sha256: digest(
        JSON.stringify({ "runtime.py": "# synthetic, never executed\n" }),
      ),
      contract: "ingestron.snapshot/python/v1",
    },
    connector: "example:db@1.0.0",
    documentation: "https://example.invalid/docs",
    upstream: {
      ecosystem: "singer",
      variant: "synthetic",
      package: "synthetic",
      version: "1.0.0",
      repository: "https://example.invalid/repo",
      licence: "LicenseRef-Synthetic",
      licenceFile: "upstream-terms.txt",
      licenceStatus: "unknown",
    },
    definition: {
      settingsSchema: definition.settingsSchema,
      selectionSchema: definition.selectionSchema,
    },
    execution: { test: { modes: ["local"], evidence: "synthetic" } },
  };
  writeFileSync(
    resolve(origin, "upstream-terms.txt"),
    "Synthetic test licence\n",
  );
  writeFileSync(
    resolve(origin, "runtime.json"),
    JSON.stringify({ "runtime.py": "# synthetic, never executed\n" }),
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: origin, stdio: "pipe" });
  git("init", "-q");
  const commit = () => {
    writeFileSync(resolve(origin, "connector.yaml"), stringify(manifest));
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "source definition",
    );
    return git("rev-parse", "HEAD").toString().trim();
  };
  let sha = commit();
  assert.throws(
    () =>
      installPackage(f.root, `example/source/connector.yaml@${sha}`, {
        fromGit: origin,
      }),
    /licence evidence/,
  );
  manifest.upstream.licenceStatus = "conflict";
  sha = commit();
  assert.throws(
    () =>
      installPackage(f.root, `example/source/connector.yaml@${sha}`, {
        fromGit: origin,
      }),
    /licence evidence/,
  );
  manifest.upstream.licenceStatus = "evidenced";
  sha = commit();
  const reference = `example/source/connector.yaml@${sha}`;
  const installed = installPackage(f.root, reference, { fromGit: origin });
  const info = JSON.parse(
    readFileSync(resolve(f.root, installed.informationFile), "utf8"),
  );
  assert.equal(
    info.licenceDocuments.find((d: any) => d.path === "upstream-terms.txt")
      .text,
    "Synthetic test licence\n",
  );
  installPackage(f.root, reference, { frozen: true });
  f.project.providers.packages.source = {
    source: "example/source/connector.yaml",
    version: sha,
  };
  f.project.connections.sales.package = "source";
  const after = f.run();
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.deepEqual(
    after.result.result.echo.settings,
    before.result.result.echo.settings,
  );
  assert.notEqual(
    after.result.result.echo.sourcePackage.commit,
    after.result.result.echo.executionPackage.commit,
  );
  assert.notEqual(
    after.result.result.echo.specificationSha256,
    before.result.result.echo.specificationSha256,
  );
  delete f.project.connections.sales.connector;
  const inferred = f.run();
  assert.equal(inferred.ok, true, JSON.stringify(inferred));
  assert.equal(
    inferred.result.result.echo.specificationSha256,
    after.result.result.echo.specificationSha256,
  );
  const asset = JSON.stringify({
    "runtime.py": "# not executed by compiler\n",
  });
  writeFileSync(resolve(origin, "runtime.json"), asset);
  manifest.runtime = {
    path: "runtime.json",
    sha256: digest(asset),
    contract: "ingestron.snapshot/python/v1",
  };
  sha = commit();
  installPackage(f.root, `example/source/connector.yaml@${sha}`, {
    fromGit: origin,
  });
  f.project.providers.packages.source.version = sha;
  const transported = f.run();
  assert.equal(transported.ok, true, JSON.stringify(transported));
  assert.deepEqual(
    transported.result.result.echo.runtimeAssets,
    JSON.parse(asset),
  );
  assert.equal(
    transported.result.result.echo.runtimeAssetSha256,
    digest(asset),
  );
  manifest.connector = "example:new-source@1.0.0";
  manifest.runtime.contract = "ingestron.snapshot/python/v1";
  sha = commit();
  installPackage(f.root, `example/source/connector.yaml@${sha}`, {
    fromGit: origin,
  });
  f.project.providers.packages.source.version = sha;
  const generic = f.run();
  assert.equal(generic.ok, true, JSON.stringify(generic));
  assert.equal(
    generic.result.result.echo.runtimeContract,
    "ingestron.snapshot/python/v1",
  );
  manifest.runtime.contract = "unknown/v2";
  sha = commit();
  installPackage(f.root, `example/source/connector.yaml@${sha}`, {
    fromGit: origin,
  });
  f.project.providers.packages.source.version = sha;
  assert.equal(f.run().ok, false);
  manifest.runtime.contract = "ingestron.snapshot/python/v1";
  manifest.runtime.sha256 = "0".repeat(64);
  sha = commit();
  installPackage(f.root, `example/source/connector.yaml@${sha}`, {
    fromGit: origin,
  });
  f.project.providers.packages.source.version = sha;
  assert.equal(f.run().ok, false);
  manifest.runtime = {
    path: "../runtime.json",
    sha256: digest(asset),
    contract: "ingestron.snapshot/python/v1",
  };
  sha = commit();
  installPackage(f.root, `example/source/connector.yaml@${sha}`, {
    fromGit: origin,
  });
  f.project.providers.packages.source.version = sha;
  assert.equal(f.run().ok, false);
  f.project.connections.sales.connector = "example:db@2.0.0";
  assert.equal(f.run().ok, false);
});

test("retired selection and provider-owned connector formats are rejected", (t) => {
  const f = setup(t);
  delete f.project.flows[0].tables;
  assert.equal(f.run().ok, false);
  f.project.flows[0].ingestion.select = { orders: {} };
  assert.equal(f.run().ok, false);
  delete f.project.flows[0].ingestion.select;
  f.project.connections.sales.package = "dbx";
  assert.equal(f.run().ok, false);
});

test("whole-project check validates mixed connector and native flows without a partial native selection", (t) => {
  const f = setup(t);
  const nativeOrigin = resolve(f.root, "fixture-origin");
  const renderer = resolve(nativeOrigin, "plugin/index.mjs");
  writeFileSync(
    renderer,
    readFileSync(renderer, "utf8").replace(
      "export function render(p){",
      "export function render(p){if(p.selection.flow)throw new Error('partial native selection');",
    ),
  );
  const manifest = resolve(nativeOrigin, "plugin/provider.yaml");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8").replace("version: 1.0.0", "version: 1.0.1"),
  );
  execFileSync("git", ["add", "plugin/index.mjs", "plugin/provider.yaml"], {
    cwd: nativeOrigin,
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "selection guard",
    ],
    { cwd: nativeOrigin },
  );
  execFileSync("git", ["tag", "1.0.1"], { cwd: nativeOrigin });
  installPackage(f.root, "example/fixture@1.0.1", { fromGit: nativeOrigin });
  f.project.providers.packages.native = {
    source: "example/fixture",
    version: "1.0.1",
  };
  f.project.providers.configurations.native = {
    package: "native",
    binding: "lakehouse",
  };
  f.flow.provider = "native";
  f.put("flows/source/flow.yaml", f.flow);
  f.project.flows.push({ $resolve: "./flows/source/flow.yaml" });
  f.put("project.yaml", f.project);
  const checked = execute(
    { root: f.root, environment: "dev", allowWrite: false },
    "validate",
    { mode: "strict" },
  );
  assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
  assert.equal(checked.result.connections.length, 1);
});

test("connection flows use the connector's pre-commit quality checks for coverage", (t) => {
  const rule = {
    id: "id-valid",
    metric: "invalidValues",
    arguments: { validValues: [1, 2] },
    mustBe: 0,
    severity: "error",
  };
  const validate = (connector: any) => {
    const f = setup(t, false, connector);
    f.project.flows[0].tables.orders.contract.schema[0].properties[0].quality =
      [rule];
    writeFileSync(resolve(f.root, "project.yaml"), stringify(f.project));
    return execute(
      { root: f.root, environment: "dev", allowWrite: false },
      "validate",
      { mode: "strict" },
    );
  };
  const blocked = validate({});
  assert.equal(blocked.ok, false);
  assert.match(JSON.stringify(blocked.diagnostics), /id-valid/);
  const checked = validate({
    quality: { library: { invalidValues: "at-load" } },
  });
  assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
  assert.deepEqual(checked.result.quality.summary, {
    rules: 1,
    atLoad: 1,
    afterLoad: 0,
    unsupported: 0,
    documentation: 0,
  });
});

const record = (extra: any = {}) => ({
  docs: "https://example.invalid/docs",
  vendorStatus: "ga",
  licence: "LicenseRef-Synthetic",
  cost: { model: "included" },
  access: { model: "platform" },
  network: ["public"],
  maturity: "preview",
  verified: "2026-09-30",
  ...extra,
});

test("check lists source routes with reference records and blocks missing capabilities", (t) => {
  const run = (
    connector: any,
    provider: any,
    edit: (f: any) => void = () => {},
  ) => {
    const f = setup(t, false, connector, provider);
    edit(f);
    writeFileSync(resolve(f.root, "project.yaml"), stringify(f.project));
    return execute(
      { root: f.root, environment: "dev", allowWrite: false },
      "validate",
      { mode: "strict" },
    );
  };
  const source = {
    source: {
      kind: "example-db",
      capabilities: ["snapshot", "discovery"],
      reference: record({ cost: { model: "none" }, access: { model: "free" } }),
    },
  };
  const sources = {
    sources: {
      "example-db": {
        route: "native",
        standards: ["snapshot-land@v1"],
        capabilities: ["snapshot", "incremental"],
        reference: record(),
      },
    },
  };
  const checked = run(source, sources);
  assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
  const [entry] = checked.result.sources;
  assert.equal(entry.kind, "example-db");
  assert.equal(entry.selected.route, "portable");
  assert.equal(entry.selected.package, "synthetic@1.0.0");
  assert.equal(entry.selected.reference.maturity, "preview");
  assert.equal(entry.alternative.route, "native");
  assert.deepEqual(entry.alternative.standards, ["snapshot-land@v1"]);

  const blocked = run(source, sources, (f) => {
    f.project.flows[0].ingestion.requires = ["incremental"];
  });
  assert.equal(blocked.ok, false);
  assert.match(
    JSON.stringify(blocked.diagnostics),
    /cannot supply incremental through portable synthetic@1.0.0/,
  );

  const legacy = run({}, {});
  assert.equal(legacy.ok, true, JSON.stringify(legacy.diagnostics));
  assert.equal(legacy.result.sources[0].kind, "synthetic");
  assert.equal(legacy.result.sources[0].selected.reference, undefined);

  const noKind = run(source, sources, (f) => {
    f.project.connections.sales.route = "native";
  });
  assert.equal(noKind.ok, false);
  assert.match(
    JSON.stringify(noKind.diagnostics),
    /native or bridge connection needs a kind/,
  );
  // This fixture provider cannot plan native flows at all; the native route
  // itself is covered by unit tests and the ADF end-to-end build.
  const listingOnly = run(source, sources, (f) => {
    Object.assign(f.project.connections.sales, {
      route: "native",
      kind: "example-db",
    });
    f.project.flows[0].ingestion.standard = "snapshot-land@v1";
  });
  assert.equal(listingOnly.ok, false);
});

test("portable named profiles reach connection assembly without selecting excluded native flows", (t) => {
  const f = setup(t);
  const flow = f.project.flows[0];
  flow.executionProfiles = {
    local_test: {
      provider: flow.provider,
      source: {},
      ingestion: flow.ingestion,
    },
  };
  f.put("project.yaml", f.project);
  const result = execute(
    { root: f.root, environment: "dev", allowWrite: true },
    "build",
    { flow: flow.id, profile: "local_test" },
  );
  assert.equal(result.ok, false);
  // This synthetic provider deliberately lacks assembly. It must reach that
  // capability boundary rather than fail native selection for a portable flow.
  assert.equal(result.diagnostics[0].code, "CAPABILITY");
  assert.match(result.diagnostics[0].message, /project assembly/);
});

test("connection authoring validates effective installed settings before a proposal", (t) => {
  const f = setup(t);
  f.run();
  const before = readFileSync(resolve(f.root, "project.yaml"), "utf8");
  const context = { root: f.root, environment: "dev", allowWrite: true };
  const marker = "PRIVATE_VALUE_MUST_NOT_APPEAR";
  for (const settings of [
    { host: 42, password: { $secret: { env: "MISSING_AUTHORED_PASSWORD" } } },
    { host: "example.invalid", password: marker },
    { host: "example.invalid", password: { $env: marker } },
    { host: "example.invalid", password: { $secret: { env: "PATH" } } },
    { host: "example.invalid", password: { $secret: { env: "INVALID NAME" } } },
    {
      host: "example.invalid",
      password: {
        $secret: { env: "MISSING_AUTHORED_PASSWORD", extra: marker },
      },
    },
  ]) {
    const result = execute(context, "connection_add", {
      id: "invalid",
      package: "source",
      sourceId: "erp",
      tenantId: "nz",
      settings,
    });
    assert.equal(result.ok, false);
    assert.ok(["CONNECTION", "SECRET"].includes(result.diagnostics[0].code));
    assert.equal(result.result, undefined);
    assert.equal(JSON.stringify(result.diagnostics).includes(marker), false);
    assert.equal(readFileSync(resolve(f.root, "project.yaml"), "utf8"), before);
  }
  const valid = execute(context, "connection_add", {
    id: "valid",
    package: "source",
    sourceId: "erp",
    tenantId: "nz",
    settings: {
      host: "example.invalid",
      password: { $secret: { env: "MISSING_AUTHORED_PASSWORD" } },
    },
  });
  assert.equal(valid.ok, true, JSON.stringify(valid));
  assert.equal(readFileSync(resolve(f.root, "project.yaml"), "utf8"), before);
});

test("connection configuration preserves installed ownership, bindings, siblings and comments", (t) => {
  const f = setup(t);
  f.project.connections.neighbor = {
    ...f.project.connections.sales,
    sourceId: "neighbor",
  };
  f.run();
  const path = resolve(f.root, "project.yaml");
  writeFileSync(
    path,
    "# Keep the engineer's project note\n" + readFileSync(path, "utf8"),
  );
  const before = readFileSync(path, "utf8");
  const context = { root: f.root, environment: "dev", allowWrite: true };
  const proposal = execute(context, "connection_configure", {
    id: "sales",
    sourceId: "reviewed",
    tenantId: "au",
    settings: { host: "{{values.host}}" },
  });
  // The selected binding supplies host/password; a pending credential is not read.
  assert.equal(proposal.ok, true, JSON.stringify(proposal));
  assert.equal(readFileSync(path, "utf8"), before);
  const denied = execute({ ...context, allowWrite: false }, "apply", {
    proposal: proposal.result,
  });
  assert.equal(denied.diagnostics[0].code, "PERMISSION");
  assert.equal(
    execute(context, "apply", { proposal: proposal.result }).ok,
    true,
  );
  const after = readFileSync(path, "utf8");
  assert.ok(after.startsWith("# Keep the engineer's project note\n"));
  const old = parse(before),
    changed = parse(after);
  assert.deepEqual(changed.connections.neighbor, old.connections.neighbor);
  assert.deepEqual(changed.connections.sales, {
    ...old.connections.sales,
    sourceId: "reviewed",
    tenantId: "au",
    settings: { host: "{{values.host}}" },
  });
  assert.deepEqual(changed.providers, old.providers);
});

test("connection authoring resolves selected values and binds newly referenced inputs to approval", (t) => {
  const f = setup(t);
  f.project.environments.dev.values.host = "example.invalid";
  f.run();
  const settingsFile = resolve(f.root, "pending-settings.yaml");
  writeFileSync(
    settingsFile,
    stringify({
      host: "{{values.host}}",
      password: { $secret: { env: "UNSUPPLIED_AUTHORING_SECRET" } },
    }),
  );
  const context = { root: f.root, environment: "dev", allowWrite: true };
  const before = readFileSync(resolve(f.root, "project.yaml"), "utf8");
  const proposal = execute(context, "connection_add", {
    id: "referenced",
    package: "source",
    sourceId: "erp",
    tenantId: "nz",
    settings: { $resolve: "./pending-settings.yaml" },
  });
  assert.equal(proposal.ok, true, JSON.stringify(proposal));
  assert.equal(
    proposal.result.inputs["pending-settings.yaml"],
    digest(readFileSync(settingsFile)),
  );
  writeFileSync(
    settingsFile,
    stringify({
      host: "changed.example.invalid",
      password: { $secret: { env: "UNSUPPLIED_AUTHORING_SECRET" } },
    }),
  );
  const stale = execute(context, "apply", { proposal: proposal.result });
  assert.equal(stale.diagnostics[0].code, "STALE");
  assert.equal(readFileSync(resolve(f.root, "project.yaml"), "utf8"), before);
  f.project.environments.dev.values.password = {
    $env: "PRIVATE_AUTHORING_ENV_VALUE",
  };
  writeFileSync(resolve(f.root, "project.yaml"), stringify(f.project));
  const templateEnv = execute(context, "connection_add", {
    id: "blocked",
    package: "source",
    sourceId: "erp",
    tenantId: "nz",
    settings: { host: "{{values.host}}", password: "{{values.password}}" },
  });
  assert.equal(templateEnv.ok, false);
  assert.equal(templateEnv.diagnostics[0].code, "SECRET");
  assert.equal(
    JSON.stringify(templateEnv.diagnostics).includes(
      "PRIVATE_AUTHORING_ENV_VALUE",
    ),
    false,
  );
});

test("connection authoring rejects unsafe referenced settings and missing bindings without writes", (t) => {
  const f = setup(t);
  f.run();
  const before = readFileSync(resolve(f.root, "project.yaml"), "utf8");
  for (const options of [
    { settings: { $resolve: "../outside.yaml" } },
    { binding: "absent", settings: { host: "example.invalid" } },
  ]) {
    const result = execute({ root: f.root }, "connection_add", {
      id: "blocked",
      package: "source",
      sourceId: "erp",
      tenantId: "nz",
      ...options,
    });
    assert.equal(result.ok, false);
    assert.equal(result.result, undefined);
    assert.equal(readFileSync(resolve(f.root, "project.yaml"), "utf8"), before);
  }
});

test("one reviewed source setup validates an installed package and preserves external provider ownership", (t) => {
  const f = setup(t);
  f.run();
  const path = resolve(f.root, "project.yaml");
  const project = parse(readFileSync(path, "utf8"));
  delete project.providers.packages.source;
  writeFileSync(
    resolve(f.root, "providers.yaml"),
    stringify(project.providers),
  );
  project.providers = { $resolve: "./providers.yaml" };
  writeFileSync(path, stringify(project));
  const before = readFileSync(path, "utf8");
  const providersBefore = readFileSync(
    resolve(f.root, "providers.yaml"),
    "utf8",
  );
  const context = { root: f.root, environment: "dev", allowWrite: true };
  const args = {
    id: "new_source",
    package: "source",
    reference: "example/source/connector.yaml@1.0.0",
    sourceId: "erp",
    tenantId: "nz",
    settings: {
      host: "example.invalid",
      password: { $secret: { env: "UNSUPPLIED_SETUP_SECRET" } },
    },
  };
  const invalid = execute(context, "connection_setup", {
    ...args,
    settings: { host: 42 },
  });
  assert.equal(invalid.ok, false);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(
    readFileSync(resolve(f.root, "providers.yaml"), "utf8"),
    providersBefore,
  );
  const proposal = execute(context, "connection_setup", args);
  assert.equal(proposal.ok, true, JSON.stringify(proposal));
  assert.equal(proposal.result.changes.length, 2);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(
    execute(context, "apply", { proposal: proposal.result }).ok,
    true,
  );
  assert.deepEqual(parse(readFileSync(path, "utf8")).providers, {
    $resolve: "./providers.yaml",
  });
  assert.deepEqual(
    parse(readFileSync(path, "utf8")).connections.new_source.settings,
    args.settings,
  );
  assert.ok(
    parse(readFileSync(resolve(f.root, "providers.yaml"), "utf8")).packages
      .source,
  );
});

test("portable edits reject schema violations while native settings retain platform ownership", (t) => {
  const f = setup(t);
  delete f.project.connections.sales.binding;
  f.project.connections.sales.settings = {
    host: "example.invalid",
    password: { $secret: { env: "UNSUPPLIED_EDIT_SECRET" } },
  };
  f.run();
  const context = { root: f.root, environment: "dev", allowWrite: true };
  const before = readFileSync(resolve(f.root, "project.yaml"), "utf8");
  const result = execute(context, "connection_configure", {
    id: "sales",
    sourceId: "erp",
    tenantId: "nz",
    settings: { host: 42, password: "PRIVATE_INVALID_PASSWORD" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, "CONNECTION");
  assert.equal(
    JSON.stringify(result.diagnostics).includes("PRIVATE_INVALID_PASSWORD"),
    false,
  );
  assert.equal(readFileSync(resolve(f.root, "project.yaml"), "utf8"), before);
  f.project.connections.sales.route = "native";
  f.project.connections.sales.kind = "sql-server";
  f.run();
  const native = execute(context, "connection_configure", {
    id: "sales",
    sourceId: "erp",
    tenantId: "nz",
    settings: { nativeOwned: true },
  });
  assert.equal(native.ok, true, JSON.stringify(native));
  const after = parse(native.result.changes[0].after);
  assert.equal(after.connections.sales.route, "native");
  assert.equal(after.connections.sales.kind, "sql-server");
  assert.equal(after.connections.sales.package, "source");
});

test("portable preparation cannot silently omit a scheduled flow when its provider has no schedule capability", (t) => {
  const f = setup(t);
  const file = resolve(f.root, "project.yaml");
  const project = f.project;
  // The setup's reviewed portable flow is inline in the authoritative project.
  const flow = project.flows.find((item: any) => item.ingestion?.connection);
  assert.ok(flow);
  flow.schedule = {
    apiVersion: "ingestron.schedule/v1",
    enabled: false,
    timeZone: "UTC",
    start: "2026-10-05T00:00:00Z",
    recurrence: { kind: "daily", times: ["09:00"] },
  };
  writeFileSync(file, stringify(project));
  const result = execute({ root: f.root }, "connection_prepare", {
    flow: flow.id,
    validateOnly: true,
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.diagnostics[0].code,
    "SCHEDULE_UNSUPPORTED",
    JSON.stringify(result),
  );
});

test("native calendar capabilities cannot authorise dropping a connector schedule", (t) => {
  const f = setup(
    t,
    false,
    {},
    {
      capabilities: {
        artifactKinds: ["native-notebook"],
        schedules: ["interval", "daily", "weekly", "monthly"],
      },
      compatibility: {
        plan: "ingestron.plan/v1",
        minimumCli: "4.2.0",
        requiredFeatures: ["connector-runtime-capabilities", "flow-schedules"],
      },
    },
  );
  const flow = f.project.flows[0];
  flow.schedule = {
    apiVersion: "ingestron.schedule/v1",
    enabled: true,
    timeZone: "UTC",
    start: "2026-10-05T00:00:17Z",
    end: "2026-10-06T00:00:17Z",
    recurrence: { kind: "interval", minutes: 15 },
    overlap: "native",
    missed: "native",
  };
  const path = resolve(f.root, "project.yaml");
  writeFileSync(path, stringify(f.project));
  const before = readFileSync(path, "utf8");
  for (const validateOnly of [true, false]) {
    const result = execute(
      { root: f.root, allowWrite: true },
      "connection_prepare",
      {
        flow: flow.id,
        validateOnly,
      },
    );
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.diagnostics[0].code, "SCHEDULE_UNSUPPORTED");
    assert.match(
      result.diagnostics[0].message,
      /native asset schedule support/,
    );
    assert.equal(result.result, undefined);
    assert.equal(readFileSync(path, "utf8"), before);
  }
  delete flow.schedule;
  assert.equal(
    f.run().ok,
    true,
    "Unscheduled connector preparation remains available",
  );
});

const schedulingCapability = {
  apiVersion: "ingestron.connector-schedule/v1",
  clock: "portable",
  recurrences: ["interval", "daily", "weekly", "monthly"],
};
const schedulingProvider = {
  compatibility: {
    plan: "ingestron.plan/v1",
    minimumCli: "4.2.0",
    requiredFeatures: [
      "connector-runtime-capabilities",
      "connector-schedule-handover",
    ],
  },
};
const connectionSchedule = {
  apiVersion: "ingestron.schedule/v1",
  enabled: false,
  timeZone: "Pacific/Auckland",
  start: "2026-09-26T13:30:17Z",
  end: "2027-09-26T13:30:17Z",
  recurrence: {
    kind: "weekly",
    weekDays: ["Monday", "Friday"],
    times: ["09:15", "17:45"],
  },
  overlap: "queue",
  missed: "latest",
  daylightSaving: { gap: "skip", fold: "both" },
};
test("an explicitly declared connector adapter receives complete digest-bound scheduling intent", (t) => {
  const f = setup(t, false, {}, schedulingProvider, schedulingCapability);
  const flow = f.project.flows[0];
  const unscheduled = f.run();
  assert.equal(unscheduled.ok, true);
  const before = unscheduled.result.result.echo;
  assert.equal(Object.hasOwn(before, "schedule"), false);
  flow.schedule = connectionSchedule;
  const prepared = f.run();
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const input = prepared.result.result.echo;
  assert.deepEqual(input.schedule.definition, connectionSchedule);
  assert.deepEqual(input.schedule.owner, {
    project: f.project.id,
    environment: "dev",
    flow: "sales",
    connection: "sales",
  });
  assert.equal(
    input.schedule.boundaries.start.instant,
    connectionSchedule.start,
  );
  assert.equal(input.schedule.boundaries.end.instant, connectionSchedule.end);
  assert.equal(
    input.schedule.boundaries.start.localTime,
    "2026-09-27T01:30:17",
  );
  assert.notEqual(input.specificationSha256, before.specificationSha256);
  const {
    specificationSha256,
    runtimeAssets: _assets,
    ...specification
  } = input;
  assert.equal(specificationSha256, digest(canonical(specification)));
  const path = resolve(f.root, "project.yaml");
  const original = readFileSync(path, "utf8");
  const checked = execute({ root: f.root }, "connection_prepare", {
    flow: "sales",
    validateOnly: true,
  });
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.equal(checked.result.specificationSha256, specificationSha256);
  assert.equal(readFileSync(path, "utf8"), original);
  flow.schedule = { ...connectionSchedule, enabled: true };
  assert.notEqual(
    f.run().result.result.echo.specificationSha256,
    specificationSha256,
  );
  delete flow.schedule;
  assert.deepEqual(f.run().result.result.echo, before);
});
test("scheduled connector validation refuses a clock mismatch or unsupported recurrence before provider dispatch", (t) => {
  const f = setup(t, false, {}, schedulingProvider, {
    ...schedulingCapability,
    recurrences: ["daily"],
  });
  const flow = f.project.flows[0];
  flow.schedule = connectionSchedule;
  assert.equal(f.run().diagnostics[0].code, "SCHEDULE_UNSUPPORTED");
  flow.schedule = {
    ...connectionSchedule,
    daylightSaving: undefined,
    overlap: "native",
    missed: "native",
    recurrence: { kind: "daily", times: ["09:15"] },
  };
  assert.equal(f.run().diagnostics[0].code, "SCHEDULE_POLICY");
  delete flow.schedule;
  assert.equal(f.run().ok, true);
});

test("indexed preparation keeps one hundred complete contracts while its isolated compilation request stays bounded", (t) => {
  const f = setup(t, false, {}, {}, undefined, true),
    base = f.project.flows[0].tables.orders;
  base.contract.schema[0].properties = Array.from({ length: 200 }, (_, i) => ({
    name: "business_" + i,
    physicalName: "column_" + i,
    logicalType: "string",
    physicalType: "STRING",
    description: "Reviewed field metadata retained",
  }));
  f.project.flows[0].tables = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [
      "table_" + i,
      {
        source: { stream: "stream_" + i },
        contract: structuredClone(base.contract),
      },
    ]),
  );
  writeFileSync(resolve(f.root, "project.yaml"), stringify(f.project));
  const result = prepareConnection(f.root, "dev", "sales", true);
  assert.equal(result.valid, true);
  assert.match(result.specificationSha256, /^[a-f0-9]{64}$/);
  const prepared: any = execute({ root: f.root }, "connection_prepare", {
    flow: "sales",
  });
  assert.equal(
    prepared.ok,
    false,
    "Synthetic echo provider is not an unapplied artifact proposal",
  );
  assert.match(prepared.diagnostics[0].message, /unapplied artifact proposal/);
});

import {
  readConnectionEditor,
  reviewConnectionEditor,
} from "../../src/core/connection-editor.js";
import { apply } from "../../src/core/authoring.js";
test("connection editor reviews schema fields and secret names without overriding environment ownership", (t) => {
  const f = setup(t, true);
  f.put("project.yaml", f.project);
  const existing = readConnectionEditor(f.root, "dev", {
    package: "source",
    connection: "sales",
  });
  const secret = existing.fields.find((field) => field.type === "secret")!;
  assert.equal(secret.value, "SALES_PASSWORD");
  assert.equal(secret.inherited, true);
  assert.throws(
    () =>
      reviewConnectionEditor(f.root, "dev", {
        package: "source",
        connection: "sales",
        id: "sales",
        sourceId: "erp",
        tenantId: "nz",
        revision: existing.revision,
        values: { [secret.id]: "OTHER_PASSWORD" },
      }),
    /inherited/,
  );
  const start = readConnectionEditor(f.root, "dev", { package: "source" });
  const values = Object.fromEntries(
    start.fields.map((field) => [
      field.id,
      field.type === "secret" ? "WAREHOUSE_PASSWORD" : "warehouse.invalid",
    ]),
  );
  const request = {
    package: "source",
    id: "warehouse",
    sourceId: "warehouse",
    tenantId: "nz",
    revision: start.revision,
    values,
  };
  const before = readFileSync(resolve(f.root, "project.yaml"), "utf8");
  const proposal = reviewConnectionEditor(f.root, "dev", request);
  assert.equal(readFileSync(resolve(f.root, "project.yaml"), "utf8"), before);
  apply(f.root, proposal);
  const saved = readConnectionEditor(f.root, "dev", {
    package: "source",
    connection: "warehouse",
  });
  assert.equal(
    saved.fields.find((field) => field.type === "secret")!.value,
    "WAREHOUSE_PASSWORD",
  );
  assert.throws(
    () => reviewConnectionEditor(f.root, "dev", request),
    /changed/,
  );
  assert.throws(
    () =>
      reviewConnectionEditor(f.root, "dev", {
        ...request,
        connection: "warehouse",
        revision: saved.revision,
        values: { [secret.id]: "literal password!" },
      }),
    /variable name/,
  );
});

test("connection review does not expose literal credentials from sibling environment bindings", (t) => {
  const f = setup(t, true);
  f.project.environments.prod = {
    ...structuredClone(f.project.environments.dev),
    environment: "prod",
    bindings: { unsafe: { password: "synthetic-forbidden-value" } },
  };
  f.put("project.yaml", f.project);
  const form = readConnectionEditor(f.root, "dev", { package: "source" });
  assert.throws(
    () =>
      reviewConnectionEditor(f.root, "dev", {
        package: "source",
        id: "new_source",
        sourceId: "warehouse",
        tenantId: "nz",
        revision: form.revision,
        values: Object.fromEntries(
          form.fields.map((field) => [
            field.id,
            field.type === "secret"
              ? "WAREHOUSE_PASSWORD"
              : "warehouse.invalid",
          ]),
        ),
      }),
    /runtime.*secret reference/,
  );
});

test("discriminated authentication fields switch without retaining the former credential", (t) => {
  const obj = (properties: any) => ({
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  const schema = obj({
    authentication: {
      oneOf: [
        obj({
          method: { type: "string", enum: ["password"] },
          password: obj({ $secret: obj({ env: { type: "string" } }) }),
        }),
        obj({
          method: { type: "string", enum: ["identity"] },
          client: { type: "string" },
        }),
      ],
    },
  });
  const f = setup(t, false, {
    definition: {
      settingsSchema: schema,
      selectionSchema: { type: "object", additionalProperties: true },
    },
  });
  f.project.connections = {};
  f.project.environments.dev.bindings = {};
  f.put("project.yaml", f.project);
  let form = readConnectionEditor(f.root, "dev", { package: "source" });
  const method = form.fields.find((f) => f.label.endsWith("method"))!;
  const password = form.fields.find((f) => f.type === "secret")!;
  const client = form.fields.find((f) => f.label.endsWith("client"))!;
  assert.deepEqual(method.choices, ["password", "identity"]);
  assert.deepEqual(password.when, [{ field: method.id, equals: "password" }]);
  const intent = {
    package: "source",
    id: "new_source",
    sourceId: "source",
    tenantId: "local",
  };
  apply(
    f.root,
    reviewConnectionEditor(f.root, "dev", {
      ...intent,
      revision: form.revision,
      values: { [method.id]: "password", [password.id]: "AUTH_PASSWORD" },
    }),
  );
  form = readConnectionEditor(f.root, "dev", {
    package: "source",
    connection: "new_source",
  });
  apply(
    f.root,
    reviewConnectionEditor(f.root, "dev", {
      ...intent,
      connection: "new_source",
      revision: form.revision,
      values: { [method.id]: "identity", [client.id]: "identity-client" },
    }),
  );
  const file = readFileSync(resolve(f.root, "project.yaml"), "utf8");
  assert.equal(file.includes("AUTH_PASSWORD"), false);
  assert.equal(file.includes("identity-client"), true);
});

test("connector lifecycle reinstalls exact locks, blocks used removal, upgrades aliases and removes unused versions", (t) => {
  const f = setup(t);
  f.run();
  const ctx = { root: f.root, environment: "dev", allowNetwork: true },
    write = { ...ctx, allowWrite: true };
  const ok = (r: any) => {
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    return r.result;
  };
  const ref = "example/source/connector.yaml@1.0.0";
  writeFileSync(resolve(f.root, "customer-data.csv"), "preserve me\n");
  const library = ok(execute(ctx, "connector_library", {}));
  const installed = library.packages.find((p: any) => p.kind === "connector");
  assert.ok(installed.usedBy.length > 0);
  assert.equal(
    execute(ctx, "connector_change_review", {
      action: "remove",
      reference: ref,
    }).diagnostics[0].code,
    "IN_USE",
  );
  const reinstall = ok(
    execute(ctx, "connector_change_review", {
      action: "reinstall",
      reference: ref,
      fromGit: f.origin,
    }),
  );
  assert.equal(
    execute(ctx, "connector_change_apply", {
      proposal: reinstall.proposal,
      fromGit: f.origin,
    }).diagnostics[0].code,
    "PERMISSION",
  );
  ok(
    execute(write, "connector_change_apply", {
      proposal: reinstall.proposal,
      fromGit: f.origin,
    }),
  );
  const manifest = parse(
    readFileSync(resolve(f.origin, "connector.yaml"), "utf8"),
  );
  manifest.version = "1.1.0";
  writeFileSync(resolve(f.origin, "connector.yaml"), stringify(manifest));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: f.origin, stdio: "pipe" });
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "upgrade",
  );
  git("tag", "1.1.0");
  const upgrade = ok(
    execute(ctx, "connector_change_review", {
      action: "upgrade",
      reference: "example/source/connector.yaml@1.1.0",
      registration: installed.registrations[0],
      fromGit: f.origin,
    }),
  );
  assert.ok(upgrade.usedBy.includes("sales"));
  const saved = ok(
    execute(write, "connector_change_apply", {
      proposal: upgrade.proposal,
      fromGit: f.origin,
    }),
  );
  assert.equal(saved.registration, installed.registrations[0]);
  assert.equal(
    execute(ctx, "connector_change_review", {
      action: "upgrade",
      reference: ref,
      registration: saved.registration,
      fromGit: f.origin,
    }).diagnostics[0].code,
    "PACKAGE",
  );
  manifest.version = "1.2.0";
  manifest.definition.settingsSchema.required.push("new_required_setting");
  manifest.definition.settingsSchema.properties.new_required_setting = {
    type: "string",
  };
  writeFileSync(resolve(f.origin, "connector.yaml"), stringify(manifest));
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "incompatible upgrade",
  );
  git("tag", "1.2.0");
  assert.equal(
    execute(ctx, "connector_change_review", {
      action: "upgrade",
      reference: "example/source/connector.yaml@1.2.0",
      registration: saved.registration,
      fromGit: f.origin,
    }).diagnostics[0].code,
    "CONNECTION",
  );

  const removal = ok(
    execute(ctx, "connector_change_review", {
      action: "remove",
      reference: ref,
    }),
  );
  ok(execute(write, "connector_change_apply", { proposal: removal.proposal }));
  assert.ok(
    !ok(execute(ctx, "connector_library", {})).packages.some(
      (p: any) => p.reference === ref,
    ),
  );
  assert.equal(
    execute(write, "connector_change_apply", { proposal: removal.proposal })
      .diagnostics[0].code,
    "STALE",
  );
  const install = ok(
    execute(ctx, "connector_change_review", {
      action: "install",
      reference: ref,
      fromGit: f.origin,
    }),
  );
  ok(
    execute(write, "connector_change_apply", {
      proposal: install.proposal,
      fromGit: f.origin,
    }),
  );
  const unused = ok(
    execute(ctx, "connector_change_review", {
      action: "remove",
      reference: ref,
    }),
  );
  assert.ok(unused.files.some((f: any) => f.path === "project.yaml"));
  ok(execute(write, "connector_change_apply", { proposal: unused.proposal }));
  assert.equal(
    readFileSync(resolve(f.root, "customer-data.csv"), "utf8"),
    "preserve me\n",
  );
  const final = parse(readFileSync(resolve(f.root, "project.yaml"), "utf8"));
  assert.equal(final.connections.sales.package, "source");
});

test("connector lifecycle review never returns inline connection secrets", (t) => {
  const f = setup(t);
  f.run();
  const project = parse(readFileSync(resolve(f.root, "project.yaml"), "utf8"));
  project.connections.sales.settings.password = "synthetic-inline-value";
  writeFileSync(resolve(f.root, "project.yaml"), stringify(project));
  const result = execute(
    { root: f.root, allowNetwork: true },
    "connector_change_review",
    {
      action: "reinstall",
      reference: "example/source/connector.yaml@1.0.0",
      fromGit: f.origin,
    },
  );
  assert.equal(result.diagnostics[0].code, "SECRET");
  assert.equal(
    JSON.stringify(result).includes("synthetic-inline-value"),
    false,
  );
});

test("controlled upgrade fences portable consumers across environments, preserves exact bytes and reconciles partial installation", (t) => {
  const f = setup(t);
  f.run();
  const ctx = {
    root: f.root,
    environment: "dev",
    allowNetwork: true,
    allowWrite: true,
  };
  const ok = (r: any) => {
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    return r.result;
  };
  const manifest = parse(
    readFileSync(resolve(f.origin, "connector.yaml"), "utf8"),
  );
  manifest.version = "1.1.0";
  writeFileSync(resolve(f.origin, "connector.yaml"), stringify(manifest));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: f.origin, stdio: "pipe" });
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "candidate",
  );
  git("tag", "1.1.0");
  const definition = {
    apiVersion: "ingestron.ingestion-definition/v1",
    id: "retail",
    name: "Retail",
    status: "draft",
    source: {
      id: "sales",
      connector: { id: "example/source/connector.yaml", version: "1.0.0" },
    },
    objects: Array.from({ length: 480 }, (_, i) => ({
      id: `table_${i}`,
      kind: "table",
      fields: [],
      mapping: [],
      quality: [{ engine: "custom", keep: true }],
      governance: { owner: "Data team", masking: [] },
      metadata: [],
    })),
  };
  for (const folder of [
    "ingestions",
    "ingestion-drafts/test",
    "discovery/dev/sales",
  ])
    mkdirSync(resolve(f.root, folder), { recursive: true });
  const preserved: Record<string, string> = {
    "ingestions/retail.yaml": stringify(definition),
    "ingestion-drafts/test/retail.yaml": stringify({
      apiVersion: "ingestron.ingestion-draft/v1",
      definition,
    }),
    "discovery/dev/sales/old.yaml": stringify({
      snapshot: {
        id: "old",
        source: "sales",
        environment: "dev",
        connector: definition.source.connector,
      },
    }),
  };
  for (const [file, raw] of Object.entries(preserved))
    writeFileSync(resolve(f.root, file), raw);
  const request = {
    action: "upgrade",
    reference: "example/source/connector.yaml@1.1.0",
    registration: "source",
    fromGit: f.origin,
  };
  const review = () => ok(execute(ctx, "connector_change_review", request));
  const initial = review();
  assert(
    initial.impact.consumers.some(
      (c: any) => c.kind === "Working copy" && c.environment === "test",
    ),
  );
  assert(
    initial.impact.consumers.some(
      (c: any) => c.kind === "Ingestion definition",
    ),
  );
  assert(
    initial.impact.consumers.some((c: any) => c.kind === "Source settings"),
  );
  assert(initial.files.some((c: any) => c.path === "packages.lock.yaml"));
  const before = readFileSync(resolve(f.root, "project.yaml"), "utf8");
  const apply = (r: any) =>
    execute(ctx, "connector_change_apply", {
      proposal: r.proposal,
      fromGit: f.origin,
    });
  // Cancellation is read-only; any changed, new or removed consumer invalidates review.
  assert.equal(readFileSync(resolve(f.root, "project.yaml"), "utf8"), before);
  writeFileSync(
    resolve(f.root, "ingestion-drafts/test/retail.yaml"),
    preserved["ingestion-drafts/test/retail.yaml"] + "\n# concurrent edit\n",
  );
  assert.equal(apply(initial).diagnostics[0].code, "STALE");
  writeFileSync(
    resolve(f.root, "ingestion-drafts/test/retail.yaml"),
    preserved["ingestion-drafts/test/retail.yaml"],
  );
  const second = review();
  writeFileSync(resolve(f.root, ".ingestron-write.lock"), "another author");
  const partial = ok(apply(second));
  assert.equal(partial.outcome, "installed-not-applied");
  assert.equal(partial.changed, false);
  assert.equal(readFileSync(resolve(f.root, "project.yaml"), "utf8"), before);
  for (const [file, raw] of Object.entries(preserved))
    assert.equal(readFileSync(resolve(f.root, file), "utf8"), raw);
  // The other writer owns the guard, and the candidate remains installed for reconciliation.
  assert.equal(
    readFileSync(resolve(f.root, ".ingestron-write.lock"), "utf8"),
    "another author",
  );
  rmSync(resolve(f.root, ".ingestron-write.lock"));
  const resumed = review();
  assert.equal(resumed.impact.candidateInstalled, true);
  assert.equal(ok(apply(resumed)).changed, true);
  for (const [file, raw] of Object.entries(preserved))
    assert.equal(readFileSync(resolve(f.root, file), "utf8"), raw);
  for (const file of resumed.files)
    assert.equal(readFileSync(resolve(f.root, file.path), "utf8"), file.after);
  assert.equal(
    execute(ctx, "connector_change_review", {
      action: "remove",
      reference: "example/source/connector.yaml@1.0.0",
    }).diagnostics[0].code,
    "IN_USE",
  );
  // Manifest-ID aliases are also valid pins and must not bypass removal protection.
  for (const [file, raw] of Object.entries(preserved))
    writeFileSync(
      resolve(f.root, file),
      raw.replaceAll("example/source/connector.yaml", "synthetic"),
    );
  assert.equal(
    execute(ctx, "connector_change_review", {
      action: "remove",
      reference: "example/source/connector.yaml@1.0.0",
    }).diagnostics[0].code,
    "IN_USE",
  );
});

test("environment secret authoring keeps values out of proposals and preserves other environment references", (t) => {
  const f = setup(t);
  f.project.environments.test = {
    ...structuredClone(f.project.environments.dev),
    environment: "test",
  };
  f.project.connections.sales.settings = {
    host: "synthetic.invalid",
    password: { $secret: { env: "ORIGINAL_SECRET" } },
  };
  delete f.project.connections.sales.binding;
  f.put("environments/dev.yaml", f.project.environments.dev);
  f.put("environments/test.yaml", f.project.environments.test);
  f.project.environments = {
    dev: { $resolve: "./environments/dev.yaml" },
    test: { $resolve: "./environments/test.yaml" },
  };
  f.put("project.yaml", f.project);
  const request = () => {
    const form = readConnectionEditor(f.root, "dev", {
      package: "source",
      connection: "sales",
    });
    const field = form.fields.find((f) => f.type === "secret")!;
    return {
      package: "source",
      connection: "sales",
      id: "sales",
      sourceId: form.sourceId,
      tenantId: form.tenantId,
      revision: form.revision,
      environmentSecrets: true,
      values: { [field.id]: "DEV_SECRET" },
    };
  };
  const proposal = reviewConnectionEditor(f.root, "dev", request());
  assert.ok(
    proposal.changes.some(
      (c) =>
        c.path === "environments/dev.yaml" && c.after.includes("DEV_SECRET"),
    ),
  );
  apply(f.root, proposal);
  assert.equal(
    readConnectionEditor(f.root, "dev", {
      package: "source",
      connection: "sales",
    }).fields.find((f) => f.type === "secret")!.value,
    "DEV_SECRET",
  );
  assert.equal(
    readConnectionEditor(f.root, "test", {
      package: "source",
      connection: "sales",
    }).fields.find((f) => f.type === "secret")!.value,
    "ORIGINAL_SECRET",
  );
  const sibling = readFileSync(
    resolve(f.root, "environments/test.yaml"),
    "utf8",
  );
  const changed = request();
  changed.values[Object.keys(changed.values)[0]] = "ROTATED_SECRET";
  apply(f.root, reviewConnectionEditor(f.root, "dev", changed));
  assert.equal(
    readFileSync(resolve(f.root, "environments/test.yaml"), "utf8"),
    sibling,
  );
  assert.equal(
    readConnectionEditor(f.root, "dev", {
      package: "source",
      connection: "sales",
    }).fields.find((f) => f.type === "secret")!.value,
    "ROTATED_SECRET",
  );
});
