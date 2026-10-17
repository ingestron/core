import test from "node:test";
import assert from "node:assert/strict";
import { deliveryResults } from "../../src/core/delivery-evidence.js";
test("delivery results retain only measured rules and bounded output counts", () => {
  const good = {
    id: "nonnull",
    stream: "orders",
    metric: "nullValues",
    value: 2,
    passed: false,
    outcome: "fail",
    secret: "hidden",
  };
  const result = deliveryResults({
    quality: [
      good,
      { ...good, metric: "sourcePayload" },
      { ...good, value: Infinity },
    ],
    result: {
      flows: [
        {
          flow: "orders",
          tables: [
            { stream: "orders", rows: 3, privateRow: "hidden" },
            { stream: "orders", rows: -1 },
          ],
        },
      ],
    },
  });
  assert.equal(result.quality.length, 1);
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].rows, 3);
  assert.equal(JSON.stringify(result).includes("hidden"), false);
  assert.equal(
    deliveryResults({ quality: Array(50).fill(good) }).quality.length,
    20,
  );
});
