import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resolveResourceDeclaration } from "../../src/core/execution-resources.js";
import {
  prepareBuildExecution,
  assertBuildIdle,
} from "../../src/core/build-access.js";
const declaration = (entries: [string, string[]][]) => ({
  apiVersion: "ingestron.execution-resources/v1",
  flows: entries.map(([flow, identities]) => ({
    flow,
    resources: identities.map((identity) => ({
      namespace: "synthetic-destination",
      identity,
    })),
  })),
});
test("physical identities remain stable across flows and selections; raw target values stay private", () => {
  const raw = declaration([
    ["one", ["private_destination"]],
    ["two", ["private_destination"]],
    ["three", ["other_destination"]],
  ]);
  const full = resolveResourceDeclaration(raw, ["three", "one", "two"]);
  assert.equal(full.coverage, "provider-declared");
  assert.equal(full.resources.length, 2);
  assert.deepEqual(
    full.flows.find((row) => row.flow === "one")!.resources,
    full.flows.find((row) => row.flow === "two")!.resources,
  );
  assert.equal(JSON.stringify(full).includes("private_destination"), false);
  const subset = resolveResourceDeclaration(
    declaration([["two", ["private_destination"]]]),
    ["two"],
  );
  assert.deepEqual(
    subset.resources,
    full.flows.find((row) => row.flow === "two")!.resources,
  );
});
test("malformed, missing, foreign, duplicate and oversized declarations fail without echoing identities", () => {
  const expected = (error: any) =>
    error.code === "EXECUTION_RESOURCES" &&
    !error.message.includes("private_destination");
  const valid = declaration([["one", ["private_destination"]]]);
  for (const invalid of [
    { ...valid, secret: "private_destination" },
    declaration([["foreign", ["private_destination"]]]),
    declaration([
      ["one", ["private_destination"]],
      ["one", ["second"]],
    ]),
    declaration([["one", ["private_destination", "private_destination"]]]),
    declaration([["one", ["\u0000private_destination"]]]),
    declaration([
      ["one", Array.from({ length: 129 }, (_, i) => "private_destination" + i)],
    ]),
    declaration([["one", []]]),
  ])
    assert.throws(() => resolveResourceDeclaration(invalid, ["one"]), expected);
  const tooMany = declaration(
    Array.from({ length: 5 }, (_, i) => [
      "flow_" + i,
      Array.from({ length: 128 }, (_, j) => `private_destination_${i}_${j}`),
    ]),
  );
  assert.throws(
    () =>
      resolveResourceDeclaration(
        tooMany,
        tooMany.flows.map((row) => row.flow),
      ),
    expected,
  );
});
test("different flows sharing a declared target are refused before execution; independent target remains available", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "ingestron-resource-claims-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resources = resolveResourceDeclaration(
    declaration([
      ["one", ["shared"]],
      ["two", ["shared"]],
      ["three", ["independent"]],
    ]),
    ["one", "two", "three"],
  );
  const start = (flow: string) =>
    prepareBuildExecution(root, "run_" + flow, "none", () => ({
      flows: [flow],
      fingerprint: "a".repeat(64),
      resources: resources.flows.find((row) => row.flow === flow)!.resources,
    }));
  const first = start("one");
  assert.throws(
    () => start("two"),
    (error: any) => error.code === "EXECUTION_ACTIVE",
  );
  const independent = start("three");
  await first.access.finish();
  const recovered = start("two");
  await independent.access.finish();
  await recovered.access.finish();
  assertBuildIdle(root);
});

test("a maximum resource selection persists bounded ownership and refuses changed recovery", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "ingestron-resource-limit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resources = Array.from({ length: 500 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  const boundary = { flows: ["one"], fingerprint: "a".repeat(64), resources };
  const first = prepareBuildExecution(root, "same_run", "none", () => boundary);
  assert.throws(
    () =>
      prepareBuildExecution(root, "same_run", "finished", () => ({
        ...boundary,
        resources: resources.slice(1),
      })),
    (error: any) => error.code === "EXECUTION_ACTIVE",
  );
  const recovered = prepareBuildExecution(
    root,
    "same_run",
    "finished",
    () => boundary,
  );
  await first.access.finish();
  assert.throws(
    () => assertBuildIdle(root),
    (error: any) => error.code === "EXECUTION_ACTIVE",
  );
  await recovered.access.finish();
  assertBuildIdle(root);
});
