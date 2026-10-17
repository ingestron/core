import test from "node:test";
import assert from "node:assert/strict";
import { validateOperationAcknowledgement } from "../../src/core/execution-acknowledgement.js";
import { executionSchemas } from "../../src/core/execution.js";
import { checkProviderCompatibility } from "../../src/plugins/compatibility.js";
const original = {
  id: "9-original",
  action: "discover",
  flows: ["orders"],
  fingerprint: "a".repeat(64),
};
const response = (status = "succeeded") => ({
  acknowledgement: {
    apiVersion: "ingestron.execution-acknowledgement/v1",
    ...original,
    result: {
      apiVersion: "ingestron.execution-result/v1",
      status,
      action: original.action,
      flows:
        status === "succeeded" ? [{ flow: "orders", status: "Succeeded" }] : [],
    },
  },
});
test("durable metadata failure accepts only its code on a confirmed failure", () => {
  const failure: any = response("failed");
  failure.acknowledgement.result.errorCode = "SOURCE_METADATA_LIMIT";
  assert.equal(
    validateOperationAcknowledgement(failure, original).errorCode,
    "SOURCE_METADATA_LIMIT",
  );
  for (const change of [
    { status: "succeeded" },
    { errorCode: "PRIVATE_SOURCE_CODE" },
    { message: "SYNTHETIC_PRIVATE_SOURCE_DETAIL" },
  ]) {
    const changed = structuredClone(failure);
    Object.assign(changed.acknowledgement.result, change);
    assert.throws(
      () => validateOperationAcknowledgement(changed, original),
      (error: any) => error.code === "EXECUTION_UNCERTAIN",
    );
  }
});
test("setup acknowledgement accepts original success and confirmed failure without replay arguments", () => {
  assert.equal(
    validateOperationAcknowledgement(response(), original).status,
    "succeeded",
  );
  assert.equal(
    validateOperationAcknowledgement(response("failed"), original).status,
    "failed",
  );
  assert.deepEqual(
    executionSchemas.execution_recover.parse({ id: original.id }),
    { id: original.id },
  );
  for (const extra of [
    { flow: "other" },
    { action: "run" },
    { from: "elsewhere" },
    { profile: "foreign" },
    { runId: "new" },
  ])
    assert.equal(
      executionSchemas.execution_recover.safeParse({
        id: original.id,
        ...extra,
      }).success,
      false,
    );
});
test("collection failure survives acknowledgement only for its exact failed operation", () => {
  const failure: any = response("failed");
  failure.acknowledgement.result.errorCode = "SOURCE_METADATA_COLLECTION_LIMIT";
  assert.equal(
    validateOperationAcknowledgement(failure, original).errorCode,
    "SOURCE_METADATA_COLLECTION_LIMIT",
  );
  for (const change of [
    { status: "succeeded" },
    { errorCode: "SOURCE_METADATA_COLLECTION_LIMITED" },
    { message: "SYNTHETIC_PRIVATE_SOURCE_DETAIL" },
  ]) {
    const changed = structuredClone(failure);
    Object.assign(changed.acknowledgement.result, change);
    assert.throws(
      () => validateOperationAcknowledgement(changed, original),
      (error: any) => error.code === "EXECUTION_UNCERTAIN",
    );
  }
  assert.throws(
    () =>
      validateOperationAcknowledgement(failure, { ...original, id: "foreign" }),
    (error: any) => error.code === "EXECUTION_UNCERTAIN",
  );
});
test("missing, active, foreign and contradictory acknowledgement never prove original completion", () => {
  const changed = [undefined, {}, response("running"), response("interrupted")];
  for (const [field, value] of [
    ["id", "foreign"],
    ["action", "approve"],
    ["flows", ["other"]],
    ["fingerprint", "b".repeat(64)],
  ] as const) {
    const valueToChange = response();
    (valueToChange.acknowledgement as any)[field] = value;
    changed.push(valueToChange);
  }
  const differentResult = response();
  differentResult.acknowledgement.result.flows = [
    { flow: "other", status: "Succeeded" },
  ];
  changed.push(differentResult);
  for (const value of changed)
    assert.throws(
      () => validateOperationAcknowledgement(value, original),
      (error: any) => error.code === "EXECUTION_UNCERTAIN",
    );
});
test("durable acknowledgement capability requires its explicit host feature", () => {
  const provider = {
    execution: { acknowledgement: "provider-journal/v1" },
    compatibility: {
      minimumCli: "4.2.0",
      requiredFeatures: ["provider-execution"],
    },
  };
  assert.throws(
    () => checkProviderCompatibility(provider),
    (error: any) => error.code === "COMPATIBILITY",
  );
  provider.compatibility.requiredFeatures.push(
    "provider-execution-acknowledgement",
  );
  checkProviderCompatibility(provider);
});
