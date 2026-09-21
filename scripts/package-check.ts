import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const temporary = mkdtempSync(resolve(tmpdir(), "ingestron-core-installed-"));
try {
  const pack = resolve(temporary, "pack");
  mkdirSync(pack);
  execFileSync("pnpm", ["pack", "--pack-destination", pack], { stdio: "pipe" });
  const archive = resolve(
    pack,
    readdirSync(pack).find((n) => n.endsWith(".tgz"))!,
  );
  const inventory = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
  });
  assert.doesNotMatch(inventory, /package\/dist\/(cli|mcp)\//);
  assert.doesNotMatch(
    inventory,
    /package\/(src|test|scripts|docs|catalogue|licensing|node_modules)\//,
  );
  assert.doesNotMatch(inventory, /dist\/assets\/catalogue/);
  for (const path of inventory.trim().split("\n"))
    assert.match(
      path,
      /^package\/(?:dist\/(?:core\/|plugins\/|sdk\/|assets\/schemas\/|version\.(?:js|d\.ts)$|compiler-fingerprint\.json$)|(?:package\.json|README\.md|SECURITY\.md|LICENSE|NOTICE|THIRD_PARTY_NOTICES\.md)$)/,
    );
  assert.match(inventory, /dist\/assets\/schemas\/ODCS-LICENSE/);
  writeFileSync(
    resolve(temporary, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      packageManager: "pnpm@10.15.0",
    }),
  );
  execFileSync("pnpm", ["add", "--ignore-scripts", archive], {
    cwd: temporary,
    stdio: "pipe",
    timeout: 60000,
  });
  const script = `
    import assert from "node:assert/strict";
    import { existsSync } from "node:fs";
    import { executeAsync } from "@ingestron/core";
    import { validateDocument } from "@ingestron/core/schemas";
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    assert.throws(() => require.resolve("@ingestron/core/dist/core/operations.js"), {code: "ERR_PACKAGE_PATH_NOT_EXPORTED"});
    const result = await executeAsync({root: process.cwd(), allowWrite: false, allowNetwork: false, allowExecute: false}, "initialise", {id: "example"});
    assert.equal(result.ok, true, "initialise returns a proposal");
    assert.equal(existsSync("project.yaml"), false, "proposal must not write");
    const denied = await executeAsync({root: process.cwd(), allowWrite: false}, "apply", {proposal: result.result});
    assert.equal(denied.diagnostics[0].code, "PERMISSION");
    const applied = await executeAsync({root: process.cwd(), allowWrite: true}, "apply", {proposal: result.result});
    assert.equal(applied.ok, true);
    assert.equal((await executeAsync({root:process.cwd()}, "validate", {mode:"draft"})).ok, true);
    assert.deepEqual((await executeAsync({root:process.cwd()}, "plugin_browse")).result, []);
    assert.equal(validateDocument({kind: "environment", uri: "untitled:1", content: "apiVersion: ingestron.environment/v1"}).valid, true);
    const catalogue = await executeAsync({root: process.cwd()}, "catalogue", {kind: "standards"});
    assert.equal(catalogue.apiVersion, "ingestron.operation/v1");
    process.stdout.write("Installed core exports and permission boundary passed\\n");
  `;
  writeFileSync(resolve(temporary, "check.mjs"), script);
  process.stdout.write(
    execFileSync(process.execPath, ["check.mjs"], {
      cwd: temporary,
      encoding: "utf8",
    }),
  );
  writeFileSync(
    resolve(temporary, "quickstart.mjs"),
    readFileSync("examples/quickstart.mjs", "utf8"),
  );
  process.stdout.write(
    execFileSync(process.execPath, ["quickstart.mjs"], {
      cwd: temporary,
      encoding: "utf8",
    }),
  );
  // The editor import must work even when loading any Node built-in is forbidden.
  writeFileSync(
    resolve(temporary, "editor-loader.mjs"),
    `export async function resolve(specifier, context, next) { if (specifier.startsWith("node:")) throw new Error("Editor imported Node runtime: " + specifier); return next(specifier, context); }`,
  );
  writeFileSync(
    resolve(temporary, "editor.mjs"),
    `import {validateDocument} from "@ingestron/core/schemas"; if (!validateDocument({kind:"environment",uri:"untitled:1",content:"apiVersion: ingestron.environment/v1"}).valid) throw new Error("Invalid editor result");`,
  );
  execFileSync(
    process.execPath,
    ["--no-warnings", "--loader", "./editor-loader.mjs", "editor.mjs"],
    { cwd: temporary, stdio: "pipe" },
  );
  console.log(
    "Installed editor export loads without Node runtime dependencies",
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
