import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../../src/core/operations.js";
import { digest } from "../../src/core/errors.js";
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "snapshot-import-")),
    directory = join(root, "input");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(directory);
  const bytes = Buffer.from("PAR1synthetic-footerPAR1"),
    receipt = {
      apiVersion: "ingestron.snapshot/v1",
      status: "Succeeded",
      version: "1",
      sourceSnapshotId: "synthetic",
      synthetic: true,
      files: [
        {
          table: "orders",
          path: "orders.parquet",
          rows: 2,
          sha256: digest(bytes),
          schema: [],
        },
      ],
    };
  writeFileSync(join(directory, "orders.parquet"), bytes);
  const put = () =>
    writeFileSync(join(directory, "receipt.json"), JSON.stringify(receipt));
  put();
  const request = { name: "reviewed", directory };
  const call = (
    op: "presentation_snapshot_review" | "presentation_snapshot_apply",
    input: any = request,
    allowWrite = false,
  ) => execute({ root, allowWrite }, op, input);
  return { root, directory, bytes, receipt, put, request, call };
}
const ok = (r: any) => {
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  return r.result;
};
test("snapshot import verifies and reviews exact bytes, requires write authority and preserves existing snapshots", (t) => {
  const f = fixture(t),
    review = ok(f.call("presentation_snapshot_review"));
  assert.equal(review.tables[0].rows, 2);
  assert.equal(review.synthetic, true);
  assert.equal(existsSync(join(f.root, "snapshots")), false);
  const input = { ...f.request, digest: review.digest };
  assert.equal(
    f.call("presentation_snapshot_apply", input).diagnostics[0].code,
    "PERMISSION",
  );
  const result = ok(f.call("presentation_snapshot_apply", input, true));
  assert.equal(result.imported, true);
  assert.deepEqual(
    readFileSync(join(f.root, "snapshots/reviewed/orders.parquet")),
    f.bytes,
  );
  assert.equal(
    f.call("presentation_snapshot_apply", input, true).diagnostics[0].code,
    "OWNER",
  );
});
test("snapshot import denies stale receipt, missing/mismatched files, invalid names, signatures and symlinks", (t) => {
  const f = fixture(t),
    review = ok(f.call("presentation_snapshot_review"));
  f.receipt.version = "2";
  f.put();
  assert.equal(
    f.call(
      "presentation_snapshot_apply",
      { ...f.request, digest: review.digest },
      true,
    ).diagnostics[0].code,
    "STALE",
  );
  assert.equal(existsSync(join(f.root, "snapshots")), false);
  writeFileSync(join(f.directory, "orders.parquet"), "different");
  assert.equal(
    f.call("presentation_snapshot_review").diagnostics[0].code,
    "RECEIPT",
  );
  f.receipt.files[0].sha256 = digest("different");
  f.put();
  assert.equal(
    f.call("presentation_snapshot_review").diagnostics[0].code,
    "RECEIPT",
  );
  rmSync(join(f.directory, "orders.parquet"));
  symlinkSync(
    join(f.directory, "receipt.json"),
    join(f.directory, "orders.parquet"),
  );
  assert.equal(
    f.call("presentation_snapshot_review").diagnostics[0].code,
    "PATH",
  );
  assert.equal(
    f.call("presentation_snapshot_review", { ...f.request, name: "../other" })
      .diagnostics[0].code,
    "SCHEMA",
  );
});
test("snapshot import rejects duplicate table receipts and destination symlinks", (t) => {
  const f = fixture(t);
  f.receipt.files.push({ ...f.receipt.files[0] });
  f.put();
  assert.equal(
    f.call("presentation_snapshot_review").diagnostics[0].code,
    "RECEIPT",
  );
  f.receipt.files.pop();
  f.put();
  const outside = mkdtempSync(join(tmpdir(), "snapshot-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(f.root, "snapshots"));
  assert.equal(
    f.call("presentation_snapshot_review").diagnostics[0].code,
    "PATH",
  );
  assert.equal(existsSync(join(outside, "reviewed")), false);
});
