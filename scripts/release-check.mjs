import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url)),
);
assert.equal(pkg.name, "@ingestron-io/core");
assert.equal(pkg.license, "UNLICENSED");
assert.equal(pkg.publishConfig.access, "restricted");
if (process.argv.includes("--publish"))
  throw new Error(
    "Publication held: confirm licensor, complete rights review and activate the exact release",
  );
console.log(
  "Core candidate metadata checked; no publication authorised by this check",
);
