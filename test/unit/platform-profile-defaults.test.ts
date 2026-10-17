import test from "node:test";
import assert from "node:assert/strict";
import { platformCatalogue } from "../../src/core/platform-catalogue.js";
import { platformTargetSchema } from "../../src/core/platform-schema.js";

test("all published profile parameter sets produce valid shared YAML definitions", () => {
  for (const p of platformCatalogue) {
    for (const workload of p.profileDefaults.workloads) {
      for (const naming of p.profileDefaults.naming) {
        const defaults = p.profileDefaults.governance;
        const target = platformTargetSchema.parse({
          provider: p.id,
          generation: { ...defaults.generation, ...workload.generation },
          capabilities: workload.capabilities,
          policies: defaults.policies,
          naming: naming.values,
          environments: [],
        });
        for (const [key, value] of Object.entries(target.generation ?? {})) {
          const choice = p.generation
            .find((f) => f.id === key)!
            .options.find((o) => o.id === value)!;
          if (choice.capability)
            assert.equal(target.capabilities[choice.capability], "enabled");
        }
        assert.equal(
          target.generation?.ingestion,
          undefined,
          "do not infer source connectivity",
        );
        assert.equal(
          target.generation?.changes,
          undefined,
          "do not infer delivery semantics",
        );
        assert.equal(
          target.capabilities.serverless,
          undefined,
          "do not infer tenant compute availability",
        );
      }
    }
  }
});
