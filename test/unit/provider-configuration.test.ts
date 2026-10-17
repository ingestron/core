import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, parseDocument } from "yaml";
import { execute } from "../../src/core/operations.js";
import { fixture } from "../support/project.js";
const schema = {
  type: "object",
  properties: {
    timeout: { type: "integer", minimum: 1, maximum: 86400 },
    scheduleInputs: {
      type: "object",
      patternProperties: {
        "^[A-Za-z_][A-Za-z0-9_-]*$": {
          type: "object",
          required: ["kind", "linkedService", "schema", "view"],
          properties: {
            kind: { enum: ["azure-sql", "sql-server"] },
            linkedService: {
              type: "string",
              pattern: "^[A-Za-z_][A-Za-z0-9_-]*$",
            },
            schema: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
            view: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};
const source = {
  kind: "azure-sql",
  linkedService: "reviewed_manifest",
  schema: "governance",
  view: "frozen_source_manifest",
};
function setup(t: any) {
  const f = fixture(t),
    manifest = parse(
      readFileSync(
        resolve(f.root, "fixture-origin/plugin/provider.yaml"),
        "utf8",
      ),
    );
  manifest.configurationSchema = "configuration.schema.json";
  f.put("fixture-origin/plugin/provider.yaml", manifest);
  f.put(
    "fixture-origin/plugin/configuration.schema.json",
    JSON.stringify(schema),
  );
  f.project.providers.packages.dbx = {
    source: "./fixture-origin/plugin/provider.yaml",
    version: "1.0.0",
  };
  f.project.providers.configurations.engineering.options = {
    timeout: 30,
    scheduleInputs: { manual: { ...source, view: "manual_manifest" } },
  };
  f.put("project.yaml", f.project);
  return f;
}
const inspect = (f: any) =>
  execute({ root: f.root }, "provider_configuration_inspect", {
    configuration: "engineering",
  });
const propose = (
  f: any,
  options: any,
  expectedDigest = inspect(f).result.digest,
) =>
  execute({ root: f.root }, "provider_configuration_propose", {
    configuration: "engineering",
    options,
    expectedDigest,
  });
const passed = (value: any) => {
  assert.equal(value.ok, true, JSON.stringify(value));
  return value.result;
};
test("inspection reports provider-owned schema and every default/profile user without execution or writes", (t) => {
  const f = setup(t);
  f.project.flows.push({
    id: "downstream",
    kind: "transform",
    provider: "other",
    executionProfiles: { nightly: { provider: "engineering" } },
  });
  f.put("project.yaml", f.project);
  const before = readFileSync(resolve(f.root, "project.yaml"), "utf8");
  const value = passed(inspect(f));
  assert.deepEqual(value.schema, schema);
  assert.deepEqual(
    value.options,
    f.project.providers.configurations.engineering.options,
  );
  assert.deepEqual(value.affectedFlows, [
    { id: "downstream", default: false, profiles: ["nightly"] },
    { id: "source", default: true, profiles: [] },
  ]);
  assert.equal(value.executionEnabled, false);
  assert.equal(value.valid, true);
  assert.equal(readFileSync(resolve(f.root, "project.yaml"), "utf8"), before);
});
test("options proposal preserves neighbour maps/comments, authoritative fragment layout and write permission", (t) => {
  const f = setup(t);
  f.project.providers.configurations.engineering.options = {
    $resolve: "./provider-options.yaml#/shared/options",
  };
  f.put("project.yaml", f.project);
  f.put(
    "provider-options.yaml",
    "# Keep engineering notes\nshared:\n  options:\n    timeout: 30 # retain timeout\n    scheduleInputs:\n      manual:\n        kind: azure-sql\n        linkedService: reviewed_manifest\n        schema: governance\n        view: manual_manifest # retain manual owner\nother: keep\n",
  );
  const before = readFileSync(resolve(f.root, "project.yaml"), "utf8");
  const inspected = passed(inspect(f));
  assert.deepEqual(inspected.definition, {
    path: "provider-options.yaml",
    pointer: ["shared", "options"],
  });
  const options = {
    ...inspected.options,
    scheduleInputs: { ...inspected.options.scheduleInputs, source },
  };
  const proposal = passed(propose(f, options));
  assert.equal(proposal.changes.length, 1);
  assert.equal(proposal.changes[0].path, "provider-options.yaml");
  assert.match(proposal.changes[0].after, /# retain timeout/);
  assert.match(proposal.changes[0].after, /# retain manual owner/);
  assert.match(proposal.changes[0].after, /# Keep engineering notes/);
  assert.equal(
    execute({ root: f.root }, "apply", { proposal }).diagnostics[0].code,
    "PERMISSION",
  );
  passed(execute({ root: f.root, allowWrite: true }, "apply", { proposal }));
  assert.deepEqual(passed(inspect(f)).options, options);
  assert.equal(readFileSync(resolve(f.root, "project.yaml"), "utf8"), before);
  assert.equal(
    parse(readFileSync(resolve(f.root, "provider-options.yaml"), "utf8")).other,
    "keep",
  );
});
test("bad fields, unsupported source kind, unsafe identifiers and stale inspected options are refused before a proposal", (t) => {
  const f = setup(t),
    initial = passed(inspect(f));
  for (const options of [
    { ...initial.options, unknown: true },
    { ...initial.options, timeout: 0 },
    {
      ...initial.options,
      scheduleInputs: { source: { ...source, kind: "sftp" } },
    },
    {
      ...initial.options,
      scheduleInputs: { source: { ...source, view: "view;SELECT" } },
    },
  ])
    assert.equal(propose(f, options).diagnostics[0].code, "PROVIDER");
  const before = readFileSync(resolve(f.root, "project.yaml"), "utf8");
  f.project.providers.configurations.engineering.binding = "changed";
  f.put("project.yaml", f.project);
  assert.equal(
    propose(f, initial.options, initial.digest).diagnostics[0].code,
    "STALE",
  );
  assert.notEqual(
    readFileSync(resolve(f.root, "project.yaml"), "utf8"),
    before,
  );
});
test("provider schema changes invalidate both inspection digest and an already reviewed proposal", (t) => {
  const f = setup(t),
    initial = passed(inspect(f)),
    proposal = passed(propose(f, { ...initial.options, timeout: 60 }));
  assert.ok(proposal.inputs["fixture-origin/plugin/configuration.schema.json"]);
  f.put(
    "fixture-origin/plugin/configuration.schema.json",
    JSON.stringify({ ...schema, description: "changed schema owner" }),
  );
  assert.equal(
    propose(f, { ...initial.options, timeout: 60 }, initial.digest)
      .diagnostics[0].code,
    "STALE",
  );
  const before = readFileSync(resolve(f.root, "project.yaml"), "utf8");
  assert.equal(
    execute({ root: f.root, allowWrite: true }, "apply", { proposal })
      .diagnostics[0].code,
    "STALE",
  );
  assert.equal(readFileSync(resolve(f.root, "project.yaml"), "utf8"), before);
});
test("environment placeholders are never resolved during inspection and invalid options can be reviewed for repair", (t) => {
  const f = setup(t);
  f.project.providers.configurations.engineering.options = {
    timeout: { $env: "INGESTRON_SYNTHETIC_TIMEOUT" },
  };
  f.put("project.yaml", f.project);
  process.env.INGESTRON_SYNTHETIC_TIMEOUT = "42";
  t.after(() => delete process.env.INGESTRON_SYNTHETIC_TIMEOUT);
  const value = passed(inspect(f));
  assert.equal(value.valid, false);
  assert.deepEqual(value.options.timeout, {
    $env: "INGESTRON_SYNTHETIC_TIMEOUT",
  });
  const proposal = passed(propose(f, { timeout: 42 }, value.digest));
  passed(execute({ root: f.root, allowWrite: true }, "apply", { proposal }));
  assert.equal(passed(inspect(f)).options.timeout, 42);
});
test("shared YAML option aliases are refused rather than changing another configuration", (t) => {
  const f = setup(t),
    doc = parseDocument(readFileSync(resolve(f.root, "project.yaml"), "utf8"));
  const original: any = doc.getIn(
    ["providers", "configurations", "engineering", "options"],
    true,
  );
  const alias = doc.createAlias(original, "provider_options");
  doc.setIn(
    ["providers", "configurations", "alias_owner"],
    doc.createNode({
      package: "dbx",
      binding: "lakehouse",
      options: alias,
    }),
  );
  f.put("project.yaml", doc.toString());
  const before = readFileSync(resolve(f.root, "project.yaml"), "utf8");
  const outcome = execute({ root: f.root }, "provider_configuration_inspect", {
    configuration: "alias_owner",
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.diagnostics[0].code, "AUTHORING");
  assert.match(outcome.diagnostics[0].message, /alias/);
  assert.equal(readFileSync(resolve(f.root, "project.yaml"), "utf8"), before);
});

test("provider option review uses existing runtime-secret guards and never returns inline credentials", (t) => {
  const f = setup(t),
    manifest = parse(
      readFileSync(
        resolve(f.root, "fixture-origin/plugin/provider.yaml"),
        "utf8",
      ),
    );
  manifest.configurationSchema = { type: "object" };
  f.put("fixture-origin/plugin/provider.yaml", manifest);
  const initial = passed(inspect(f));
  const options = {
    ...initial.options,
    password: ["unsafe", "inline"].join("-"),
  };
  assert.equal(propose(f, options).diagnostics[0].code, "SECRET");
  const safe = {
    ...initial.options,
    password: { $secret: { env: "INGESTRON_SYNTHETIC_SECRET" } },
  };
  assert.equal(propose(f, safe).ok, true);
  f.project.providers.configurations.engineering.options = options;
  f.put("project.yaml", f.project);
  const denied = inspect(f);
  assert.equal(denied.ok, false);
  assert.equal(denied.diagnostics[0].code, "SECRET");
  assert.equal(denied.result, undefined);
});

test("nested local option references retain their owner, relative paths and neighbouring comments", (t) => {
  const f = setup(t);
  f.project.providers.configurations.engineering.options = {
    $resolve: "./settings/provider.yaml#/options",
  };
  f.put("project.yaml", f.project);
  f.put(
    "settings/provider.yaml",
    "# Keep wrapper\noptions:\n  timeout: 30 # keep scalar\n  scheduleInputs: { $resolve: ./inputs.yaml#/views }\n",
  );
  f.put(
    "settings/inputs.yaml",
    "# Keep supplier owners\nviews:\n  manual:\n    kind: azure-sql\n    linkedService: reviewed_manifest\n    schema: governance\n    view: manual_manifest # keep manual\nelsewhere: keep\n",
  );
  const before = readFileSync(
    resolve(f.root, "settings/provider.yaml"),
    "utf8",
  );
  const initial = passed(inspect(f));
  const proposal = passed(
    propose(f, {
      ...initial.options,
      scheduleInputs: { ...initial.options.scheduleInputs, source },
    }),
  );
  assert.equal(proposal.changes.length, 1);
  assert.equal(proposal.changes[0].path, "settings/inputs.yaml");
  assert.match(proposal.changes[0].after, /# keep manual/);
  passed(execute({ root: f.root, allowWrite: true }, "apply", { proposal }));
  assert.equal(
    readFileSync(resolve(f.root, "settings/provider.yaml"), "utf8"),
    before,
  );
  assert.deepEqual(passed(inspect(f)).options.scheduleInputs.source, source);
});
