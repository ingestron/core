import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execute } from "../../src/core/operations.js";

function fixture(t: any, content: string) {
  const root = mkdtempSync(join(tmpdir(), "paged-read-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "report.json"), content);
  return { root };
}

test("bounded read pages preserve Unicode, exact content and ordinary read shape", (t) => {
  const text = "A😀B Māori 日本語 ".repeat(50_000);
  const context = fixture(t, text);
  const whole = execute(context, "read", { path: "report.json" });
  assert.equal(whole.ok, true);
  assert.deepEqual(whole.result, { path: "report.json", content: text });
  let offset = 0,
    hash: string | undefined;
  const pages: string[] = [];
  do {
    const response = execute(context, "read", {
      path: "report.json",
      slice: { offset, limit: 262_144, ...(hash ? { sha256: hash } : {}) },
    });
    assert.equal(response.ok, true, JSON.stringify(response));
    const result = response.result as any;
    assert.equal(result.slice.offset, offset);
    assert.equal(result.slice.totalBytes, Buffer.byteLength(text));
    assert.equal(result.slice.totalCharacters, text.length);
    assert.ok(Buffer.byteLength(result.content) <= 3 * 262_144);
    hash ??= result.slice.sha256;
    assert.equal(result.slice.sha256, hash);
    pages.push(result.content);
    offset = result.slice.nextOffset;
  } while (offset !== undefined);
  assert.ok(pages.length > 1);
  assert.equal(pages.join(""), text);
  assert.equal(hash, createHash("sha256").update(text).digest("hex"));
  const boundary = execute(context, "read", {
    path: "report.json",
    slice: { offset: 0, limit: 2 },
  });
  assert.equal(boundary.ok, true);
  assert.equal((boundary.result as any).content, "A");
  assert.equal((boundary.result as any).slice.nextOffset, 1);
  const split = execute(context, "read", {
    path: "report.json",
    slice: { offset: 2, limit: 2 },
  });
  assert.equal(split.ok, false);
});

test("paged read refuses changed content, invalid pages and unsafe paths without write authority", (t) => {
  const context = fixture(t, "unchanged report");
  const first = execute(context, "read", {
    path: "report.json",
    slice: { offset: 0, limit: 4 },
  });
  assert.equal(first.ok, true);
  writeFileSync(join(context.root, "report.json"), "changed report");
  const changed = execute(context, "read", {
    path: "report.json",
    slice: { offset: 4, limit: 4, sha256: (first.result as any).slice.sha256 },
  });
  assert.equal(changed.ok, false);
  assert.equal(changed.diagnostics[0].code, "STALE");
  for (const slice of [
    { offset: -1, limit: 4 },
    { offset: 0, limit: 262_145 },
    { offset: 0, limit: 1 },
    { offset: 999, limit: 4 },
  ]) {
    assert.equal(
      execute(context, "read", { path: "report.json", slice }).ok,
      false,
    );
  }
  for (const path of [
    ".secret.json",
    "../report.json",
    "runtime.env",
    "report.exe",
  ]) {
    assert.equal(
      execute(context, "read", { path, slice: { offset: 0, limit: 4 } }).ok,
      false,
    );
  }
  const outside = mkdtempSync(join(tmpdir(), "read-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "report.json"), "Must not be read");
  symlinkSync(outside, join(context.root, "outside"));
  const escaped = execute(context, "read", {
    path: "outside/report.json",
    slice: { offset: 0, limit: 4 },
  });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.diagnostics[0].code, "PATH");
});

test("empty and end-of-file pages finish without a continuation", (t) => {
  const context = fixture(t, "");
  const empty = execute(context, "read", {
    path: "report.json",
    slice: { offset: 0, limit: 2 },
  });
  assert.equal(empty.ok, true);
  assert.equal((empty.result as any).content, "");
  assert.equal((empty.result as any).slice.totalCharacters, 0);
  assert.equal((empty.result as any).slice.nextOffset, undefined);
});

test("paging retains the existing ten-MiB source-file limit before returning a page", (t) => {
  const context = fixture(t, "a".repeat(10 * 1024 * 1024 + 1));
  const result = execute(context, "read", {
    path: "report.json",
    slice: { offset: 0, limit: 4 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, "LIMIT");
});
