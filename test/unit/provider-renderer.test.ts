import { test } from "node:test";
import assert from "node:assert/strict";
import {
  executeProvider,
  expandProvider,
} from "../../src/plugins/provider-renderer.js";
test("provider ES module runs with deterministic JSON assets only", () => {
  const code =
    'export function validate(p) { if(p.id !== "demo") throw new Error("wrong input"); } export function render(p) { return {"README.md":{format:"text",value:p.id}}; }';
  assert.deepEqual(executeProvider(code, { id: "demo" }), {
    "README.md": { format: "text", value: "demo" },
  });
  assert.throws(() => executeProvider(code, { id: "other" }), /wrong input/);
});
test("provider process denies host APIs, nondeterminism, imports and unsafe paths", () => {
  for (const body of [
    "return process.env",
    'return fetch("https://example.invalid")',
    "return Math.random()",
    "return new Date()",
  ])
    assert.throws(() =>
      executeProvider(
        `export function validate() {} export function render() {${body}}`,
        {},
      ),
    );
  assert.throws(() =>
    executeProvider(
      'import fs from "node:fs"; export function validate() {} export function render() {return {}}',
      {},
    ),
  );
  assert.throws(
    () =>
      executeProvider(
        'export function validate() {} export function render() {return {"../escape":{format:"text",value:"x"}}}',
        {},
      ),
    /Unsafe/,
  );
});

test("provider rejects async output, malformed envelopes and runaway execution", () => {
  for (const body of [
    "return Promise.resolve({})",
    'return {"a":{format:"text",value:42}}',
    'return {"a":{format:"python",value:"pass"}}',
    "while(true) {}",
  ])
    assert.throws(() =>
      executeProvider(
        `export function validate() {} export function render() {${body}}`,
        {},
      ),
    );
  assert.throws(
    () =>
      executeProvider(
        "export async function validate() {} export function render() {return {}}",
        {},
      ),
    /synchronous/,
  );
});

test("provider loader respects aliased ES module exports", () => {
  assert.deepEqual(
    executeProvider(
      'function validate(){throw new Error("internal helper")}; function validatePlan(){}; function assets(){return {"ok.txt":{format:"text",value:"ok"}}}; export {validatePlan as validate, assets as render};',
      {},
    ),
    { "ok.txt": { format: "text", value: "ok" } },
  );
});
test("provider planning is isolated, synchronous and structurally bounded", () => {
  assert.deepEqual(
    expandProvider(
      "export function expand(p){return {steps:[],recovery:{standard:p.standard}}}",
      { standard: "sample@v1" },
    ),
    { steps: [], recovery: { standard: "sample@v1" } },
  );
  for (const code of [
    "export async function expand(){return {steps:[],recovery:{}}}",
    "export function expand(){return {steps:[],recovery:{},files:{}}}",
    'export function expand(){return {steps:"bad",recovery:{}}}',
    "export function expand(){return process.env}",
    'import x from "node:fs"; export function expand(){return {steps:[],recovery:{}}}',
  ])
    assert.throws(() => expandProvider(code, {}));
});
