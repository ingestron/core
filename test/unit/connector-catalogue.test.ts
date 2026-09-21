import { test } from "node:test";
import assert from "node:assert/strict";
import {
  upstreamCatalogue,
  browseProviders,
  pluginDetails,
} from "../../src/core/provider-catalogue.js";
import { execute } from "../../src/core/operations.js";
test("imported catalogue has unique source variants, provenance and no automatic execution rights", () => {
  const catalogue = upstreamCatalogue();
  assert.match(catalogue.commit, /^[a-f0-9]{40}$/);
  assert.equal(catalogue.licence, "Apache-2.0");
  assert.equal(catalogue.entries.length, 1048);
  assert.equal(new Set(catalogue.entries.map((p: any) => p.id)).size, 1048);
  assert.equal(new Set(catalogue.entries.map((p: any) => p.source)).size, 630);
  for (const p of catalogue.entries) {
    assert.match(p.provenance.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Array.isArray(p.settings));
  }
  const connectors = browseProviders("", "connector");
  assert.equal(connectors.length, 1049);
  assert.deepEqual(
    connectors.filter((p) => p.installable).map((p) => p.id),
    ["faker", "postgres", "github"],
  );
  assert.deepEqual(
    browseProviders("", "connector", { engine: "databricks" }).map((p) => p.id),
    ["faker", "postgres", "github"],
  );
  assert.deepEqual(
    browseProviders("", "connector", { engine: "local" }).map((p) => p.id),
    ["faker", "postgres", "github"],
  );
  assert.equal(
    browseProviders("", "connector", { installable: true }).length,
    3,
  );
  assert.throws(
    () => browseProviders("", "connector", { engine: "unsupported" }),
    /Unknown connector engine/,
  );
  const detail = pluginDetails("postgres");
  assert.equal(detail.upstream.variant, "meltanolabs");
  assert.equal(detail.licence, "Elastic-2.0");
  assert.deepEqual(
    execute({ root: "/missing", allowNetwork: false }, "plugin_show", {
      id: "postgres",
    }).result,
    detail,
  );
});
