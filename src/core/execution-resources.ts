/** Providers name physical resources; core validates and hashes their opaque identities. */
import { z } from "zod";
import { canonical, check, digest, Problem } from "./errors.js";
import { runProviderCommand } from "./provider-commands.js";
const flowId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const declaration = z
  .object({
    apiVersion: z.literal("ingestron.execution-resources/v1"),
    flows: z
      .array(
        z
          .object({
            flow: flowId,
            resources: z
              .array(
                z
                  .object({
                    namespace: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
                    identity: z
                      .string()
                      .min(1)
                      .max(4096)
                      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
                  })
                  .strict(),
              )
              .min(1)
              .max(128),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export function resolveResourceDeclaration(value: unknown, selected: string[]) {
  const parsed = declaration.safeParse(value);
  check(
    parsed.success,
    "EXECUTION_RESOURCES",
    "Invalid provider execution resource declaration",
  );
  const data = parsed.data!;
  check(
    new Set(data.flows.map((row) => row.flow)).size === data.flows.length &&
      canonical(data.flows.map((row) => row.flow).sort()) ===
        canonical([...selected].sort()),
    "EXECUTION_RESOURCES",
    "Provider resource declaration must cover exactly the selected flows",
  );
  const flows = data.flows
    .map((row) => {
      const resources = row.resources.map((resource) =>
        digest(
          canonical({
            apiVersion: "ingestron.physical-resource/v1",
            namespace: resource.namespace,
            identity: resource.identity,
          }),
        ),
      );
      check(
        new Set(resources).size === resources.length,
        "EXECUTION_RESOURCES",
        "Duplicate provider execution resource identity",
      );
      return { flow: row.flow, resources: resources.sort() };
    })
    .sort((a, b) => a.flow.localeCompare(b.flow));
  const resources = [...new Set(flows.flatMap((row) => row.resources))].sort();
  check(
    resources.length <= 500,
    "EXECUTION_RESOURCES",
    "Provider execution resource inventory exceeds limit",
  );
  return { coverage: "provider-declared" as const, flows, resources };
}
export function executionResources(
  root: string,
  environment: string,
  pkg: { configuration: string },
  capability: { resources?: { command: string } },
  packageRoot: string,
  selected: string[],
) {
  if (!capability.resources) {
    const flows = [...selected].sort().map((flow) => ({
      flow,
      resources: [digest(canonical({ root, environment, flow }))],
    }));
    return {
      coverage: "legacy-flow" as const,
      flows,
      resources: flows.flatMap((row) => row.resources).sort(),
    };
  }
  // Never expose a provider's raw identity or validation values in jobs/receipts.
  let result: unknown;
  try {
    result = runProviderCommand(root, environment, {
      configuration: pkg.configuration,
      command: capability.resources.command,
      input: { packageRoot, flows: selected },
    }).result;
  } catch {
    throw new Problem(
      "EXECUTION_RESOURCES",
      "Provider execution resource inspection failed; inspect the locked provider and rebuild",
    );
  }
  return resolveResourceDeclaration(result, selected);
}
