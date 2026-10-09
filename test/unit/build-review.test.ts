import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../support/project.js";
import { execute } from "../../src/core/operations.js";

function run(
  root: string,
  operation: string,
  args: unknown,
  write = false,
  environment = "dev",
) {
  return execute(
    { root, environment, allowWrite: write },
    operation as any,
    args,
  );
}
test("generation review is read-only and uses the direct build's exact output", (t) => {
  const f = fixture(t);
  const review = run(f.root, "build_review", {});
  assert.equal(review.ok, true, JSON.stringify(review));
  assert.equal(existsSync(join(f.root, "build")), false);
  assert.ok(Object.keys(review.result.files).length > 1);
  assert.equal(
    run(f.root, "build_apply", { proposal: review.result }).ok,
    false,
  );
  const applied = run(f.root, "build_apply", { proposal: review.result }, true);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const first = readFileSync(
    join(f.root, "build/generated/ingestron-manifest.json"),
    "utf8",
  );
  const direct = run(f.root, "build", {}, true);
  assert.equal(direct.ok, true, JSON.stringify(direct));
  assert.equal(
    readFileSync(
      join(f.root, "build/generated/ingestron-manifest.json"),
      "utf8",
    ),
    first,
  );
  assert.equal(
    run(f.root, "build_apply", { proposal: review.result }, true).diagnostics[0]
      .code,
    "STALE",
  );
  const repeat = run(f.root, "build_review", {});
  assert.equal(
    run(f.root, "build_apply", { proposal: repeat.result }, true).ok,
    true,
  );
});
test("generation rejects edited definitions, forged reviews, changed output and other roots", (t) => {
  const f = fixture(t),
    other = fixture(t);
  const review = run(f.root, "build_review", {}).result;
  const tampered = structuredClone(review);
  tampered.files[Object.keys(tampered.files)[0]] = "a".repeat(64);
  assert.equal(
    run(f.root, "build_apply", { proposal: tampered }, true).diagnostics[0]
      .code,
    "STALE",
  );
  assert.equal(
    run(other.root, "build_apply", { proposal: review }, true).diagnostics[0]
      .code,
    "STALE",
  );
  const projectPath = join(f.root, "project.yaml"),
    original = readFileSync(projectPath, "utf8");
  writeFileSync(projectPath, original + "\n# Changed after review\n");
  assert.equal(
    run(f.root, "build_apply", { proposal: review }, true).diagnostics[0].code,
    "STALE",
  );
  writeFileSync(projectPath, original);
  f.put("build/generated/unowned.txt", "User work");
  assert.equal(
    run(f.root, "build_apply", { proposal: review }, true).diagnostics[0].code,
    "STALE",
  );
  assert.equal(
    readFileSync(join(f.root, "build/generated/unowned.txt"), "utf8"),
    "User work",
  );
  assert.equal(
    existsSync(join(f.root, "build/generated/ingestron-project.json")),
    false,
  );
});
test("reviewed generation keeps existing ownership and symlink protections", (t) => {
  const f = fixture(t);
  assert.equal(run(f.root, "build", {}, true).ok, true);
  const manifest = JSON.parse(
    readFileSync(
      join(f.root, "build/generated/ingestron-manifest.json"),
      "utf8",
    ),
  );
  const file = Object.keys(manifest.files)[0];
  writeFileSync(join(f.root, "build/generated", file), "user edit");
  const review = run(f.root, "build_review", {});
  assert.equal(review.ok, false);
  assert.equal(review.diagnostics[0].code, "CONFLICT");
  assert.equal(
    readFileSync(join(f.root, "build/generated", file), "utf8"),
    "user edit",
  );
  symlinkSync(join(f.root, "flows"), join(f.root, "linked"));
  assert.equal(
    run(f.root, "build_review", { out: "linked/generated" }).ok,
    false,
  );
});
