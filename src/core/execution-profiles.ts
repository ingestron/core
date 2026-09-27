/** Execution bindings never duplicate or replace dataset identities/contracts. */
import { check } from "./errors.js";
import type { Flow } from "./schema.js";
export function bindExecutionProfile(flow: Flow, profile?: string): Flow {
  if (!profile) return flow;
  const binding = flow.executionProfiles[profile];
  check(binding, "PROFILE", `${flow.id}: unknown execution profile ${profile}`);
  check(
    flow.kind === "ingestion" && !flow.steps,
    "PROFILE",
    "Execution profiles currently support ingestion flows only",
  );
  check(
    !Object.hasOwn(binding.source, "schema") &&
      !Object.hasOwn(binding.source, "table"),
    "PROFILE",
    "Execution source bindings cannot replace dataset schema or table identity",
  );
  return {
    ...flow,
    provider: binding.provider,
    ingestion: binding.ingestion,
    defaults: { ...flow.defaults, source: binding.source },
  };
}
