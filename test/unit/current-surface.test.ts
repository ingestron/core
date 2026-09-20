import { test } from "node:test";
import assert from "node:assert/strict";
import { projectSchema, stepSchema } from "../../src/core/schema.js";
import { externalActivitySchema } from "../../src/core/packages.js";

test("removed orchestration and platform options fail explicitly", () => {
  assert.equal(
    stepSchema.safeParse({
      id: "report",
      uses: "materialized-view@v1",
      barrier: "all-tables",
    }).success,
    false,
  );
  assert.equal(
    projectSchema.shape.defaults.safeParse({ naming: { pipeline: "ignored" } })
      .success,
    false,
  );
  const manifest = {
    apiVersion: "ingestron.activity/v1",
    id: "sample",
    version: "1.0.0",
    description: "Example",
    platform: "databricks",
    input: "relation",
    output: "relation",
    effect: "commit",
    optionsSchema: {},
  };
  assert.equal(externalActivitySchema.safeParse(manifest).success, true);
  assert.equal(
    externalActivitySchema.safeParse({
      ...manifest,
      services: { logger: { contract: "old/v1" } },
    }).success,
    false,
  );
  assert.equal(
    externalActivitySchema.safeParse({ ...manifest, platform: "bad platform!" })
      .success,
    false,
  );
});
