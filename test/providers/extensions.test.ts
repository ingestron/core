import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../support/project.js";
import { planProject } from "../../src/core/planner.js";
import { renderProject } from "../../src/core/generate.js";
test("an independent provider module can own new activities without a CLI renderer change", (t) => {
  const f = fixture(t);
  delete f.flow.ingestion;
  const save = () => {
    f.put("project.yaml", f.project);
    f.put("flows/source/flow.yaml", f.flow);
  };
  f.project.providers.packages.dbx.source = "./custom/provider.yaml";
  f.project.providers.configurations.engineering.options = {
    label: "reviewed",
  };
  f.flow.steps = [{ id: "inspect", uses: "inspect-contract@v1" }];
  f.put("custom/provider.yaml", {
    apiVersion: "ingestron.provider/v1",
    id: "custom",
    version: "1.0.0",
    platform: "databricks",
    configurationSchema: {
      type: "object",
      properties: { label: { type: "string" } },
      required: ["label"],
      additionalProperties: false,
    },
    renderer: {
      apiVersion: "ingestron.provider-generation/v1",
      module: "./index.mjs",
    },
    activities: { "inspect-contract": "./activity.yaml" },
  });
  f.put("custom/activity.yaml", {
    apiVersion: "ingestron.activity/v1",
    id: "inspect-contract",
    version: "1.0.0",
    platform: "databricks",
    description: "Document a reviewed contract",
    input: "source",
    output: "relation",
    effect: "read",
    optionsSchema: { type: "object", additionalProperties: false },
    generator: { kind: "native-notebook", entrypoint: "render" },
    requirements: {
      execution: "databricks-classic-spark",
      features: [],
      evidence: "offline",
    },
  });
  f.put(
    "custom/index.mjs",
    'export function validate(p) { if(p.nodes.some(n=>n.runtime.options.label!=="reviewed")) throw new Error("label required"); } export function render(p) { return {"README.md": {format:"text",value:p.nodes.map(n=>n.id).join("\\n")}}; }',
  );
  save();
  const plan = planProject(f.root);
  assert(plan.files["custom/index.mjs"]);
  assert.match(renderProject(f.root, plan)["README.md"], /customers/);
  f.put("custom/index.mjs", "export function render() {return {}}");
  assert.throws(
    () => renderProject(f.root, plan),
    /changed|digest|stale|match/i,
  );
});
