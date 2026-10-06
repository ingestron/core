import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { fixture } from "../support/project.js";
import { planProject } from "../../src/core/planner.js";
const setup = (t: any, count: number) => {
  const f = fixture(t),
    path = "fixture-origin/plugin/provider.yaml",
    manifest = parse(readFileSync(resolve(f.root, path), "utf8"));
  manifest.compatibility.requiredFeatures = [
    "flow-schedules",
    "flow-schedule-resource-claims",
  ];
  manifest.capabilities = {
    schedules: ["daily"],
    artifactKinds: ["native-notebook"],
    delivery: false,
    handovers: [],
    packContracts: {},
  };
  f.put(path, manifest);
  f.project.providers.packages.dbx.source = "./" + path;
  f.put("project.yaml", f.project);
  const code = readFileSync(
    resolve(f.root, "fixture-origin/plugin/index.mjs"),
    "utf8",
  );
  f.put(
    "fixture-origin/plugin/index.mjs",
    code.replace(
      "export function model(r){return {with:r.node.with,datasets:{},targets:[r.tableName]};}",
      `export function model(r){if(r.flowContext.id!=='source'||JSON.stringify(r.flowContext.tableIds)!=='["customers","orders"]')throw Error('Missing full flow ownership context');if(!r.flowContext.schedule && r.flowContext.schedule!==null)throw Error('Manual schedule must be explicit null');if(r.flowContext.schedule && r.flowContext.schedule.recurrence.times.length!==100)throw Error('Lost schedule definition');return {with:r.node.with,datasets:{},targets:[r.tableName],resources:r.node.table==='customers'?Array.from({length:${count}},(_,index)=>({scope:'synthetic',kind:'trigger',name:'trigger_'+index})):[]};}`,
    ),
  );
  return f;
};
test("model context keeps all100 reviewed slots and the full flow roster; inventory stays bounded", (t) => {
  const f = setup(t, 128);
  f.flow.schedule = {
    apiVersion: "ingestron.schedule/v1",
    enabled: false,
    timeZone: "UTC",
    start: "2026-10-05T00:00:00Z",
    recurrence: {
      kind: "daily",
      times: Array.from(
        { length: 100 },
        (_, i) =>
          String(Math.floor(i / 60)).padStart(2, "0") +
          ":" +
          String(i % 60).padStart(2, "0"),
      ),
    },
  };
  f.put("flows/source/flow.yaml", f.flow);
  const plan = planProject(f.root);
  assert.equal(
    plan.nodes.find((node) => node.table === "customers")!.resources!.length,
    128,
  );
  assert.equal(
    plan.nodes.find((node) => node.table === "orders")!.resources!.length,
    0,
  );
  assert.equal(
    planProject(f.root, "dev", { flow: "source", table: "orders" }).nodes[0]
      .resources!.length,
    0,
  );
});
test("oversized model inventories remain rejected and manual context has no invented schedule", (t) => {
  const f = setup(t, 129);
  assert.throws(
    () => planProject(f.root),
    (error: any) =>
      error.code === "PROVIDER" && /resource claims/.test(error.message),
  );
});
