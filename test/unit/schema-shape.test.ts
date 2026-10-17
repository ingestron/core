import test from "node:test";
import assert from "node:assert/strict";
import { validateSchemaShape } from "../../src/core/provider-commands.js";

test("source and provider schemas accept bounded descriptive annotations without schema code or complex defaults", () => {
  assert.doesNotThrow(() =>
    validateSchemaShape({
      type: "object",
      description: "Explicitly read reviewed records",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 20,
          title: "Record limit",
        },
        enabled: { type: "boolean", default: false },
      },
      additionalProperties: false,
    }),
  );
  for (const annotation of [
    { title: "x".repeat(201) },
    { description: "x".repeat(2001) },
    { title: 42 },
    { default: { secret: "PRIVATE_DEFAULT" } },
    { default: [1] },
    { default: Number.POSITIVE_INFINITY },
    { default: "x".repeat(1001) },
    { $ref: "https://example.invalid/schema" },
    { pattern: ".*" },
  ]) {
    assert.throws(() =>
      validateSchemaShape({
        type: "object",
        properties: { field: { type: "string", ...annotation } },
      }),
    );
  }
  assert.doesNotThrow(() =>
    validateSchemaShape({ type: "string", default: null, title: "" }),
  );
});
