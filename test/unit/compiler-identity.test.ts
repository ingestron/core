import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, executeAsync } from "../../src/core/operations.js";
import {
  compilerIdentity,
  buildCompilerCurrent,
} from "../../src/core/compiler-identity.js";

test("compiler identity validates the installed compiler independently of project/execution permissions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "core-compiler-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const expected = compilerIdentity();
  assert.equal(expected.apiVersion, "ingestron.compiler-identity/v1");
  assert.match(expected.digest, /^[a-f0-9]{64}$/);
  for (const dispatch of [execute, executeAsync]) {
    const result = await dispatch({ root }, "compiler_identity", {});
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, expected);
    assert.equal(
      (await dispatch({ root }, "compiler_identity", { from: "private" })).ok,
      false,
    );
  }
  assert.deepEqual(readdirSync(root), []);
  const build = {
    compilerVersion: expected.version,
    compilerDigest: expected.digest,
  };
  assert.equal(buildCompilerCurrent(build), true);
  assert.equal(
    buildCompilerCurrent({ ...build, compilerVersion: "0.0.0" }),
    false,
  );
  assert.equal(
    buildCompilerCurrent({ ...build, compilerDigest: "0".repeat(64) }),
    false,
  );
  assert.throws(
    () => buildCompilerCurrent({}),
    /no supported compiler identity/,
  );
});
