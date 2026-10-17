import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { previewLocalOutput } from "../../src/core/local-output-preview.js";
import { digest } from "../../src/core/errors.js";
import { executeAsync } from "../../src/core/operations.js";
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "local-preview-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = "a".repeat(64),
    namespace = "b".repeat(64),
    run = "run-1";
  const folder = join(root, `build/dev/data/sales/${namespace}/${run}`),
    cache = join(root, `.ingestron/runtimes/${runtime}`);
  mkdirSync(folder, { recursive: true });
  mkdirSync(join(cache, "bin"), { recursive: true });
  writeFileSync(join(cache, "ready.json"), JSON.stringify({ lock: runtime }));
  // Protocol stub; real PyArrow parsing is covered by installed acceptance.
  const response = {
    columns: ["id", "name"],
    rows: [[1, null]],
    truncated: false,
    cellsTruncated: false,
  };
  const python = join(cache, "bin/python");
  const setResponse = (r: any) =>
    writeFileSync(
      python,
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(r))});`,
      { mode: 0o755 },
    );
  setResponse(response);
  const file = join(folder, "Customers.parquet");
  writeFileSync(file, "synthetic-parquet-boundary");
  const sha256 = digest(readFileSync(file));
  const commit = join(folder, "commit.json");
  writeFileSync(
    commit,
    JSON.stringify({
      format: "ingestron-singer-local-snapshot/preview-1",
      identity: { run_id: run },
      tables: [{ stream: "Customers", rows: 1, sha256 }],
    }),
  );
  const input = {
    flow: "sales",
    run,
    stream: "Customers",
    sha256,
    rows: 1,
    runtime,
    limit: 20,
  };
  const call = (patch: any = {}) =>
    previewLocalOutput(root, join(root, "build/dev"), { ...input, ...patch });
  return { root, file, commit, call, setResponse, response, input };
}
test("local preview returns only bounded immediate values and creates no receipts", async (t) => {
  const f = fixture(t);
  const before = readFileSync(f.commit, "utf8");
  assert.deepEqual(await f.call(), f.response);
  assert.equal(readFileSync(f.commit, "utf8"), before);
  await assert.rejects(f.call({ sha256: "c".repeat(64) }), /differs/);
  await assert.rejects(f.call({ run: "other" }), /missing/);
  await assert.rejects(f.call({ runtime: "../escape" }), /identity/);
  f.setResponse({ ...f.response, rows: Array(21).fill([1, null]) });
  await assert.rejects(f.call(), /Cannot inspect/);
  f.setResponse({ ...f.response, rows: [["a".repeat(501), null]] });
  await assert.rejects(f.call(), /Cannot inspect/);
  f.setResponse({ ...f.response, rows: [[1]] });
  await assert.rejects(f.call(), /bounds/);
});
test("preview rejects changed, missing and symlinked output", async (t) => {
  const f = fixture(t);
  writeFileSync(f.file, "changed");
  await assert.rejects(f.call(), /changed/);
  rmSync(f.file);
  symlinkSync(f.commit, f.file);
  await assert.rejects(f.call());
});
test("preview operation requires explicit permission and rejects arbitrary selectors before reading", async () => {
  const input = {
    flow: "sales",
    from: "build/dev",
    run: "run-1",
    stream: "Customers",
    sha256: "a".repeat(64),
  };
  const r = await executeAsync({ root: tmpdir() }, "delivery_preview", input);
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics[0]?.code, "PERMISSION");
  for (const patch of [
    { stream: "../secret" },
    { run: "../secret" },
    { from: "/tmp" },
    { limit: 21 },
    { sql: "select *" },
    { sha256: "invalid" },
  ])
    assert.equal(
      (
        await executeAsync(
          { root: tmpdir(), allowExecute: true },
          "delivery_preview",
          { ...input, ...patch },
        )
      ).ok,
      false,
    );
});
