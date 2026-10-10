import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { fixture } from "../support/project.js";
import { digest } from "../../src/core/errors.js";
import { installPackage } from "../../src/core/packages.js";
import { execute } from "../../src/core/operations.js";
import { programmeSchema } from "../../src/core/programme-schema.js";
const ok = (r: any) => {
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  return r.result;
};
function setup(t: any) {
  const owner = fixture(t),
    consumer = fixture(t),
    origin = resolve(owner.root, "shared-origin");
  const asset = JSON.stringify({ "runtime.py": "# synthetic, not executed" });
  const object = (properties: any) => ({
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  owner.put("shared-origin/connector.yaml", {
    apiVersion: "ingestron.connector/v1",
    id: "shared-source",
    version: "1.0.0",
    description: "Synthetic connector",
    connector: "example:db@1.0.0",
    documentation: "https://example.invalid",
    upstream: {
      ecosystem: "singer",
      variant: "synthetic",
      package: "synthetic",
      version: "1.0.0",
      repository: "https://example.invalid",
      licence: "LicenseRef-Synthetic",
      licenceFile: "licence.txt",
      licenceStatus: "evidenced",
    },
    runtime: {
      path: "runtime.json",
      sha256: digest(asset),
      contract: "ingestron.snapshot/python/v1",
    },
    definition: {
      settingsSchema: object({
        host: { type: "string" },
        password: object({ $secret: object({ env: { type: "string" } }) }),
      }),
      selectionSchema: { type: "object", additionalProperties: true },
    },
    execution: { test: { modes: ["local"], evidence: "synthetic" } },
  });
  owner.put("shared-origin/runtime.json", asset);
  owner.put("shared-origin/licence.txt", "Synthetic only");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: origin, stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "shared fixture",
  );
  git("tag", "v1.0.0");
  const reference = "example/shared/connector.yaml@1.0.0";
  for (const f of [owner, consumer]) {
    installPackage(f.root, reference, { fromGit: origin });
    f.project.packages = { source: reference };
    f.project.environments.test = {
      ...structuredClone(f.project.environments.dev),
      environment: "test",
    };
  }
  owner.project.connections = {
    sales: {
      package: "source",
      sourceId: "erp",
      tenantId: "nz",
      binding: "sales",
      settings: {},
    },
  };
  for (const environment of ["dev", "test"])
    owner.project.environments[environment].bindings.sales = {
      host: environment + ".synthetic.invalid",
      password: { $secret: { env: "SALES_PASSWORD" } },
    };
  consumer.project.id = "warehouse";
  owner.put("project.yaml", owner.project);
  consumer.put("project.yaml", consumer.project);
  const document = {
    apiVersion: "ingestron.programme/v1",
    id: "retail",
    name: "Retail",
    objective: "",
    sponsor: "Owner",
    stakeholders: [],
    requirements: [],
    platforms: [{ id: "shared", name: "Shared" }],
    projects: [
      {
        id: "owner-plan",
        compilerId: "retail",
        name: "Owner",
        platformId: "shared",
      },
      {
        id: "consumer-plan",
        compilerId: "warehouse",
        name: "Consumer",
        platformId: "shared",
      },
      { id: "outsider", name: "Outside" },
    ],
  };
  owner.put("programme/programme.json", JSON.stringify(document, null, 2));
  const programme = { id: "retail", root: resolve(owner.root, "programme") };
  const common = { programme, project: "owner-plan", platform: "shared" };
  const promote = {
    ...common,
    kind: "connection",
    id: "erp",
    name: "ERP",
    owner: "Platform owner",
    purpose: "Synthetic reuse",
    consumers: ["owner-plan", "consumer-plan"],
    connection: "sales",
    sharedEnvironment: "dev",
  };
  const ownerCtx = { root: owner.root, environment: "dev", allowWrite: true },
    consumerCtx = { root: consumer.root, environment: "dev", allowWrite: true };
  const save = (args: any, ctx = ownerCtx) => {
    const review = ok(execute(ctx, "platform_reuse_review", args));
    return ok(execute(ctx, "platform_reuse_apply", { programme, review }));
  };
  return {
    owner,
    consumer,
    programme,
    common,
    promote,
    reference,
    document,
    ownerCtx,
    consumerCtx,
    save,
  };
}
test("shared package and connection definitions preserve owner and explicit platform consumers", (t) => {
  const f = setup(t);
  const args = {
    ...f.common,
    kind: "package",
    id: "source",
    name: "Source",
    owner: "Platform owner",
    purpose: "Reviewed connector",
    consumers: ["consumer-plan"],
    reference: f.reference,
  };
  const review = ok(execute(f.ownerCtx, "platform_reuse_review", args));
  assert.ok(review.files.some((v: any) => v.path === "programme.json"));
  assert.equal(
    execute({ ...f.ownerCtx, allowWrite: false }, "platform_reuse_apply", {
      programme: f.programme,
      review,
    }).diagnostics[0].code,
    "PERMISSION",
  );
  ok(
    execute(f.ownerCtx, "platform_reuse_apply", {
      programme: f.programme,
      review,
    }),
  );
  f.save(f.promote);
  const list = ok(
    execute(f.consumerCtx, "platform_reuse_read", {
      ...f.common,
      project: "consumer-plan",
    }),
  );
  assert.equal(list.packages[0].installed, true);
  assert.equal(list.packages[0].permitted, true);
  assert.deepEqual(list.connections[0].environments, [
    { name: "dev", secretNames: ["SALES_PASSWORD"] },
  ]);
  assert.equal(Object.hasOwn(list.connections[0], "settings"), false);
  assert.equal(
    execute(f.ownerCtx, "platform_reuse_review", {
      ...f.promote,
      id: "bad",
      consumers: ["outsider"],
    }).ok,
    false,
  );
});
test("two project environments consume shared settings without changing the platform or sibling resources", (t) => {
  const f = setup(t);
  f.save(f.promote);
  f.save(
    { ...f.promote, update: true, sharedEnvironment: "test" },
    { ...f.ownerCtx, environment: "test" },
  );
  const programmeBefore = readFileSync(
    resolve(f.programme.root, "programme.json"),
    "utf8",
  );
  const ownerBefore = readFileSync(
    resolve(f.owner.root, "project.yaml"),
    "utf8",
  );
  const args = {
    ...f.common,
    project: "consumer-plan",
    sharedConnection: "erp",
    sharedEnvironment: "dev",
    connection: "shared_sales",
  };
  for (const environment of ["dev", "test"]) {
    const ctx = { ...f.consumerCtx, environment };
    const review = ok(
      execute(ctx, "shared_connection_review", {
        ...args,
        sharedEnvironment: environment,
      }),
    );
    ok(
      execute(ctx, "shared_connection_apply", {
        programme: f.programme,
        review,
      }),
    );
  }
  const project = parse(
    readFileSync(resolve(f.consumer.root, "project.yaml"), "utf8"),
  );
  assert.equal(
    project.environments.dev.bindings.shared_sales_shared.host,
    "dev.synthetic.invalid",
  );
  assert.equal(
    project.environments.test.bindings.shared_sales_shared.host,
    "test.synthetic.invalid",
  );
  assert.deepEqual(
    project.environments.dev.bindings.lakehouse,
    f.consumer.project.environments.dev.bindings.lakehouse,
  );
  assert.deepEqual(
    project.environments.dev.bindings.shared_sales_shared.password,
    { $secret: { env: "SALES_PASSWORD" } },
  );
  assert.equal(
    readFileSync(resolve(f.programme.root, "programme.json"), "utf8"),
    programmeBefore,
  );
  assert.equal(
    readFileSync(resolve(f.owner.root, "project.yaml"), "utf8"),
    ownerBefore,
  );
  const list = ok(
    execute(f.consumerCtx, "platform_reuse_read", {
      ...f.common,
      project: "consumer-plan",
    }),
  );
  assert.equal(list.bindings.length, 2);
  assert.ok(list.bindings.every((b: any) => b.intact && !b.stale));
  project.environments.dev.bindings.shared_sales_shared.host =
    "locally.changed.invalid";
  f.consumer.put("project.yaml", project);
  const changed = ok(
    execute(f.consumerCtx, "platform_reuse_read", {
      ...f.common,
      project: "consumer-plan",
    }),
  );
  assert.equal(changed.bindings[0].intact, false);
  assert.equal(
    execute(f.consumerCtx, "shared_connection_review", args).diagnostics[0]
      .code,
    "OWNER",
  );
});
test("shared connection rejects changed reviews, denied consumers and unsafe settings", (t) => {
  const f = setup(t);
  f.save(f.promote);
  const args = {
    ...f.common,
    project: "consumer-plan",
    sharedConnection: "erp",
    sharedEnvironment: "dev",
    connection: "shared_sales",
  };
  const review = ok(execute(f.consumerCtx, "shared_connection_review", args));
  f.save({ ...f.promote, update: true, name: "New label" });
  assert.equal(
    execute(f.consumerCtx, "shared_connection_apply", {
      programme: f.programme,
      review,
    }).diagnostics[0].code,
    "STALE",
  );
  f.save({ ...f.promote, update: true, consumers: ["owner-plan"] });
  assert.equal(
    execute(f.consumerCtx, "shared_connection_review", args).diagnostics[0]
      .code,
    "CONSUMER",
  );
  // Direct schema validation also rejects credentials inserted by a hand-edited programme.
  const current = JSON.parse(
    readFileSync(resolve(f.programme.root, "programme.json"), "utf8"),
  );
  current.platforms[0].reuse.connections[0].environments.dev.settings.password =
    "synthetic-inline-value";
  assert.equal(programmeSchema.safeParse(current).success, false);
});

test("shared definitions survive split YAML and stale project reviews cannot write", (t) => {
  const f = setup(t);
  f.save(f.promote);
  const programmeCtx = { root: f.programme.root, allowWrite: true };
  const proposal = ok(
    execute(programmeCtx, "programme_migration_review", {
      id: "retail",
      direction: "to-yaml",
    }),
  );
  ok(
    execute(programmeCtx, "programme_migration_apply", {
      id: "retail",
      proposal,
    }),
  );
  f.save({ ...f.promote, update: true, purpose: "Retained in YAML" });
  const args = {
    ...f.common,
    project: "consumer-plan",
    sharedConnection: "erp",
    sharedEnvironment: "dev",
    connection: "shared_sales",
  };
  const review = ok(execute(f.consumerCtx, "shared_connection_review", args));
  f.consumer.project.environments.dev.values.newValue = "Changed after review";
  f.consumer.put("project.yaml", f.consumer.project);
  assert.equal(
    execute(f.consumerCtx, "shared_connection_apply", {
      programme: f.programme,
      review,
    }).diagnostics[0].code,
    "STALE",
  );
  const fresh = ok(execute(f.consumerCtx, "shared_connection_review", args));
  ok(
    execute(f.consumerCtx, "shared_connection_apply", {
      programme: f.programme,
      review: fresh,
    }),
  );
  const list = ok(
    execute(f.consumerCtx, "platform_reuse_read", {
      ...f.common,
      project: "consumer-plan",
    }),
  );
  assert.equal(list.connections[0].purpose, "Retained in YAML");
  assert.equal(list.bindings[0].intact, true);
});
