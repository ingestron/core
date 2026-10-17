import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  prepareBuildExecution,
  assertBuildIdle,
} from "../../src/core/build-access.js";
const boundary = () => ({
  flows: ["orders"],
  fingerprint: "a".repeat(64),
  resources: ["b".repeat(64)],
});
test("failed recovery cannot release inherited source uncertainty; successful original acknowledgement releases exact ownership", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "ingestron-residual-ownership-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = prepareBuildExecution(root, "original", "none", boundary);
  const recovered = prepareBuildExecution(
    root,
    "original",
    "finished",
    boundary,
  );
  await first.access.finish(false);
  await recovered.access.finish(false);
  assert.throws(
    () => assertBuildIdle(root),
    (error: any) => error.code === "EXECUTION_ACTIVE",
  );
  const lease = JSON.parse(
    readFileSync(resolve(root, ".ingestron-execution/original.json"), "utf8"),
  );
  assert.equal(lease.phase, "uncertain");
  assert.equal(lease.recoveryPending, true);
  assert.throws(
    () => prepareBuildExecution(root, "other", "none", boundary),
    (error: any) => error.code === "EXECUTION_ACTIVE",
  );
  const third = prepareBuildExecution(root, "original", "finished", boundary);
  await third.access.finish(false);
  assert.throws(
    () => assertBuildIdle(root),
    (error: any) => error.code === "EXECUTION_ACTIVE",
  );
  const acknowledgement = prepareBuildExecution(
    root,
    "original",
    "finished",
    boundary,
  );
  await recovered.access.finish(true);
  assert.throws(
    () => assertBuildIdle(root),
    (error: any) => error.code === "EXECUTION_ACTIVE",
  );
  await acknowledgement.access.finish(true);
  assertBuildIdle(root);
});
test("an initial known failure without inherited uncertainty still permits reviewed repair", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "ingestron-known-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = prepareBuildExecution(root, "known_failed", "none", boundary);
  await first.access.finish(false);
  assertBuildIdle(root);
  const next = prepareBuildExecution(root, "new_run", "none", boundary);
  await next.access.finish(true);
  assertBuildIdle(root);
});
