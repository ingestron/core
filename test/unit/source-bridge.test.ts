import {
  readExecutionProfiles,
  reviewExecutionProfile,
} from "../../src/core/execution-profile-editor.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { fixture } from "../support/project.js";
import { installPackage } from "../../src/core/packages.js";
import { readFlowEditor } from "../../src/core/flow-editor.js";
import { isBridgePublisher } from "../../src/core/bridge-connections.js";
import { preview, apply, addFlow } from "../../src/core/authoring.js";
import {
  attachSourceBridge,
  sourceBridgeSchema,
} from "../../src/core/source-bridge.js";
function setup(t: any) {
  const f = fixture(t),
    origin = join(f.root, "fixture-origin"),
    file = join(origin, "plugin/provider.yaml");
  const m = parse(readFileSync(file, "utf8"));
  m.version = "1.0.1";
  m.compatibility.requiredFeatures = [
    "source-coverage",
    "native-project",
    "delivery-exports",
  ];
  m.capabilities = {
    artifactKinds: ["databricks"],
    delivery: true,
    handovers: ["files"],
    packContracts: {},
  };
  m.standards = [
    "snapshot-land@v1",
    "snapshot-publication@v1",
    "snapshot-with-history@v1",
  ].map((id) => ({ id, description: "Synthetic" }));
  m.sources = {
    "sql-server": {
      route: "native",
      standards: ["snapshot-land@v1"],
      capabilities: ["snapshot"],
      reference: {
        docs: "https://example.invalid",
        vendorStatus: "not-applicable",
        licence: "Synthetic",
        cost: { model: "none" },
        access: { model: "none" },
        network: ["local"],
        maturity: "preview",
        verified: "2026-10-11",
      },
      bindingSchema: {
        type: "object",
        required: ["linkedService"],
        properties: { linkedService: { type: "string" } },
        additionalProperties: false,
      },
      source: {
        kind: "sql-server",
        linkedService: "{{binding.linkedService}}",
      },
    },
  };
  writeFileSync(file, stringify(m));
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: origin, stdio: "pipe" });
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "bridge",
  );
  git("tag", "1.0.1");
  installPackage(f.root, "example/fixture@1.0.1", { fromGit: origin });
  f.project.providers.packages.dbx.version = "1.0.1";
  f.project.providers.configurations.landing = {
    package: "dbx",
    binding: "lakehouse",
  };
  f.project.connections = {
    metadata: {
      package: "dbx",
      sourceId: "source",
      tenantId: "retail",
      settings: {},
    },
  };
  f.put("project.yaml", f.project);
  const args = {
    id: "bridge",
    connection: "metadata",
    target: {
      provider: "engineering",
      ingestion: { standard: "snapshot-with-history@v1" },
    },
    bridge: {
      provider: "landing",
      kind: "sql-server",
      sourceBinding: { linkedService: "synthetic" },
      landing: {
        linkedService: "landing",
        fileSystem: "landing",
        path: "retail",
      },
      handoverBinding: { kind: "adls", accountName: "synthetic" },
      publication: {
        credential: {
          secretScope: "synthetic",
          tenantIdKey: "tenant-id",
          clientIdKey: "client-id",
          clientSecretKey: "client-secret",
        },
      },
      publisherOptions: {},
      frozenSource: true as const,
    },
  };
  const make = () => {
    const project = structuredClone(f.project);
    project.flows.push({ $resolve: "./flows/bridge/flow.yaml" });
    return preview(f.root, {
      "project.yaml": stringify(project),
      "flows/bridge/flow.yaml": stringify({
        apiVersion: "ingestron.flow/v1",
        kind: "ingestion",
        id: "bridge",
        provider: "engineering",
        defaults: { source: {} },
        ingestion: { standard: "snapshot-with-history@v1", pipeline: "bridge" },
        tables: {},
      }),
    });
  };
  return { ...f, args, make };
}
test("bridge review preserves source/configurations, scopes resources and rejects stale replay", (t) => {
  const f = setup(t),
    before = readFileSync(join(f.root, "project.yaml"), "utf8"),
    p = attachSourceBridge(f.root, "dev", f.args, f.make());
  assert.equal(readFileSync(join(f.root, "project.yaml"), "utf8"), before);
  const doc = parse(p.changes.find((c) => c.path === "project.yaml")!.after);
  assert.deepEqual(doc.connections.metadata, f.project.connections.metadata);
  assert.deepEqual(
    doc.providers.configurations.engineering,
    f.project.providers.configurations.engineering,
  );
  assert.equal(
    doc.connections.bridge_bridge.bridge.publisher,
    "bridge_publisher",
  );
  assert.equal(
    doc.environments.dev.bindings.bridge_source.linkedService,
    "synthetic",
  );
  const flow = parse(
    p.changes.find((c) => c.path === "flows/bridge/flow.yaml")!.after,
  );
  assert.equal(flow.ingestion.connection, "bridge_bridge");
  assert.equal(flow.defaults.source, undefined);
  apply(f.root, p);
  const publisher = readFlowEditor(f.root).providers.find(
    (p) => p.id === "bridge_publisher",
  )!;
  assert.equal(publisher.available, false);
  assert.equal(publisher.purpose, "bridge-publication");
  assert.deepEqual(publisher.kinds, []);
  assert.throws(
    () =>
      addFlow(f.root, {
        id: "bad_target",
        kind: "ingestion",
        provider: "bridge_publisher",
      }),
    /reserved for source handoff publication/,
  );
  const profiles = readExecutionProfiles(f.root, { flow: "source" });
  assert.ok(!profiles.providers.some((p) => p.id === "bridge_publisher"));
  assert.throws(
    () =>
      reviewExecutionProfile(f.root, {
        flow: "source",
        name: "bad",
        revision: profiles.revision,
        definition: {
          provider: "bridge_publisher",
          source: {},
          ingestion: {},
        } as any,
      }),
    /reserved for source handoff publication/,
  );
  assert.equal(isBridgePublisher(doc, "engineering"), false);
  assert.equal(
    isBridgePublisher({ ...doc, connections: {} }, "bridge_publisher"),
    false,
  );
  assert.throws(() => apply(f.root, p));
  assert.throws(
    () => attachSourceBridge(f.root, "dev", f.args, f.make()),
    /already exists/,
  );
});
test("bridge review denies missing consent, malformed native bindings and shared environment storage", (t) => {
  const f = setup(t);
  assert.equal(
    sourceBridgeSchema.safeParse({ ...f.args.bridge, frozenSource: false })
      .success,
    false,
  );
  assert.throws(
    () =>
      attachSourceBridge(
        f.root,
        "dev",
        { ...f.args, bridge: { ...f.args.bridge, sourceBinding: {} } },
        f.make(),
      ),
    /native source binding/,
  );
  assert.throws(
    () =>
      attachSourceBridge(
        f.root,
        "dev",
        {
          ...f.args,
          bridge: {
            ...f.args.bridge,
            publisherOptions: { password: "synthetic" },
          },
        },
        f.make(),
      ),
    /runtime/,
  );
  f.project.environments.test = {
    ...f.project.environments.dev,
    environment: "test",
    bindings: { $resolve: "./shared-bindings.yaml" },
  };
  f.project.environments.dev.bindings = { $resolve: "./shared-bindings.yaml" };
  f.put("shared-bindings.yaml", {});
  f.put("project.yaml", f.project);
  assert.throws(
    () => attachSourceBridge(f.root, "dev", f.args, f.make()),
    /share storage/,
  );
});
