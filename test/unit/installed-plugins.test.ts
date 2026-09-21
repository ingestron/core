import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { fixture } from "../support/project.js";
import {
  browseProviders,
  pluginDetails,
} from "../../src/core/installed-plugins.js";
import {
  resolvePackage,
  canonicalPackageReference,
} from "../../src/core/packages.js";
import { execute, operationSchemas } from "../../src/core/operations.js";

test("discovery reports only locked installed plugins, never a bundled marketplace", (t) => {
  const f = fixture(t);
  assert.deepEqual(browseProviders("/missing-project"), []);
  const entries = browseProviders(f.root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "fixture");
  assert.equal(entries[0].availability, "installed");
  assert.equal(entries[0].installable, false);
  assert.deepEqual(browseProviders(f.root, "", "connector"), []);
  assert.deepEqual(
    browseProviders(f.root, "", undefined, { engine: "another-engine" }),
    [],
  );
  assert.throws(() => browseProviders(f.root, "", "typo"), /category/);
  assert.deepEqual(
    execute({ root: f.root }, "plugin_show", { id: "fixture" }).result,
    pluginDetails(f.root, "fixture"),
  );
  assert.equal(
    execute({ root: f.root }, "plugin_show", { id: "uninstalled" }).ok,
    false,
  );
  writeFileSync(resolvePackage(f.root, entries[0].reference).file, "tampered");
  assert.throws(() => browseProviders(f.root), /integrity/);
});

test("unimplemented roadmap operations and AI arguments are not advertised", () => {
  assert.equal(Object.hasOwn(operationSchemas, "unavailable"), false);
  for (const field of ["assist", "requirements", "sample"])
    assert.equal(
      operationSchemas.contract_create.safeParse({
        id: "sample",
        metadata: "metadata.json",
        [field]: field === "assist" ? true : "input.txt",
      }).success,
      false,
    );
  assert.equal(
    execute({ root: "/missing" }, "unavailable" as any).diagnostics[0].code,
    "OPERATION",
  );
  assert.throws(() => canonicalPackageReference("adf@1.0.0"), /explicit owner/);
});

test("provider metadata is extensible without claiming unimplemented source transports", async () => {
  const { externalActivitySchema } = await import("../../src/core/packages.js");
  const { connectorPackageSchema } =
    await import("../../src/core/connector-package.js");
  const { deliveryIndexSchema } = await import("../../src/core/deliveries.js");
  const { sourceSchema } = await import("../../src/core/workflows.js");
  assert.equal(
    externalActivitySchema.parse({
      apiVersion: "ingestron.activity/v1",
      id: "extract",
      version: "1.0.0",
      description: "Synthetic activity",
      platform: "example",
      input: "source",
      output: "files",
      effect: "read",
      optionsSchema: {},
      generator: { kind: "native-project", execution: "custom-runtime" },
    }).generator?.execution,
    "custom-runtime",
  );
  const connector = {
    apiVersion: "ingestron.connector/v1",
    id: "example",
    version: "1.0.0",
    description: "Synthetic connector",
    connector: "example:source@1.0.0",
    documentation: "https://example.com/docs",
    upstream: {
      ecosystem: "custom",
      variant: "source",
      package: "source",
      version: "1.0.0",
      repository: "https://example.com/source",
      licence: "Apache-2.0",
      licenceFile: "LICENSE",
      licenceStatus: "evidenced",
    },
    runtime: {
      contract: "example/v1",
      path: "runtime",
      sha256: "0".repeat(64),
    },
    definition: { settingsSchema: {}, selectionSchema: {} },
    execution: {
      example: { modes: ["custom-runtime"], evidence: "synthetic" },
    },
  };
  assert.equal(connectorPackageSchema.safeParse(connector).success, true);
  const delivery = (path: string) => ({
    apiVersion: "ingestron.delivery-index/v1",
    dataset: "catalog.schema.table",
    deliveries: [
      {
        id: "one",
        version: 1,
        capturedAt: "2026-09-21T00:00:00Z",
        contractVersion: "1.0.0",
        complete: true,
        scope: "full-table",
        rowCount: 0,
        path,
      },
    ],
  });
  for (const path of [
    "s3://bucket/key",
    "gs://bucket/key",
    "/tmp/example",
    "abfss://container/path",
    "/Volumes/catalog/schema/volume",
  ])
    assert.equal(deliveryIndexSchema.safeParse(delivery(path)).success, true);
  for (const path of ["", "bad\0path", "x".repeat(4097)])
    assert.equal(deliveryIndexSchema.safeParse(delivery(path)).success, false);
  for (const execution of ["adf", "runner"])
    assert.equal(
      sourceSchema.safeParse({
        id: "example",
        type: "sql",
        execution,
        apiVersion: "ingestron.source/v1",
      }).success,
      false,
    );
});
