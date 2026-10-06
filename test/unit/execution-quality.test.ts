import test from "node:test";
import assert from "node:assert/strict";
import {
  qualityFailureEvidence,
  ExecutionQualityFailure,
} from "../../src/core/execution-quality.js";
import { launch } from "../../src/core/execution.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("quality failure summaries retain only bounded rule identities and finite counts", () => {
  const input = [
    {
      id: "orders.unique",
      stream: "orders",
      metric: "duplicateValues",
      value: 2,
      row: "private value",
      token: "sensitive",
    },
    { id: "bad\nmessage", stream: "orders", metric: "rowCount", value: 2 },
    { id: "nan", stream: "orders", metric: "rowCount", value: NaN },
    { id: "bad", stream: "orders", metric: "unknown", value: 2 },
  ];
  assert.deepEqual(qualityFailureEvidence(input), [
    {
      id: "orders.unique",
      stream: "orders",
      metric: "duplicateValues",
      value: 2,
      passed: false,
      outcome: "fail",
    },
  ]);
  assert.equal(qualityFailureEvidence(Array(100).fill(input[0])).length, 20);
});
test("the execution launcher maps a metadata limit to safe actionable guidance", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "core-metadata-limit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "executor.py");
  writeFileSync(
    entry,
    `import json,sys\njson.loads(sys.stdin.read())\nprint(json.dumps({'apiVersion':'ingestron.execution-result/v1','status':'failed','errorCode':'SOURCE_METADATA_LIMIT','message':'SYNTHETIC_PRIVATE_SOURCE_DETAIL'}))\nsys.exit(1)\n`,
  );
  await assert.rejects(
    launch("python3", entry, {}, root, { PATH: process.env.PATH }),
    (error: any) => {
      assert.equal(error.code, "SOURCE_METADATA_LIMIT");
      assert.match(error.message, /Split tables into smaller flows/);
      assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE_SOURCE_DETAIL/);
      return true;
    },
  );
});
test("the launcher distinguishes a collection limit from a document limit", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "core-collection-limit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "executor.py");
  writeFileSync(
    entry,
    `import json,sys\njson.loads(sys.stdin.read())\nprint(json.dumps({'apiVersion':'ingestron.execution-result/v1','status':'failed','errorCode':'SOURCE_METADATA_COLLECTION_LIMIT','message':'SYNTHETIC_PRIVATE_SOURCE_DETAIL'}))\nsys.exit(1)\n`,
  );
  await assert.rejects(
    launch("python3", entry, {}, root, { PATH: process.env.PATH }),
    (error: any) => {
      assert.equal(error.code, "SOURCE_METADATA_COLLECTION_LIMIT");
      assert.match(error.message, /7 MB metadata collection limit/);
      assert.match(error.message, /prepare again/);
      assert.doesNotMatch(
        error.message,
        /2 MB|SYNTHETIC_PRIVATE_SOURCE_DETAIL/,
      );
      return true;
    },
  );
});
test("the explicit execution launcher preserves sanitised quality failure evidence", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "core-quality-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "executor.py");
  writeFileSync(
    entry,
    `import json,sys\njson.loads(sys.stdin.read())\nprint(json.dumps({'apiVersion':'ingestron.execution-result/v1','status':'failed','errorCode':'QUALITY_FAILED','message':'private provider message','quality':[{'id':'orders.unique','stream':'orders','metric':'duplicateValues','value':2,'row':'private value'}]}))\nsys.exit(1)\n`,
  );
  await assert.rejects(
    launch("python3", entry, {}, root, { PATH: process.env.PATH }),
    (error: any) => {
      assert.ok(error instanceof ExecutionQualityFailure);
      assert.equal(error.quality[0].value, 2);
      assert.doesNotMatch(
        JSON.stringify(error),
        /private value|private provider/,
      );
      return true;
    },
  );
});
