/** Schema-driven portable connection authoring; source access is a separate operation. */
import { z } from "zod";
import { Configuration } from "./config.js";
import { projectSchema } from "./schema.js";
import { connectorPackageSchema } from "./connector-package.js";
import { projectPackages } from "./project-packages.js";
import {
  configuredPackageReference,
  resolvePackage,
  packageYaml,
} from "./packages.js";
import { addConnection, configureConnection } from "./authoring.js";
import { auditSecrets } from "./planner.js";
import {
  rejectConnectionEnvironment,
  connectionSecretNames,
  resolveConnectionSettings,
} from "./connection-settings.js";
import { check, digest, canonical } from "./errors.js";

const id = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/);
export const connectionEditorReadSchema = z
  .object({ package: id, connection: id.optional() })
  .strict();
export const connectionEditorReviewSchema = connectionEditorReadSchema
  .extend({
    id,
    sourceId: id,
    tenantId: id,
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    binding: id.optional(),
    values: z.record(
      z.string().regex(/^[a-f0-9]{64}$/),
      z.union([z.string().max(16000), z.number().finite(), z.boolean()]),
    ),
  })
  .strict();
type Field = {
  id: string;
  label: string;
  type: "string" | "number" | "boolean" | "secret" | "json";
  required: boolean;
  inherited: boolean;
  choices: string[];
  value: string | number | boolean;
};

