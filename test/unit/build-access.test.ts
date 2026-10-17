import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  prepareBuildExecution,
  withBuildGuard,
  assertBuildIdle,
} from "../../src/core/build-access.js";
import { writeOutput } from "../../src/core/generate.js";
const fixture = () => mkdtempSync(resolve(tmpdir(), "ingestron-build-access-"));
const boundary = (flow = "orders") => ({
  flows: [flow],
  fingerprint: "a".repeat(64),
});
const claim = (
  root: string,
  id: string,
  recovery: "none" | "indeterminate" | "finished" = "none",
  flow = "orders",
) => prepareBuildExecution(root, id, recovery, () => boundary(flow));
const code = (expected: string) => (error: any) => error.code === expected;
const plan: any = {
  project: "retail",
  environment: "dev",
  selection: {},
  digest: "reviewed",
};

test("build and overlapping execution refuse active ownership; independent flows share read access", async () => {
  const root = fixture();
  writeOutput(root, plan, { "data.json": "{}" });
  const before = readFileSync(resolve(root, "ingestron-manifest.json"));
  const first = claim(root, "run_one");
  assert.throws(
    () => writeOutput(root, plan, { "data.json": '{"changed":true}' }),
    code("EXECUTION_ACTIVE"),
  );
  assert.deepEqual(
    readFileSync(resolve(root, "ingestron-manifest.json")),
    before,
  );
  assert.equal(readFileSync(resolve(root, "data.json"), "utf8"), "{}");
  assert.throws(() => claim(root, "run_two"), code("EXECUTION_ACTIVE"));
  const independent = claim(root, "run_two", "none", "customers");
  assert.equal(readdirSync(resolve(root, ".ingestron-execution")).length, 2);
  await first.access.finish();
  assert.throws(() => assertBuildIdle(root), code("EXECUTION_ACTIVE"));
  await independent.access.finish();
  assertBuildIdle(root);
  writeOutput(root, plan, { "data.json": '{"changed":true}' });
  assert.equal(
    readFileSync(resolve(root, "data.json"), "utf8"),
    '{"changed":true}',
  );
});

test("live process group keeps uncertain ownership; exact recovery transfers token without letting an old owner release it", async () => {
  const root = fixture(),
    first = claim(root, "same_run");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  await once(child, "spawn");
  assert.ok(child.pid);
  try {
    first.access.attachChild(child.pid!);
    assert.throws(
      () => claim(root, "same_run", "indeterminate"),
      code("EXECUTION_ACTIVE"),
    );
    await first.access.finish();
    assert.throws(() => assertBuildIdle(root), code("EXECUTION_ACTIVE"));
    assert.throws(
      () => claim(root, "same_run", "finished"),
      code("EXECUTION_ACTIVE"),
    );
    const exit = once(child, "exit");
    process.kill(-child.pid!, "SIGTERM");
    await exit;
    const old = JSON.parse(
      readFileSync(resolve(root, ".ingestron-execution/same_run.json"), "utf8"),
    );
    assert.equal(old.ownerFinished, true);
    const second = claim(root, "same_run", "indeterminate");
    const current = JSON.parse(
      readFileSync(resolve(root, ".ingestron-execution/same_run.json"), "utf8"),
    );
    assert.notEqual(current.token, old.token);
    await first.access.finish();
    assert.throws(() => assertBuildIdle(root), code("EXECUTION_ACTIVE"));
    await second.access.finish();
    assertBuildIdle(root);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }
});

test("real competing process cannot preflight under generation guard; validation is inside the same critical section", async () => {
  const root = fixture(),
    entry = resolve(root, "competing.mjs");
  const source = pathToFileURL(resolve("src/core/build-access.ts")).href;
  writeFileSync(
    entry,
    `import {prepareBuildExecution} from ${JSON.stringify(source)}; try { prepareBuildExecution(${JSON.stringify(root)},'other','none',()=>({flows:['orders'],fingerprint:'${"a".repeat(64)}'}));process.exit(2) } catch(e) { console.log(e.code);process.exit(e.code==='BUILD_BUSY'?0:3) }`,
  );
  withBuildGuard(root, () => {
    const attempted = spawnSync(process.execPath, ["--import", "tsx", entry], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(attempted.status, 0, attempted.stderr + attempted.stdout);
    assert.match(attempted.stdout, /BUILD_BUSY/);
    assert.equal(existsSync(resolve(root, ".ingestron-execution")), false);
  });
  const holder = claim(root, "after_generation");
  await holder.access.finish();
  assert.throws(
    () =>
      prepareBuildExecution(root, "bad_review", "none", () => {
        throw new Error("bad review");
      }),
    /bad review/,
  );
  assert.equal(existsSync(resolve(root, ".ingestron-generate.lock")), false);
  assertBuildIdle(root);
});

test("only original-run recovery releases a dead execution preflight; generation crash state remains fenced", async () => {
  const root = fixture(),
    child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  const file = resolve(root, ".ingestron-generate.lock"),
    value = {
      apiVersion: "ingestron.build-guard/v1",
      token: randomUUID(),
      pid: child.pid!,
      kind: "execution",
      id: "original",
    };
  writeFileSync(file, JSON.stringify(value));
  assert.throws(() => claim(root, "foreign", "finished"), code("BUILD_BUSY"));
  const recovered = claim(root, "original", "finished");
  await recovered.access.finish();
  writeFileSync(file, JSON.stringify({ ...value, kind: "generation" }));
  assert.throws(() => claim(root, "original", "finished"), code("BUILD_BUSY"));
  assert.equal(existsSync(file), true);
});

test("malformed or changed claim metadata is refused without private payload or unsafe release", async () => {
  const root = fixture(),
    held = claim(root, "private_run"),
    file = resolve(root, ".ingestron-execution/private_run.json");
  writeFileSync(file, JSON.stringify({ secret: "PRIVATE_SECRET_PAYLOAD" }));
  assert.throws(
    () => claim(root, "other"),
    (error: any) =>
      error.code === "EXECUTION_STATE" &&
      !String(error).includes("PRIVATE_SECRET_PAYLOAD"),
  );
  assert.throws(() => writeOutput(root, plan, {}), code("EXECUTION_STATE"));
  assert.equal(existsSync(file), true);
  void held;
});
