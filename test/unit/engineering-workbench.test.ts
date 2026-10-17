import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../support/project.js";
import { inspectEngineering } from "../../src/core/engineering-workbench.js";

test("engineering inventory preserves inspectable outputs when provider coverage is unavailable", (t) => {
  const f = fixture(t);
  f.project.defaults.provider = "missing-target";
  f.project.connections = {
    warehouse: {
      route: "native",
      kind: "sql-server",
      sourceId: "warehouse",
      tenantId: "synthetic",
      settings: {
        password: { $secret: "do-not-return" },
        host: "private-host",
      },
    },
  };
  f.put("project.yaml", f.project);
  const before = readFileSync(join(f.root, "project.yaml"), "utf8");
  const value = inspectEngineering(f.root, "dev");
  assert.equal(value.evidence, "offline");
  assert.equal(value.outputs.length, 2);
  assert.equal(value.connections[0].id, "warehouse");
  assert.equal(value.connections[0].route, "native");
  assert.equal(JSON.stringify(value).includes("do-not-return"), false);
  assert.equal(JSON.stringify(value).includes("private-host"), false);
  assert.equal(readFileSync(join(f.root, "project.yaml"), "utf8"), before);
  assert.ok(value.outputs.every((o) => o.fields === 2 && o.contract));
  assert.equal(value.quality.complete, false);
  assert.ok(value.issues.some((i) => i.area === "quality"));
  assert.throws(() => inspectEngineering(f.root, "unknown"));
});
