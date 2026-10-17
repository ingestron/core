import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { programmeSchema } from "../../src/core/programme-schema.js";
import { execute } from "../../src/core/operations.js";
const environment = {
  name: "dev",
  purpose: "development",
  authentication: "azure-cli",
  configuration: {},
  secrets: [],
};
const target = (provider: string) => ({
  provider,
  capabilities: {},
  policies: {},
  naming: {},
  environments: [
    {
      ...environment,
      authentication: provider == "databricks" ? "databricks-cli" : "azure-cli",
    },
  ],
});
const fixture = () => ({
  apiVersion: "ingestron.programme/v1",
  id: "retail",
  name: "Retail",
  objective: "",
  sponsor: "ion",
  stakeholders: [],
  requirements: [],
  projects: [
    {
      id: "orders",
      name: "Orders",
      platformId: "shared",
      targets: [
        { provider: "adf", responsibilities: ["ingestion"] },
        {
          provider: "databricks",
          responsibilities: ["transformation", "presentation"],
        },
      ],
    },
  ],
  platforms: [
    {
      id: "shared",
      name: "Shared",
      configuration: {
        environments: [{ name: "dev", purpose: "development" }],
        targets: [target("adf"), target("databricks")],
      },
    },
  ],
});
test("multi-target assignments and common environments persist through operations", () => {
  const root = mkdtempSync(join(tmpdir(), "programme-targets-"));
  try {
    const document = fixture();
    const save = execute({ root, allowWrite: true }, "programme_save", {
      id: "retail",
      expectedDigest: null,
      document,
    });
    assert.equal(save.ok, true, JSON.stringify(save));
    const read = execute({ root }, "programme_read", { id: "retail" });
    assert.deepEqual(read.result.document.projects, document.projects);
    assert.deepEqual(read.result.document.platforms, document.platforms);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("reject dangling, duplicate, unknown targets and mismatched environment purpose", () => {
  const changes = [
    (d: ReturnType<typeof fixture>) => {
      d.projects[0]!.targets[0]!.provider = "fabric";
    },
    (d: ReturnType<typeof fixture>) => {
      d.projects[0]!.targets.push(d.projects[0]!.targets[0]!);
    },
    (d: ReturnType<typeof fixture>) => {
      d.projects[0]!.targets[0]!.responsibilities = ["ingestion", "ingestion"];
    },
    (d: ReturnType<typeof fixture>) => {
      d.projects[0]!.targets[0]!.responsibilities = ["unknown"];
    },
    (d: ReturnType<typeof fixture>) => {
      d.platforms[0]!.configuration.environments[0]!.purpose = "production";
    },
    (d: ReturnType<typeof fixture>) => {
      d.platforms[0]!.configuration.environments.push({
        name: "dev",
        purpose: "development",
      });
    },
  ];
  for (const change of changes) {
    const d = fixture();
    change(d);
    assert.equal(programmeSchema.safeParse(d).success, false);
  }
  const old = {
    ...fixture(),
    projects: [{ id: "old", name: "Old" }],
    platforms: [],
  };
  assert.equal(programmeSchema.safeParse(old).success, true);
});
