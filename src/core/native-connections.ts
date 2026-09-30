/** Native connection routes (PB-064 phase 2).
 *
 * A connection with `route: native` is read by the provider's own platform
 * connector. The provider's `sources[kind]` declaration names the ingestion
 * standards that implement it, a JSON Schema for the environment binding, and a
 * source template. Core rewrites the connection flow into an ordinary native
 * ingestion flow, so planning, generation and ownership checks are unchanged.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import { check, isMap } from "./errors.js";
import { validateSchemaShape } from "./provider-commands.js";

export type ConnectionRoute = "portable" | "native";

/** The route a flow's connection uses, or undefined for other flows. */
export function connectionRoute(
  project: { connections?: Record<string, any> },
  flow: { ingestion?: { connection?: unknown } },
): ConnectionRoute | undefined {
  if (!flow.ingestion?.connection) return undefined;
  const connection = project.connections?.[String(flow.ingestion.connection)];
  return connection?.route === "native" ? "native" : "portable";
}

/** Flows whose connection uses the portable connector runtime. */
export const isPortableConnection = (project: any, flow: any) =>
  connectionRoute(project, flow) === "portable";

function render(
  value: unknown,
  values: Record<string, any>,
  label: string,
): unknown {
  if (Array.isArray(value)) return value.map((v) => render(v, values, label));
  if (isMap(value))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, render(v, values, label)]),
    );
  if (typeof value !== "string") return value;
  const whole = /^{{\s*(binding|connection)\.([\w.]+)\s*}}$/.exec(value);
  const lookup = (scope: string, path: string) => {
    const found = path
      .split(".")
      .reduce((v: any, key) => (isMap(v) ? v[key] : undefined), values[scope]);
    check(
      found !== undefined,
      "CONNECTION",
      `${label}: the environment binding does not supply ${scope}.${path}`,
    );
    return found;
  };
  // A whole-value placeholder keeps its type (numbers, secret references).
  if (whole) return lookup(whole[1], whole[2]);
  return value.replace(
    /{{\s*(binding|connection)\.([\w.]+)\s*}}/g,
    (_, scope, path) => String(lookup(scope, path)),
  );
}

/** Rewrite a native connection flow into the provider's ingestion standard. */
export function nativeConnectionFlow<F extends Record<string, any>>(
  flow: F,
  input: {
    connectionName: string;
    connection: Record<string, any>;
    binding: unknown;
    configuration: string;
    sources?: Record<string, any>;
  },
): F {
  const { connection, configuration } = input;
  const kind = String(connection.kind);
  const declared = input.sources?.[kind];
  check(
    declared?.source && declared.bindingSchema,
    "CAPABILITY",
    `${flow.id}: provider configuration ${configuration} has no native route for ${kind}; use a portable connector or another provider`,
  );
  const {
    connection: _c,
    requires,
    execution,
    timeoutSeconds,
    ...ingestion
  } = flow.ingestion ?? {};
  check(
    execution === undefined && timeoutSeconds === undefined,
    "CONNECTION",
    `${flow.id}: execution and timeoutSeconds apply to portable connectors; a native route runs on the platform`,
  );
  check(
    typeof ingestion.standard === "string" &&
      declared.standards.includes(ingestion.standard),
    "CONNECTION",
    `${flow.id}: choose ingestion.standard from ${declared.standards.join(", ")} for the native ${kind} route`,
  );
  const unsupported = ((requires as string[] | undefined) ?? []).filter(
    (c) => !declared.capabilities.includes(c),
  );
  check(
    !unsupported.length,
    "CAPABILITY",
    `${flow.id}: the native ${kind} route on ${configuration} cannot supply ${unsupported.join(", ")}`,
  );
  check(
    isMap(input.binding),
    "CONNECTION",
    `${flow.id}: connection ${input.connectionName} needs an environment binding for its native route`,
  );
  validateSchemaShape(declared.bindingSchema);
  const ajv = new Ajv2020({ strict: true, validateFormats: false });
  const valid = ajv.compile(declared.bindingSchema);
  check(
    valid(input.binding),
    "CONNECTION",
    `${flow.id}: binding for connection ${input.connectionName}: ${ajv.errorsText(valid.errors)}`,
  );
  const source = render(
    declared.source,
    {
      binding: input.binding,
      connection: {
        sourceId: connection.sourceId,
        tenantId: connection.tenantId,
        // The environment binding name, for providers that reference bindings.
        ...(connection.binding ? { binding: connection.binding } : {}),
        ...(connection.settings ?? {}),
      },
    },
    `${flow.id}: native ${kind} source`,
  ) as Record<string, unknown>;
  return {
    ...flow,
    ingestion,
    defaults: {
      ...(flow.defaults ?? {}),
      source: { ...source, ...(flow.defaults?.source ?? {}) },
    },
  };
}
