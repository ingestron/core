import * as requireFs from "node:fs";
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

test("saved assets survive reopening, distinguish changed inputs and remain readable with invalid definitions", (t) => {
  const f = fixture(t);
  const status = () => run(f.root, "build_status", {}).result;
  assert.equal(status().status, "not-generated");
  assert.equal(existsSync(join(f.root, "build")), false);
  assert.equal(run(f.root, "build", {}, true).ok, true);
  const first = status();
  assert.equal(first.status, "current");
  assert.deepEqual(status(), first);
  const path = first.files.find((file: any) => file.previewable).path;
  const content = run(f.root, "build_file", { path }).result.content;
  assert.equal(
    content,
    readFileSync(join(f.root, "build/generated", path), "utf8"),
  );
  const project = readFileSync(join(f.root, "project.yaml"), "utf8");
  f.put("project.yaml", project + "\n# Changed source\n");
  assert.equal(status().status, "outdated");
  f.put("project.yaml", "invalid: [");
  assert.equal(status().status, "unavailable");
  assert.deepEqual(status().files, first.files);
  assert.equal(run(f.root, "build_file", { path }).result.content, content);
  f.put("project.yaml", project);
  f.put("build/generated/" + path, "Manual change\n");
  assert.equal(status().status, "conflict");
  assert.equal(
    status().files.find((file: any) => file.path === path).state,
    "modified",
  );
  assert.equal(
    run(f.root, "build_file", { path }).result.content,
    "Manual change\n",
  );
});

test("saved file inspection rejects foreign environments, traversal, unowned files, oversized and symlink previews", (t) => {
  const f = fixture(t);
  assert.equal(run(f.root, "build", {}, true).ok, true);
  const status = run(f.root, "build_status", {}).result;
  const path = status.files.find((file: any) => file.previewable).path;
  for (const request of [
    { path: "../project.yaml" },
    { path: "/project.yaml" },
    { path: "x\\y" },
    { path: "unknown.txt" },
  ])
    assert.equal(run(f.root, "build_file", request).ok, false);
  assert.equal(run(f.root, "build_file", { path }, false, "test").ok, false);
  f.put("build/generated/unowned.txt", "User file");
  assert.equal(run(f.root, "build_file", { path: "unowned.txt" }).ok, false);
  f.put("build/generated/" + path, "x".repeat(256 * 1024 + 1));
  assert.equal(run(f.root, "build_file", { path }).ok, false);
  const { unlinkSync } = requireFs;
  unlinkSync(join(f.root, "build/generated", path));
  assert.equal(
    run(f.root, "build_status", {}).result.files.find(
      (file: any) => file.path === path,
    ).state,
    "missing",
  );
  assert.equal(run(f.root, "build_file", { path }).ok, false);
  symlinkSync(
    join(f.root, "project.yaml"),
    join(f.root, "build/generated", path),
  );
  assert.equal(run(f.root, "build_status", {}).result.status, "unavailable");
  assert.equal(run(f.root, "build_file", { path }).ok, false);
});
