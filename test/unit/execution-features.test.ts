import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, executeAsync } from "../../src/core/operations.js";
import { executionSchemas } from "../../src/core/execution.js";

test("execution features are read-only host support even without valid project definitions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "core-execution-features-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const expected = {
    apiVersion: "ingestron.execution-features/v1",
    runtimePrepareRunId: true,
    compilerIdentity: true,
    executionEvidence: true,
    checkpointMigration: true,
    buildRetention: true,
    buildRetentionInspect: true,
  };
  for (const dispatch of [execute, executeAsync]) {
    const result = await dispatch({ root }, "execution_features", {});
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, expected);
    assert.equal(
      (await dispatch({ root }, "execution_features", { runId: "new" })).ok,
      false,
    );
  }
  assert.deepEqual(readdirSync(root), []);
  assert.deepEqual(
    executionSchemas.runtime_prepare.parse({
      flow: "orders",
      runId: "9-original",
    }),
    { flow: "orders", runId: "9-original" },
  );
  for (const runId of ["../private", "bad\nidentity", "a".repeat(101)])
    assert.equal(
      executionSchemas.runtime_prepare.safeParse({ runId }).success,
      false,
    );
});
