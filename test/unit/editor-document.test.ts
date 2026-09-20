import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDocument } from "../../src/sdk/schemas.js";

test("unsaved document validation accepts content without filesystem resolution", () => {
  const result = validateDocument({
    kind: "environment",
    uri: "untitled:Environment",
    content: "apiVersion: ingestron.environment/v1\nvalues:\n  count: 3\n",
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
});
test("schema diagnostics locate an invalid value in the supplied buffer", () => {
  const content = "apiVersion: ingestron.environment/v1\nvalues: false\n";
  const result = validateDocument({
    kind: "environment",
    uri: "untitled:Environment",
    content,
  });
  assert.equal(result.valid, false);
  const d = result.diagnostics.find((d) => d.pointer === "/values")!;
  assert.equal(d.file, "untitled:Environment");
  assert.equal(d.line, 2);
  assert.equal(d.column, 9);
  assert.equal(content.slice(d.range.start, d.range.end), "false");
});
test("syntax errors and missing fields return structured diagnostics", () => {
  const malformed = validateDocument({
    kind: "environment",
    uri: "test",
    content: "values: [\n",
  });
  assert.equal(malformed.valid, false);
  assert.equal(malformed.diagnostics[0].code, "YAML");
  const missing = validateDocument({
    kind: "step",
    uri: "test",
    content: "id: sample\n",
  });
  assert.equal(missing.valid, false);
  assert.ok(missing.diagnostics.some((d) => d.pointer === "/uses"));
});
test("unknown document kind and alias expansion errors do not escape the API", () => {
  assert.equal(
    validateDocument({ kind: "toString" as any, uri: "test", content: "{}" })
      .valid,
    false,
  );
  assert.equal(
    validateDocument({
      kind: "environment",
      uri: "test",
      content: "values: *missing",
    }).valid,
    false,
  );
});
