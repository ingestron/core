import { deliveryExports } from "../core/delivery-exports.js";
import { Ajv } from "ajv";
import { executeProvider } from "./provider-renderer.js";
import { contractColumns } from "../core/contracts.js";
import { check } from "../core/errors.js";
import { Configuration } from "../core/config.js";
import type { Plan } from "../core/schema.js";
import { stringify } from "yaml";
function guestPlan(plan: Plan) {
  const needed = new Set(
    plan.nodes
      .flatMap((n) => [n.generation?.codeRef, n.generation?.runtimeRef])
      .filter(Boolean),
  );
  return {
    ...plan,
    activitySources: Object.fromEntries(
      Object.entries(plan.activitySources).filter(([ref]) => needed.has(ref)),
    ),
  };
}
export function validateProviderPlan(plan: Plan) {
  if (plan.selection.delivery) {
    for (const entry of deliveryExports(plan)) validateProviderPlan(entry.plan);
    return;
  }
  const renderer = plan.nodes[0]?.runtime?.rendererRef;
  check(
    renderer && plan.nodes.every((n) => n.runtime?.rendererRef === renderer),
    "PROVIDER",
    "An export must select one provider renderer",
  );
  executeProvider(
    plan.activitySources[renderer],
    {
      ...guestPlan(plan),
      nodes: plan.nodes.map((n) => ({
        ...n,
        columns: n.contract ? contractColumns(n.contract) : [],
        sql: "",
      })),
    },
    true,
  );
}
export function generateProvider(
  root: string,
  plan: Plan,
): Record<string, string> {
  if (plan.selection.delivery) {
    const files: Record<string, string> = {};
    let count = 0,
      bytes = 0;
    const add = (name: string, content: string) => {
      count++;
      bytes += Buffer.byteLength(content);
      check(
        count <= 10000 && bytes <= 10 * 1024 * 1024,
        "LIMIT",
        "Delivery exceeds 10000 files or 10 MiB",
      );
      files[name] = content;
    };
    const exports = deliveryExports(plan);
    for (const entry of exports)
      for (const [name, content] of Object.entries(
        generateProvider(root, entry.plan),
      ))
        add(`${entry.directory}/${name}`, content);
    add(
      "ingestron-delivery.json",
      JSON.stringify(
        {
          apiVersion: "ingestron.delivery/v1",
          project: plan.project,
          environment: plan.environment,
          planDigest: plan.digest,
          evidence: "offline",
          execution: "not-run",
          exports: exports.map(({ plan: part, ...entry }) => ({
            ...entry,
            planDigest: part.digest,
            nodes: part.nodes.map((n) => n.id),
          })),
        },
        null,
        2,
      ) + "\n",
    );
    return files;
  }
  validateProviderPlan(plan);
  const reader = new Configuration(root);
  const request = {
    ...guestPlan(plan),
    nodes: plan.nodes.map((n) => ({
      ...n,
      columns: n.contract ? contractColumns(n.contract) : [],
      sql: n.with.sqlFile ? reader.text(n.with.sqlFile) : undefined,
      sqlFile: n.with.sqlFile,
    })),
  };
  const assets = executeProvider(
    plan.activitySources[plan.nodes[0].runtime!.rendererRef!],
    request,
  );
  const files = Object.fromEntries(
    Object.entries(assets).map(([name, a]) => [
      name,
      a.format === "json"
        ? JSON.stringify(a.value, null, 2) + "\n"
        : a.format === "yaml"
          ? stringify(a.value)
          : (a.value as string),
    ]),
  );
  const hooks = [
    ...new Set(plan.nodes.map((n) => n.runtime?.lifecycleRef).filter(Boolean)),
  ] as string[];
  for (const ref of hooks) {
    const node = plan.nodes.find((n) => n.runtime?.lifecycleRef === ref)!;
    const schemas = node.runtime?.outputSchemasRef
      ? JSON.parse(plan.activitySources[node.runtime.outputSchemasRef])
      : {};
    validateProviderFiles(plan.activitySources[ref], schemas, files);
  }

  return files;
}

/** The same provider schema gate applies after native rendering and project assembly. */
export function validateProviderFiles(
  code: string,
  schemas: Record<string, string>,
  files: Record<string, string>,
) {
  const response: any = executeProvider(
    code,
    { apiVersion: "ingestron.provider-output/v1", files },
    false,
    "validateOutput",
  );
  check(
    Array.isArray(response.documents) && response.documents.length <= 100,
    "PROVIDER",
    "Invalid output validation response",
  );
  const ajv = new Ajv({ allErrors: true, strict: false });
  for (const doc of response.documents) {
    check(
      typeof schemas[doc.schema] === "string",
      "PROVIDER",
      "Undeclared output schema",
    );
    const validate = ajv.compile(JSON.parse(schemas[doc.schema]));
    check(
      validate(doc.value),
      "PROVIDER",
      `Provider output schema: ${ajv.errorsText(validate.errors)}`,
    );
  }
}
