import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const pkg = JSON.parse(read("../package.json"));
assert.equal(pkg.name, "@ingestron/core");
assert.equal(pkg.license, "Apache-2.0");
assert.equal(pkg.publishConfig.access, "public");
assert.equal(pkg.publishConfig.registry, "https://registry.npmjs.org/");
assert.equal(pkg.repository.url, "git+https://github.com/ingestron/core.git");
assert.ok(!pkg.private);
assert.match(read("../LICENSE"), /Apache License[\s\S]*Version 2.0/);
assert.match(read("../NOTICE"), /Licensor: Otrera Limited/);
const inventory = JSON.parse(read("../licensing/dependency-inventory.json"));
assert.ok(
  inventory.packages.every((entry) => !entry.reviewRequired),
  "Resolve missing dependency notices before release",
);
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
console.log(
  `${pkg.name}@${pkg.version}: public Apache release metadata and dependency notices checked`,
);
