import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  lstatSync,
  realpathSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../../src/core/operations.js";
const target = {
  provider: "databricks",
  capabilities: { "unity-catalog": "enabled" },
  policies: { "owner-required": "enabled" },
  naming: { table: "{project}_{dataset}" },
  environments: [
    {
      name: "dev",
      purpose: "development",
      authentication: "oauth-m2m",
      configuration: { workspaceUrl: "https://example.azuredatabricks.net" },
      secrets: [
        { name: "DATABRICKS_CLIENT_SECRET", source: "local-env" },
        {
          name: "DB_PASSWORD",
          source: "databricks-scope",
          scope: "shared",
          key: "db-password",
        },
      ],
    },
  ],
};
const document = {
  apiVersion: "ingestron.programme/v1",
  id: "retail",
  name: "Retail",
  objective: "",
  sponsor: "ion",
  stakeholders: [],
  projects: [],
  requirements: [],
  platforms: [
    {
      id: "lakehouse",
      name: "Lakehouse",
      configuration: { targets: [target] },
    },
  ],
};
test("platform schema preserves provider-specific configuration and rejects unsafe or mismatched references", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "platform-schema-")));
  try {
    const save = (document: unknown) =>
      execute({ root, allowWrite: true }, "programme_save", {
        id: "retail",
        expectedDigest: null,
        document,
      });
    const modify = (change: (target: any) => void) => {
      const doc = structuredClone(document);
      change(doc.platforms[0]!.configuration.targets[0]);
      return doc;
    };
    for (const change of [
      (t: any) => (t.capabilities = { "fabric-items": "enabled" }),
      (t: any) => (t.naming = { table: "{unknown}" }),
      (t: any) =>
        (t.environments[0].configuration = { clientSecret: "sentinel" }),
      (t: any) =>
        (t.environments[0].configuration = {
          workspaceUrl: "https://user:secret@example.net",
        }),
      (t: any) => (t.environments[0].purpose = "production"),
      (t: any) =>
        (t.environments[0].secrets = [{ name: "PATH", source: "local-env" }]),
      (t: any) =>
        (t.environments[0].secrets = [
          {
            name: "KEY",
            source: "key-vault",
            vaultUrl: "http://localhost",
            secretName: "key",
          },
        ]),
      (t: any) =>
        (t.environments[0].secrets = [
          { name: "KEY", source: "local-env", value: "sentinel" },
        ]),
      (t: any) => t.environments.push(t.environments[0]),
    ])
      assert.equal(save(modify(change)).diagnostics[0]?.code, "SCHEMA");
    assert.equal(save(document).ok, true);
    assert.deepEqual(
      execute({ root }, "programme_read", { id: "retail" }).result.document,
      document,
    );
    const catalogue = execute({ root }, "programme_platform_catalogue", {
      id: "retail",
    }).result.catalogue;
    assert.deepEqual(
      catalogue.map((p: any) => p.id),
      ["fabric", "databricks", "adf"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("local environment secrets require write authority, stay out of documents and never return values", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "platform-secrets-")));
  const previous = process.env.INGESTRON_LOCAL_SECRETS_DIR;
  process.env.INGESTRON_LOCAL_SECRETS_DIR = join(root, "private");
  try {
    execute({ root, allowWrite: true }, "programme_save", {
      id: "retail",
      expectedDigest: null,
      document,
    });
    const context = {
      id: "retail",
      platform: "lakehouse",
      provider: "databricks",
      environment: "dev",
    };
    const input = {
      ...context,
      name: "DATABRICKS_CLIENT_SECRET",
      value: "synthetic-'$()`-value",
    };
    assert.equal(
      execute({ root }, "programme_secret_set", input).diagnostics[0]?.code,
      "PERMISSION",
    );
    assert.equal(
      execute({ root, allowWrite: true }, "programme_secret_set", {
        ...input,
        name: "UNDECLARED",
      }).diagnostics[0]?.code,
      "PERMISSION",
    );
    assert.equal(
      execute({ root, allowWrite: true }, "programme_secret_set", {
        ...input,
        environment: "prod",
      }).ok,
      false,
    );
    const result = execute(
      { root, allowWrite: true },
      "programme_secret_set",
      input,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(JSON.stringify(result).includes(input.value), false);
    assert.equal(result.result.secrets[0].stored, true);
    assert.equal(
      readFileSync(join(root, "programme.json"), "utf8").includes(input.value),
      false,
    );
    const namespace = readdirSync(join(root, "private"))[0]!;
    const file = join(root, "private", namespace, "local.env");
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
    assert.equal(
      lstatSync(join(root, "private", namespace)).mode & 0o777,
      0o700,
    );
    assert.equal(
      readFileSync(file, "utf8"),
      `DATABRICKS_CLIENT_SECRET='synthetic-'"'"'$()\u0060-value'\n`,
    );
    chmodSync(file, 0o644);
    assert.equal(
      execute({ root }, "programme_secret_status", context).diagnostics[0]
        ?.code,
      "PERMISSION",
    );
    chmodSync(file, 0o600);
    rmSync(file);
    symlinkSync(join(root, "programme.json"), file);
    assert.equal(
      execute({ root, allowWrite: true }, "programme_secret_set", input)
        .diagnostics[0]?.code,
      "PATH",
    );
    assert.equal(
      readFileSync(join(root, "programme.json"), "utf8").includes(input.value),
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.INGESTRON_LOCAL_SECRETS_DIR;
    else process.env.INGESTRON_LOCAL_SECRETS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