function editor(
  root: string,
  environment: string,
  args: z.infer<typeof connectionEditorReadSchema>,
) {
  const reader = new Configuration(root, {}),
    project = reader.parse(projectSchema, reader.load());
  check(
    project.environments[environment],
    "ENVIRONMENT",
    "Choose a project environment",
  );
  const pkg = projectPackages(project)[args.package];
  check(pkg, "PACKAGE", "Choose a configured connector package");
  const locked = resolvePackage(root, configuredPackageReference(pkg));
  const manifest = connectorPackageSchema.parse(packageYaml(locked.file));
  check(
    manifest.upstream.licenceStatus === "evidenced",
    "LICENCE",
    "Connector licence evidence is unresolved",
  );
  const current = args.connection
    ? project.connections[args.connection]
    : undefined;
  check(
    !args.connection || current?.package === args.package,
    "CONNECTION",
    "Choose this connection's package",
  );
  check(
    !current || !["native", "bridge"].includes(current.route ?? ""),
    "CAPABILITY",
    "Native and bridge settings are owned by their target platform",
  );
  auditSecrets(current?.settings ?? {}, "settings");
  rejectConnectionEnvironment(current?.settings ?? {});
  connectionSecretNames(current?.settings ?? {});
  const resolvedSettings = current
    ? resolveConnectionSettings(reader, project, environment, current, {
        type: "object",
        additionalProperties: true,
      })
    : {};
  const fields: Field[] = [],
    paths = new Map<string, string[]>();
  function walk(schema: any, path: string[], required: boolean) {
    check(
      path.length <= 12 && fields.length < 100,
      "LIMIT",
      "Connection form exceeds supported bounds",
    );
    check(
      path.every(
        (key) => !["__proto__", "prototype", "constructor"].includes(key),
      ),
      "KEY",
      "Unsafe connection field",
    );
    if (
      schema.type === "object" &&
      schema.properties &&
      !schema.properties.$secret
    ) {
      for (const [name, child] of Object.entries(schema.properties))
        walk(
          child,
          [...path, name],
          required && (schema.required ?? []).includes(name),
        );
      return;
    }
    check(
      path.length > 0,
      "CAPABILITY",
      "Connector requires a structured settings schema",
    );
    const fieldId = digest(canonical(path));
    paths.set(fieldId, path);
    const value = path.reduce(
      (value: any, key) => value?.[key],
      resolvedSettings,
    );
    const type: Field["type"] = schema.properties?.$secret
      ? "secret"
      : schema.type === "integer" || schema.type === "number"
        ? "number"
        : schema.type === "boolean"
          ? "boolean"
          : schema.type === "string"
            ? "string"
            : "json";
    fields.push({
      id: fieldId,
      label: path
        .map((name) =>
          name.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " "),
        )
        .join(" / "),
      type,
      required,
      inherited:
        !!current?.binding &&
        Object.hasOwn(
          project.environments[environment].bindings[current.binding] ?? {},
          path[0],
        ),
      choices: Array.isArray(schema.enum)
        ? schema.enum.filter((v: unknown) => typeof v === "string")
        : [],
      value:
        type === "secret"
          ? (value?.$secret?.env ?? "")
          : type === "json"
            ? value === undefined
              ? ""
              : JSON.stringify(value, null, 2)
            : (value ?? (type === "boolean" ? false : "")),
    });
  }
  walk(manifest.definition.settingsSchema, [], true);
  return {
    reader,
    project,
    current,
    fields,
    paths,
    revision: digest(
      canonical({
        files: reader.files,
        package: locked.entry.commit,
        manifest,
        environment,
        current: current ?? null,
      }),
    ),
    connector: manifest.connector,
    actions: manifest.sourceAccess?.actions ?? [],
  };
}
export function readConnectionEditor(
  root: string,
  environment: string,
  args: z.infer<typeof connectionEditorReadSchema>,
) {
  const e = editor(root, environment, args);
  return {
    apiVersion: "ingestron.connection-editor/v1",
    package: args.package,
    connection: args.connection ?? "",
    revision: e.revision,
    sourceId: e.current?.sourceId ?? "",
    tenantId: e.current?.tenantId ?? e.project.id,
    binding: e.current?.binding ?? "",
    connector: e.connector,
    actions: e.actions,
    fields: e.fields,
  };
}
export function reviewConnectionEditor(
  root: string,
  environment: string,
  args: z.infer<typeof connectionEditorReviewSchema>,
) {
  const e = editor(root, environment, args);
  check(
    e.revision === args.revision,
    "STALE",
    "Connection or package changed; reopen the form",
  );
  check(
    !args.connection || args.id === args.connection,
    "OWNER",
    "Connection identity cannot be renamed",
  );
  // A review includes project.yaml, so inspect sibling definitions too.
  auditSecrets(e.project.connections, "connections");
  auditSecrets(e.project.environments, "environments");
  const settings = structuredClone(e.current?.settings ?? {});
  for (const [key, supplied] of Object.entries(args.values)) {
    const field = e.fields.find((f) => f.id === key),
      path = e.paths.get(key);
    check(field && path, "AUTHORING", "Unknown connection field");
    check(
      !field.inherited || supplied === field.value,
      "OWNER",
      "Edit inherited values in the environment binding",
    );
    if (field.inherited) continue;
    let value: unknown = supplied;
    if (field.type === "secret") {
      check(
        typeof supplied === "string" &&
          (!supplied || /^[A-Za-z_][A-Za-z0-9_]*$/.test(supplied)),
        "SECRET",
        "Enter a secret environment variable name, not its value",
      );
      value = supplied ? { $secret: { env: supplied } } : undefined;
    } else if (field.type === "json") {
      check(
        typeof supplied === "string",
        "INPUT",
        "Enter valid structured settings",
      );
      try {
        value = supplied ? JSON.parse(supplied) : undefined;
      } catch {
        check(false, "INPUT", "Invalid JSON setting");
      }
    } else if (field.type === "number") {
      check(
        supplied === "" || typeof supplied === "number",
        "INPUT",
        "Enter a numeric setting",
      );
    } else
      check(typeof supplied === field.type, "INPUT", "Invalid setting type");
    check(
      !field.required || (value !== undefined && value !== ""),
      "INPUT",
      "Complete required connection fields",
    );
    let target: any = settings;
    for (const part of path.slice(0, -1)) target = target[part] ??= {};
    if (value === undefined || (value === "" && !field.required))
      delete target[path.at(-1)!];
    else target[path.at(-1)!] = value;
  }
  auditSecrets(settings, "settings");
  rejectConnectionEnvironment(settings);
  connectionSecretNames(settings);
  return args.connection
    ? configureConnection(
        root,
        {
          id: args.id,
          sourceId: args.sourceId,
          tenantId: args.tenantId,
          settings,
        },
        environment,
      )
    : addConnection(
        root,
        {
          id: args.id,
          package: args.package,
          sourceId: args.sourceId,
          tenantId: args.tenantId,
          ...(args.binding ? { binding: args.binding } : {}),
          settings,
        },
        environment,
      );
}
