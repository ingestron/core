import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  statSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, executeAsync } from "../../src/core/operations.js";
import { writeOutput } from "../../src/core/generate.js";
import { digest } from "../../src/core/errors.js";
import { prepareBuildExecution } from "../../src/core/build-access.js";
import { validateRetainedBuild } from "../../src/core/build-retention.js";

function fixture(t: any, ownership: "managed" | "team" = "managed") {
  const root = mkdtempSync(join(tmpdir(), "build-retention-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "project.yaml"), "id: synthetic\n");
  writeFileSync(join(root, "packages.lock.yaml"), "packages: {}\n");
  const selection = { profile: "local" } as any;
  const build = {
    apiVersion: "ingestron.project-build/v1",
    project: "synthetic",
    environment: "dev",
    selection,
    sourceFiles: {
      "project.yaml": digest(readFileSync(join(root, "project.yaml"))),
    },
    packageLockSha256: digest(readFileSync(join(root, "packages.lock.yaml"))),
    compilerVersion: "0.0.1",
    compilerDigest: "a".repeat(64),
  };
  const source = join(root, "build/current");
  writeOutput(
    source,
    {
      project: "synthetic",
      environment: "dev",
      selection,
      digest: "b".repeat(64),
    },
    {
      "ingestron-project.json": JSON.stringify(build),
      "runtime.py": "print('synthetic')\n",
    },
    ownership,
  );
  mkdirSync(join(source, "flows/orders"), { recursive: true });
  writeFileSync(
    join(source, "flows/orders/review.json"),
    '{"approved":true}\n',
  );
  mkdirSync(join(source, "data/orders"), { recursive: true });
  writeFileSync(
    join(source, "data/orders/part.parquet"),
    Buffer.from([0, 1, 2, 255]),
  );
  const args = {
    from: "build/current",
    to: "build/previous",
    profile: "local",
  };
  return { root, source, args, target: join(root, args.to) };
}
test("sync and async retention preserve historical managed build, opaque reviews and binary output with a bounded private receipt", async (t) => {
  for (const dispatch of [execute, executeAsync]) {
    const f = fixture(t);
    const result = await dispatch(
      { root: f.root, allowWrite: true },
      "build_retain",
      f.args,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    const retained = result.result;
    assert.equal(retained.apiVersion, "ingestron.retained-build/v1");
    assert.equal(retained.files, 5);
    assert.equal(validateRetainedBuild(f.target), retained.contentDigest);
    const execution = await executeAsync(
      {
        root: f.root,
        allowWrite: true,
        allowExecute: true,
        allowNetwork: true,
      },
      "runtime_prepare",
      { from: f.args.to, flow: "orders", profile: "local" },
    );
    assert.equal(execution.ok, false);
    assert.equal(execution.diagnostics[0].code, "OWNER");
    assert.equal(validateRetainedBuild(f.target), retained.contentDigest);
    for (const path of [
      "runtime.py",
      "flows/orders/review.json",
      "data/orders/part.parquet",
    ])
      assert.deepEqual(
        readFileSync(join(f.source, path)),
        readFileSync(join(f.target, path)),
      );
    assert.equal(statSync(f.target).mode & 0o077, 0);
    assert.equal(
      statSync(join(f.target, "flows/orders/review.json")).mode & 0o077,
      0,
    );
    assert.doesNotMatch(
      JSON.stringify(retained),
      /approved|part.parquet|print/,
    );
    assert.ok(!readdirSync(f.target).includes(".ingestron-generate.lock"));
    assert.throws(
      () =>
        writeOutput(
          f.target,
          {
            project: "synthetic",
            environment: "dev",
            selection: { profile: "local" } as any,
            digest: "b".repeat(64),
          },
          {},
        ),
      (error: any) => error.code === "OWNER",
    );
    writeFileSync(
      join(f.target, "flows/orders/review.json"),
      '{"approved":false}\n',
    );
    assert.throws(
      () => validateRetainedBuild(f.target),
      (error: any) => error.code === "STALE",
    );
  }
});
test("retention requires write authority and rejects unknown credential or execution options before mutation", (t) => {
  const f = fixture(t),
    before = readdirSync(f.source);
  assert.equal(
    execute({ root: f.root }, "build_retain", f.args).diagnostics[0].code,
    "PERMISSION",
  );
  for (const extra of [
    { envFile: "private.env" },
    { provider: "foreign" },
    { allowNetwork: true },
  ])
    assert.equal(
      execute({ root: f.root, allowWrite: true }, "build_retain", {
        ...f.args,
        ...extra,
      }).diagnostics[0].code,
      "SCHEMA",
    );
  assert.deepEqual(readdirSync(f.source), before);
  assert.ok(!readdirSync(join(f.root, "build")).includes("previous"));
});
test("retention rejects active and uncertain ownership while retaining exact execution state", async (t) => {
  const f = fixture(t);
  const lease = prepareBuildExecution(f.source, "original", "none", () => ({
    flows: ["orders"],
    fingerprint: "c".repeat(64),
  }));
  const file = join(f.source, ".ingestron-execution/original.json");
  for (const phase of ["active", "uncertain"]) {
    if (phase === "uncertain") await lease.access.finish(false, true);
    const before = readFileSync(file);
    assert.equal(
      execute({ root: f.root, allowWrite: true }, "build_retain", f.args)
        .diagnostics[0].code,
      "EXECUTION_ACTIVE",
    );
    assert.deepEqual(readFileSync(file), before);
  }
});
test("retention refuses changed project, lock, profile and generated ownership", (t) => {
  for (const change of ["project", "lock", "profile", "generated", "team"]) {
    const f = fixture(t, change === "team" ? "team" : "managed");
    if (change === "project")
      writeFileSync(join(f.root, "project.yaml"), "id: changed\n");
    if (change === "lock")
      writeFileSync(join(f.root, "packages.lock.yaml"), "changed\n");
    if (change === "profile") f.args.profile = "foreign";
    if (change === "generated")
      writeFileSync(join(f.source, "runtime.py"), "print('changed')\n");
    assert.equal(
      execute({ root: f.root, allowWrite: true }, "build_retain", f.args).ok,
      false,
      change,
    );
    assert.ok(!readdirSync(join(f.root, "build")).includes("previous"));
  }
});
test("retention rejects nested/traversing/existing destinations and source or destination symlinks", (t) => {
  const f = fixture(t);
  mkdirSync(f.target);
  writeFileSync(join(f.target, "keep.txt"), "keep");
  symlinkSync("missing", join(f.root, "dangling"));
  for (const to of [
    "../outside",
    "build/current",
    "build/current/child",
    "build",
    "build/previous",
    "dangling",
  ])
    assert.equal(
      execute({ root: f.root, allowWrite: true }, "build_retain", {
        ...f.args,
        to,
      }).ok,
      false,
      to,
    );
  assert.equal(readFileSync(join(f.target, "keep.txt"), "utf8"), "keep");
  symlinkSync("missing", join(f.source, "bad.json"));
  assert.equal(
    execute({ root: f.root, allowWrite: true }, "build_retain", {
      ...f.args,
      to: "build/other",
    }).ok,
    false,
  );
});
test("retention bounds large binary output before copying and validates receipt integrity", (t) => {
  const f = fixture(t);
  truncateSync(
    join(f.source, "data/orders/part.parquet"),
    256 * 1024 * 1024 + 1,
  );
  assert.equal(
    execute({ root: f.root, allowWrite: true }, "build_retain", f.args)
      .diagnostics[0].code,
    "LIMIT",
  );
  truncateSync(join(f.source, "data/orders/part.parquet"), 4);
  const result = execute(
    { root: f.root, allowWrite: true },
    "build_retain",
    f.args,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const file = join(f.target, ".ingestron-retained-build.json"),
    value = JSON.parse(readFileSync(file, "utf8"));
  value.contentDigest = "0".repeat(64);
  writeFileSync(file, JSON.stringify(value));
  assert.throws(
    () => validateRetainedBuild(f.target),
    (error: any) => error.code === "STALE",
  );
});

test("sealed baseline inspection is read-only and survives later project and package changes", async (t) => {
  const f = fixture(t);
  const created = execute(
    { root: f.root, allowWrite: true },
    "build_retain",
    f.args,
  );
  assert.equal(created.ok, true);
  writeFileSync(join(f.root, "project.yaml"), "id: changed\n");
  writeFileSync(join(f.root, "packages.lock.yaml"), "changed\n");
  const before = readFileSync(join(f.target, ".ingestron-retained-build.json"));
  for (const dispatch of [execute, executeAsync]) {
    const inspected = await dispatch({ root: f.root }, "build_retained", {
      directory: f.args.to,
    });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    assert.equal(inspected.result.contentDigest, created.result.contentDigest);
    assert.equal(inspected.result.source, f.args.from);
    assert.equal(inspected.result.profile, "local");
    assert.equal(inspected.result.project, "synthetic");
    assert.doesNotMatch(
      JSON.stringify(inspected.result),
      /approved|part.parquet|print/,
    );
  }
  assert.deepEqual(
    readFileSync(join(f.target, ".ingestron-retained-build.json")),
    before,
  );
  assert.equal(
    execute({ root: f.root, environment: "foreign" }, "build_retained", {
      directory: f.args.to,
    }).ok,
    false,
  );
});
test("retained inspection rejects non-baselines, traversal, extra options and changed opaque output", (t) => {
  const f = fixture(t);
  for (const directory of [f.args.from, "../outside"])
    assert.equal(
      execute({ root: f.root }, "build_retained", { directory }).ok,
      false,
    );
  assert.equal(
    execute({ root: f.root }, "build_retained", {
      directory: f.args.to,
      envFile: "private.env",
    }).diagnostics[0].code,
    "SCHEMA",
  );
  assert.equal(
    execute({ root: f.root, allowWrite: true }, "build_retain", f.args).ok,
    true,
  );
  writeFileSync(
    join(f.target, "data/orders/part.parquet"),
    Buffer.from([0, 0, 0, 0]),
  );
  assert.equal(
    execute({ root: f.root }, "build_retained", { directory: f.args.to })
      .diagnostics[0].code,
    "STALE",
  );
});
