import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { fixture } from "../support/project.js";
import { execute } from "../../src/core/operations.js";
import { apply } from "../../src/core/authoring.js";
import {
  readExecutionProfiles,
  reviewExecutionProfile,
} from "../../src/core/execution-profile-editor.js";
const binding = (f: any) => ({
  provider: "engineering",
  ingestion: f.flow.ingestion,
  source: f.flow.defaults.source,
});
test("profile authoring creates, edits and removes only execution bindings while preserving contracts", (t) => {
  const f = fixture(t),
    file = join(f.root, "flows/source/flow.yaml"),
    original = readFileSync(file, "utf8"),
    before = parse(original);
  const read = () => readExecutionProfiles(f.root, { flow: "source" });
  let snapshot = read();
  assert.equal(
    execute({ root: f.root }, "flow_profiles_read", { flow: "source" }).ok,
    true,
  );
  const create = reviewExecutionProfile(f.root, {
    flow: "source",
    name: "local_test",
    revision: snapshot.revision,
    definition: binding(f),
  });
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(
    execute({ root: f.root }, "flow_profiles_review", {
      flow: "source",
      name: "local_test",
      revision: snapshot.revision,
      definition: binding(f),
    }).ok,
    true,
  );
  apply(f.root, create);
  assert.deepEqual(read().profiles.local_test, binding(f));
  assert.deepEqual(parse(readFileSync(file, "utf8")).tables, before.tables);
  snapshot = read();
  const edit = reviewExecutionProfile(f.root, {
    flow: "source",
    name: "local_test",
    revision: snapshot.revision,
    definition: {
      ...binding(f),
      source: { ...binding(f).source, linkedService: "alternate" },
    },
  });
  apply(f.root, edit);
  assert.equal(read().profiles.local_test.source.linkedService, "alternate");
  const remove = reviewExecutionProfile(f.root, {
    flow: "source",
    name: "local_test",
    revision: read().revision,
    definition: null,
  });
  apply(f.root, remove);
  assert.deepEqual(read().profiles, {});
  assert.deepEqual(parse(readFileSync(file, "utf8")).tables, before.tables);
  assert.deepEqual(
    parse(readFileSync(file, "utf8")).ingestion,
    before.ingestion,
  );
});
test("profile authoring rejects stale review, missing providers/connections and dataset identity replacement", (t) => {
  const f = fixture(t),
    snapshot = readExecutionProfiles(f.root, { flow: "source" }),
    base = { flow: "source", name: "alternate", revision: snapshot.revision };
  for (const definition of [
    { ...binding(f), provider: "missing" },
    { ...binding(f), ingestion: { connection: "missing" } },
    { ...binding(f), source: { schema: "replacement" } },
    { ...binding(f), source: { table: "replacement" } },
  ])
    assert.throws(() =>
      reviewExecutionProfile(f.root, { ...base, definition }),
    );
  const proposal = reviewExecutionProfile(f.root, {
    ...base,
    definition: binding(f),
  });
  f.flow.description = "Concurrent edit";
  f.put("flows/source/flow.yaml", f.flow);
  assert.throws(
    () => reviewExecutionProfile(f.root, { ...base, definition: binding(f) }),
    /changed/,
  );
  assert.throws(() => apply(f.root, proposal), /changed/);
  assert.equal(
    execute({ root: f.root }, "flow_profiles_review", {
      ...base,
      definition: { ...binding(f), tables: {} },
    }).ok,
    false,
  );
});
test("referenced profile editing preserves its reference and removal keeps the separate owned file", (t) => {
  const f = fixture(t);
  f.flow.executionProfiles = { alternate: { $resolve: "./alternate.yaml" } };
  f.put("flows/source/alternate.yaml", binding(f));
  f.put("flows/source/flow.yaml", f.flow);
  const snapshot = readExecutionProfiles(f.root, { flow: "source" }),
    proposal = reviewExecutionProfile(f.root, {
      flow: "source",
      name: "alternate",
      revision: snapshot.revision,
      definition: {
        ...binding(f),
        source: { kind: "azure-sql", linkedService: "reviewed" },
      },
    });
  assert.deepEqual(
    proposal.changes.map((c) => c.path),
    ["flows/source/alternate.yaml"],
  );
  apply(f.root, proposal);
  const owner = readFileSync(
    join(f.root, "flows/source/alternate.yaml"),
    "utf8",
  );
  assert.ok(
    parse(readFileSync(join(f.root, "flows/source/flow.yaml"), "utf8"))
      .executionProfiles.alternate.$resolve,
  );
  apply(
    f.root,
    reviewExecutionProfile(f.root, {
      flow: "source",
      name: "alternate",
      revision: readExecutionProfiles(f.root, { flow: "source" }).revision,
      definition: null,
    }),
  );
  assert.equal(
    readFileSync(join(f.root, "flows/source/alternate.yaml"), "utf8"),
    owner,
  );
});
