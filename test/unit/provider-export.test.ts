import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fixture } from "../support/project.js";
import { execute } from "../../src/core/operations.js";
test("provider artifact export is a reviewed proposal and protects destinations", (t) => {
  const f = fixture(t),
    ctx = { root: f.root, allowWrite: true };
  const envelope = {
    apiVersion: "ingestron.provider-command-result/v1",
    execution: "offline-json",
    result: {
      apiVersion: "ingestron.artifact-proposal/v1",
      artifacts: { "metadata.sql": "SELECT 1;", "review.json": "{}" },
    },
  };
  f.put("result.json", JSON.stringify(envelope));
  const result = execute(ctx, "provider_export", {
    result: "result.json",
    out: "discovery",
  });
  assert.equal(result.ok, true);
  assert.equal(existsSync(resolve(f.root, "discovery/metadata.sql")), false);
  assert.equal(execute(ctx, "apply", { proposal: result.result }).ok, true);
  assert.equal(
    readFileSync(resolve(f.root, "discovery/metadata.sql"), "utf8"),
    "SELECT 1;",
  );
  assert.equal(
    execute(ctx, "provider_export", { result: "result.json", out: "discovery" })
      .ok,
    false,
  );
  for (const artifacts of [
    { "../escape.py": "pass" },
    { "broken.odcs.json": "{}" },
    { "bad.json": "not json" },
    { ".hidden.py": "pass" },
  ]) {
    f.put(
      "bad.json",
      JSON.stringify({
        ...envelope,
        result: { ...envelope.result, artifacts },
      }),
    );
    assert.equal(
      execute(ctx, "provider_export", { result: "bad.json", out: "other" }).ok,
      false,
    );
  }
});
