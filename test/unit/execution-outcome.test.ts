import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launch } from "../../src/core/execution.js";
import { ExecutionUncertainFailure } from "../../src/core/execution-outcome.js";
import {
  prepareBuildExecution,
  assertBuildIdle,
} from "../../src/core/build-access.js";

const result = (
  status: string,
  exit: number,
  apiVersion = "ingestron.execution-result/v1",
) =>
  `print(json.dumps({'apiVersion':${JSON.stringify(apiVersion)},'status':${JSON.stringify(status)}}))\nsys.exit(${exit})`;
for (const [name, body, code] of [
  ["unexpected EOF", "sys.exit(1)", "EXECUTION_UNCERTAIN"],
  ["invalid JSON", "print('private output')", "EXECUTION_UNCERTAIN"],
  [
    "foreign protocol",
    result("succeeded", 0, "foreign/v1"),
    "EXECUTION_UNCERTAIN",
  ],
  ["success with failed exit", result("succeeded", 1), "EXECUTION_UNCERTAIN"],
  ["failure with successful exit", result("failed", 0), "EXECUTION_UNCERTAIN"],
  ["interrupted acknowledgement", result("interrupted", 1), "INTERRUPTED"],
  [
    "process killed without acknowledgement",
    "import os,signal\nos.kill(os.getpid(),signal.SIGKILL)",
    "EXECUTION_UNCERTAIN",
  ],
]) {
  test(`${name} retains source uncertainty and permits same live caller recovery only after finalisation`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "core-uncertain-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const entry = join(root, "adapter.py");
    writeFileSync(
      entry,
      `import json,sys\njson.loads(sys.stdin.read())\n${body}\n`,
    );
    const boundary = () => ({ flows: ["orders"], fingerprint: "a".repeat(64) });
    const owned = prepareBuildExecution(root, "original", "none", boundary);
    await assert.rejects(
      launch("python3", entry, {}, root, { PATH: process.env.PATH }, (pid) =>
        owned.access.attachChild(pid),
      ),
      (error: any) => {
        assert.ok(error instanceof ExecutionUncertainFailure);
        assert.equal(error.code, code);
        assert.doesNotMatch(JSON.stringify(error), /private output/);
        return true;
      },
    );
    assert.throws(
      () => prepareBuildExecution(root, "original", "indeterminate", boundary),
      (e: any) => e.code === "EXECUTION_ACTIVE",
    );
    await owned.access.finish(false, true);
    assert.throws(
      () => assertBuildIdle(root),
      (e: any) => e.code === "EXECUTION_ACTIVE",
    );
    const lease = JSON.parse(
      readFileSync(join(root, ".ingestron-execution/original.json"), "utf8"),
    );
    assert.equal(lease.ownerFinished, true);
    assert.equal(lease.recoveryPending, true);
    const recovery = prepareBuildExecution(
      root,
      "original",
      "indeterminate",
      boundary,
    );
    await recovery.access.finish(false);
    assert.throws(
      () => assertBuildIdle(root),
      (e: any) => e.code === "EXECUTION_ACTIVE",
    );
    const acknowledgement = prepareBuildExecution(
      root,
      "original",
      "indeterminate",
      boundary,
    );
    await acknowledgement.access.finish(true);
    assertBuildIdle(root);
  });
}
test("acknowledged failure and failure before dispatch remain repairable", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "core-acknowledged-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "adapter.py");
  writeFileSync(
    entry,
    `import json,sys\njson.loads(sys.stdin.read())\n${result("failed", 1)}\n`,
  );
  for (const python of ["python3", join(root, "missing-python")]) {
    const owned = prepareBuildExecution(root, "known", "none", () => ({
      flows: ["orders"],
      fingerprint: "a".repeat(64),
    }));
    await assert.rejects(
      launch(python, entry, {}, root, { PATH: process.env.PATH }),
      (error: any) => {
        assert.equal(error.code, "RUNTIME");
        assert.ok(!(error instanceof ExecutionUncertainFailure));
        return true;
      },
    );
    await owned.access.finish(false);
    assertBuildIdle(root);
  }
});
