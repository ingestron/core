import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { fixture } from "../support/project.js";
import { execute } from "../../src/core/operations.js";
const ok = (r: any) => {
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  return r.result;
};
test("reviewed provider installation is isolated, pinned and rejects changed inputs or forged content", (t) => {
  const f = fixture(t),
    origin = join(f.root, "fixture-origin"),
    file = join(origin, "plugin/provider.yaml");
  const manifest = parse(readFileSync(file, "utf8"));
  manifest.version = "1.1.0";
  manifest.compatibility.requiredFeatures = ["programme-platform-binding"];
  manifest.platformBinding = {
    apiVersion: "ingestron.platform-binding-authoring/v1",
    resourcesSchema: {
      type: "object",
      properties: { catalog: { type: "string" } },
    },
  };
  writeFileSync(file, stringify(manifest));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: origin, encoding: "utf8" });
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "guided provider",
  );
  const commit = git("rev-parse", "HEAD").trim(),
    ctx = { root: f.root },
    args = {
      reference: `example/fixture@${commit}`,
      fromGit: "fixture-origin",
    };
  const before = readFileSync(join(f.root, "packages.lock.yaml"), "utf8"),
    files = readdirSync(f.root);
  const reviewed = ok(execute(ctx, "provider_install_review", args));
  assert.equal(
    readFileSync(join(f.root, "packages.lock.yaml"), "utf8"),
    before,
  );
  assert.deepEqual(readdirSync(f.root), files);
  assert.ok(reviewed.proposal.reference.endsWith(commit));
  const apply = { proposal: reviewed.proposal, fromGit: "fixture-origin" };
  assert.equal(execute(ctx, "provider_install_apply", apply).ok, false);
  assert.equal(
    execute({ ...ctx, allowWrite: true }, "provider_install_apply", {
      ...apply,
      proposal: { ...apply.proposal, packageDigest: "0".repeat(64) },
    }).ok,
    false,
  );
  assert.equal(
    readFileSync(join(f.root, "packages.lock.yaml"), "utf8"),
    before,
  );
  ok(execute({ ...ctx, allowWrite: true }, "provider_install_apply", apply));
  assert.equal(
    execute({ ...ctx, allowWrite: true }, "provider_install_apply", apply).ok,
    false,
  );
  const fresh = ok(execute(ctx, "provider_install_review", args));
  f.put("project.yaml", {
    ...f.project,
    defaults: { ...f.project.defaults, test: "changed" },
  });
  assert.equal(
    execute({ ...ctx, allowWrite: true }, "provider_install_apply", {
      proposal: fresh.proposal,
      fromGit: "fixture-origin",
    }).ok,
    false,
  );
});
test("target setup adds reviewed responsibilities and an empty shared profile without replacing shared values", (t) => {
  const f = fixture(t),
    programme = { id: "retail", root: join(f.root, "programme") };
  const doc: any = {
    apiVersion: "ingestron.programme/v1",
    id: "retail",
    name: "Retail",
    objective: "Decisions",
    sponsor: "Owner",
    stakeholders: [],
    requirements: [],
    projects: [
      {
        id: "sales",
        compilerId: "retail",
        name: "Sales",
        platformId: "shared",
      },
      {
        id: "other",
        compilerId: "inventory",
        name: "Inventory",
        platformId: "shared",
      },
    ],
    platforms: [
      {
        id: "shared",
        name: "Shared",
        configuration: {
          environments: [
            { name: "dev", purpose: "development" },
            { name: "prod", purpose: "production" },
          ],
          targets: [
            {
              provider: "databricks",
              capabilities: {},
              policies: {},
              naming: {},
              environments: [
                {
                  name: "prod",
                  purpose: "production",
                  authentication: "databricks-cli",
                  configuration: { catalog: "preserve" },
                  secrets: [],
                },
              ],
            },
          ],
        },
      },
    ],
  };
  f.put("programme/programme.json", JSON.stringify(doc));
  const input = {
    programme,
    project: "sales",
    target: "databricks",
    sharedEnvironment: "dev",
    responsibilities: ["ingestion"],
    authentication: "databricks-cli",
  };
  const before = readFileSync(join(programme.root, "programme.json"), "utf8");
  const review = ok(execute({ root: f.root }, "target_setup_review", input));
  assert.equal(
    readFileSync(join(programme.root, "programme.json"), "utf8"),
    before,
  );
  const request = { input: review.input, review: review.review };
  assert.equal(
    execute({ root: f.root }, "target_setup_apply", request).ok,
    false,
  );
  ok(
    execute({ root: f.root, allowWrite: true }, "target_setup_apply", request),
  );
  const saved = ok(
    execute({ root: programme.root }, "programme_read", { id: programme.id }),
  ).document;
  assert.equal(
    saved.platforms[0].configuration.targets[0].environments[0].configuration
      .catalog,
    "preserve",
  );
  assert.deepEqual(saved.projects[1], doc.projects[1]);
  assert.equal(
    execute({ root: f.root, allowWrite: true }, "target_setup_apply", request)
      .ok,
    false,
  );
  const next = ok(
    execute({ root: f.root }, "target_setup_review", {
      ...input,
      responsibilities: ["transformation"],
    }),
  );
  assert.deepEqual(next.summary.responsibilities, [
    "ingestion",
    "transformation",
  ]);
  assert.equal(next.summary.profile, "preserved");
  assert.equal(
    execute({ root: f.root }, "target_setup_review", {
      ...input,
      project: "other",
    }).ok,
    false,
  );
  assert.equal(
    execute({ root: f.root }, "target_setup_review", {
      ...input,
      authentication: "azure-cli",
    }).ok,
    true,
  ); // Existing authentication is preserved, not replaced.
});
