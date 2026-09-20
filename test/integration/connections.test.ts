import { digest } from "../../src/core/errors.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { stringify, parse } from "yaml";
import { fixture } from "../support/project.js";
import { installPackage } from "../../src/core/packages.js";
import { execute } from "../../src/core/operations.js";
function setup(t: any) {
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
        requiredFeatures: ["connector-runtime-capabilities"],
      },
      connectorRuntimes: {
        "ingestron.snapshot/python/v1": {
          selectionSchema: { type: "object", additionalProperties: true },
          executionSchema: object({
            mode: { type: "string", enum: ["local"] },
          }),
          prepareCommand: "connection prepare",
          executionPlatforms: ["test"],
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
    },
    definition: {
      settingsSchema: object({
        host: text,
        password: object({ $secret: object({ env: text }) }),
      }),
      selectionSchema: { type: "object", additionalProperties: true },
    },
    execution: { test: { modes: ["local"], evidence: "synthetic" } },
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
          source: { stream: "orders" },
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
  return { ...f, run };
}
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
