import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { execute } from "../../src/core/operations.js";
import { presentationFixture } from "../support/presentation.js";
const ok = (r: any) => {
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  return r.result;
};
test("presentation reviews bind snapshot bytes, model/provider inventory and environment while preserving releases", (t) => {
  const f = presentationFixture(t),
    ctx = { root: f.root, environment: "dev" };
  const catalogue = ok(execute(ctx, "presentation_catalogue", {}));
  assert.equal(
    catalogue.providers.find((p: any) => p.id === "reporting").commands[0],
    "report build",
  );
  assert.equal(catalogue.snapshots[0].snapshot, "synthetic");
  assert.equal(catalogue.packs[0].ready, true);
  const review = ok(execute(ctx, "presentation_review", f.input));
  assert.equal(review.output, "presentations/dev/board/releases/r1");
  assert.equal(existsSync(resolve(f.root, review.output)), false);
  assert.equal(
    execute(ctx, "apply", { proposal: review.proposal }).diagnostics[0].code,
    "PERMISSION",
  );
  const write = { ...ctx, allowWrite: true };
  ok(execute(write, "apply", { proposal: review.proposal }));
  assert.equal(
    JSON.parse(
      readFileSync(resolve(f.root, review.output, "report.json"), "utf8"),
    ).branding.company,
    "Synthetic",
  );
  assert.equal(
    ok(execute(ctx, "presentation_catalogue", {})).saved[0].release,
    "r1",
  );
  assert.equal(
    execute(ctx, "presentation_review", f.input).diagnostics[0].code,
    "OWNER",
  );
  const second = ok(
    execute(ctx, "presentation_review", { ...f.input, release: "r2" }),
  );
  f.put("snapshots/synthetic/customers.parquet", "changed");
  assert.equal(
    execute(write, "apply", { proposal: second.proposal }).diagnostics[0].code,
    "STALE",
  );
  assert.equal(
    execute(ctx, "presentation_review", { ...f.input, release: "r2" })
      .diagnostics[0].code,
    "RECEIPT",
  );
  assert.equal(
    existsSync(resolve(f.root, "presentations/dev/board/releases/r2")),
    false,
  );
});
test("presentation rejects false provenance, traversal and package tampering", (t) => {
  const f = presentationFixture(t),
    ctx = { root: f.root };
  assert.equal(
    execute(ctx, "presentation_review", {
      ...f.input,
      lineage: { ...f.input.lineage, synthetic: false },
    }).diagnostics[0].code,
    "LINEAGE",
  );
  assert.equal(
    execute(ctx, "presentation_review", {
      ...f.input,
      receipt: "../receipt.json",
    }).ok,
    false,
  );
  const review = ok(execute(ctx, "presentation_review", f.input));
  const dependency = Object.keys(review.proposal.inputs).find(
    (p) => p.includes(".ingestron/") && p.endsWith("model.yaml"),
  )!;
  assert.ok(dependency);
  f.put(dependency, "tampered");
  assert.equal(
    execute({ ...ctx, allowWrite: true }, "apply", {
      proposal: review.proposal,
    }).diagnostics[0].code,
    "STALE",
  );
});
test("presentation inventories skip symlink discovery and explain incomplete snapshots", (t) => {
  const f = presentationFixture(t);
  symlinkSync(
    resolve(f.root, "snapshots/synthetic"),
    resolve(f.root, "snapshots/redirect"),
  );
  f.put("snapshots/broken/receipt.json", "{}");
  const result = ok(execute({ root: f.root }, "presentation_catalogue", {}));
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.notices.length, 1);
});
