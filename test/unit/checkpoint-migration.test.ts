import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionSchemas } from "../../src/core/execution.js";
import { executeAsync } from "../../src/core/operations.js";
import { checkpointMigrationEvidence } from "../../src/core/checkpoint-migration.js";
import { checkProviderCompatibility } from "../../src/plugins/compatibility.js";
import { validateOperationAcknowledgement } from "../../src/core/execution-acknowledgement.js";

const migration = {
  apiVersion: "ingestron.checkpoint-migration-preview/v1",
  strategy: "preserve-cursor-runtime-upgrade",
  digest: "a".repeat(64),
  applied: false,
  namespace: "b".repeat(64),
  fromBinding: "c".repeat(64),
  toBinding: "d".repeat(64),
  policyDigest: "e".repeat(64),
  head: {
    sequence: 1,
    receiptSha256: "f".repeat(64),
    bookmarks: { orders: "9007199254740993" },
  },
};
const response = () => ({
  apiVersion: "ingestron.execution-result/v1",
  status: "succeeded",
  action: "checkpoint_preview",
  flows: [
    {
      flow: "orders",
      status: "Succeeded",
      migration: structuredClone(migration),
    },
  ],
});
test("checkpoint maintenance requires execution and write authority before touching project/build state", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-permissions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const operation of ["checkpoint_preview", "checkpoint_apply"] as const) {
    const input = {
      flow: "orders",
      from: "build/current",
      previous: "build/previous",
      ...(operation === "checkpoint_apply"
        ? { expectedDigest: migration.digest }
        : {}),
    };
    for (const permissions of [
      {},
      { allowWrite: true },
      { allowExecute: true },
    ]) {
      const result = await executeAsync(
        { root, ...permissions },
        operation,
        input,
      );
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics[0]?.code, "PERMISSION");
    }
    assert.equal(
      executionSchemas[operation].safeParse({
        ...input,
        envFile: "private.env",
      }).success,
      false,
    );
    assert.equal(
      executionSchemas[operation].safeParse({ ...input, provider: "another" })
        .success,
      false,
    );
  }
  assert.equal(
    executionSchemas.checkpoint_apply.safeParse({
      flow: "orders",
      previous: "build/previous",
      expectedDigest: "unknown",
    }).success,
    false,
  );
  assert.deepEqual(readdirSync(root), []);
});
test("bounded checkpoint evidence retains exact int64 cursors and rejects malformed acknowledged output as uncertain", () => {
  assert.deepEqual(
    checkpointMigrationEvidence(response(), "checkpoint_preview", ["orders"]),
    response(),
  );
  const applied = response();
  applied.action = "checkpoint_apply";
  applied.flows[0].migration.applied = true;
  assert.equal(
    checkpointMigrationEvidence(
      applied,
      "checkpoint_apply",
      ["orders"],
      migration.digest,
    ).flows[0].migration.applied,
    true,
  );
  const bad: any[] = [
    undefined,
    null,
    [],
    {},
    { ...response(), action: "run" },
  ];
  for (const change of [
    (v: any) =>
      (v.flows[0].migration.head.bookmarks.orders = "9223372036854775808"),
    (v: any) => (v.flows[0].migration.head.bookmarks.orders = 2),
    (v: any) => (v.flows[0].migration.applied = "true"),
    (v: any) => (v.flows[0].migration.toBinding = migration.fromBinding),
    (v: any) => (v.flows[0].migration.rows = [{ secret: "private" }]),
    (v: any) => (v.flows[0].tables = [{ rows: 2 }]),
    (v: any) => (v.rows = [{ secret: "private" }]),
    (v: any) => (v.credentials = { password: "private" }),
    (v: any) => (v.flows[0] = null),
    (v: any) => (v.flows[0] = []),
    (v: any) => (v.flows[0] = "invalid"),
    (v: any) => (v.flows[0].flow = "foreign"),
    (v: any) => v.flows.push(v.flows[0]),
  ]) {
    const value = response();
    change(value);
    bad.push(value);
  }
  for (const value of bad)
    assert.throws(
      () =>
        checkpointMigrationEvidence(value, "checkpoint_preview", ["orders"]),
      (error: any) => error.code === "EXECUTION_UNCERTAIN",
    );
  for (const flows of [[], ["orders", "another"], [""], null, [null]])
    assert.throws(
      () =>
        checkpointMigrationEvidence(
          response(),
          "checkpoint_preview",
          flows as any,
        ),
      (error: any) => error.code === "EXECUTION_UNCERTAIN",
    );
  const foreignAction = response();
  foreignAction.action = "run";
  assert.throws(
    () => checkpointMigrationEvidence(foreignAction, "run", ["orders"]),
    (error: any) => error.code === "EXECUTION_UNCERTAIN",
  );
  assert.throws(
    () =>
      checkpointMigrationEvidence(
        applied,
        "checkpoint_apply",
        ["orders"],
        "0".repeat(64),
      ),
    (error: any) => error.code === "EXECUTION_UNCERTAIN",
  );
});
test("preview acknowledges an already committed upgrade without claiming a new apply", () => {
  const existing = response();
  existing.flows[0].migration.applied = true;
  const inspected = checkpointMigrationEvidence(
    existing,
    "checkpoint_preview",
    ["orders"],
  );
  assert.equal(inspected.action, "checkpoint_preview");
  assert.equal(inspected.flows[0].migration.applied, true);
  assert.deepEqual(inspected.flows[0].migration.head, migration.head);
  const uncommitted = response();
  uncommitted.action = "checkpoint_apply";
  assert.throws(
    () =>
      checkpointMigrationEvidence(
        uncommitted,
        "checkpoint_apply",
        ["orders"],
        migration.digest,
      ),
    (error: any) => error.code === "EXECUTION_UNCERTAIN",
  );
});
test("checkpoint transport requires explicit host support and durable original-operation acknowledgement", () => {
  const manifest: any = {
    execution: { actions: ["checkpoint_apply"] },
    compatibility: {
      minimumCli: "4.2.0",
      requiredFeatures: ["provider-execution"],
    },
  };
  assert.throws(
    () => checkProviderCompatibility(manifest),
    (error: any) => error.code === "COMPATIBILITY",
  );
  manifest.compatibility.requiredFeatures.push(
    "source-checkpoint-migration",
    "provider-execution-acknowledgement",
  );
  manifest.execution.acknowledgement = "provider-journal/v1";
  checkProviderCompatibility(manifest);
  const original = {
    id: "migration-original",
    action: "checkpoint_apply",
    flows: ["orders"],
    fingerprint: "1".repeat(64),
  };
  const value = response();
  value.action = "checkpoint_apply";
  value.flows[0].migration.applied = true;
  const acknowledged = validateOperationAcknowledgement(
    {
      acknowledgement: {
        apiVersion: "ingestron.execution-acknowledgement/v1",
        ...original,
        result: value,
      },
    },
    original,
  );
  assert.equal(
    checkpointMigrationEvidence(
      acknowledged,
      original.action,
      original.flows,
      migration.digest,
    ).flows[0].migration.applied,
    true,
  );
});

test("checkpoint failure acknowledgement preserves only defined codes and rejects contradictory success", () => {
  const original = {
    id: "upgrade-failed",
    action: "checkpoint_apply",
    flows: ["orders"],
    fingerprint: "a".repeat(64),
  };
  const acknowledgement: any = {
    apiVersion: "ingestron.execution-acknowledgement/v1",
    ...original,
    result: {
      apiVersion: "ingestron.execution-result/v1",
      status: "failed",
      action: "checkpoint_apply",
      flows: [],
      errorCode: "CHECKPOINT_MIGRATION_STALE",
    },
  };
  assert.equal(
    validateOperationAcknowledgement({ acknowledgement }, original).errorCode,
    "CHECKPOINT_MIGRATION_STALE",
  );
  for (const extra of [
    { errorCode: "PRIVATE_SOURCE_VALUE" },
    { message: "PRIVATE_SOURCE_VALUE" },
    { status: "succeeded", flows: [{ flow: "orders" }] },
  ]) {
    const value = structuredClone(acknowledgement);
    Object.assign(value.result, extra);
    assert.throws(
      () =>
        validateOperationAcknowledgement({ acknowledgement: value }, original),
      (error: any) => error.code === "EXECUTION_UNCERTAIN",
    );
  }
});
