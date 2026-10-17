/** Schema-driven portable connection authoring; source access is a separate operation. */
import { z } from "zod";
import { parseDocument } from "yaml";
import { relative } from "node:path";
import { Configuration } from "./config.js";
import { projectSchema } from "./schema.js";
import { connectorPackageSchema } from "./connector-package.js";
import { projectPackages } from "./project-packages.js";
import {
  configuredPackageReference,
  resolvePackage,
  packageYaml,
} from "./packages.js";
import {
  addConnection,
  configureConnection,
  preview,
  validateAuthoredConnection,
  type Proposal,
} from "./authoring.js";
import { auditSecrets } from "./planner.js";
import {
  rejectConnectionEnvironment,
  connectionSecretNames,
  resolveConnectionSettings,
} from "./connection-settings.js";
import { check, digest, canonical } from "./errors.js";

const ownBinding = (id: string) => `source_${id}_${digest(id).slice(0, 8)}`;
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
    environmentSecrets: z.boolean().optional(),
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
  when?: { field: string; equals: string }[];
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
  const unions: string[][] = [];
  const fieldKey = (
    path: string[],
    when: { field: string; equals: string }[],
  ) => digest(canonical(when.length ? { path, when } : path));
  function walk(
    schema: any,
    path: string[],
    required: boolean,
    when: { field: string; equals: string }[] = [],
  ) {
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
    if (Array.isArray(schema.oneOf)) {
      const branches = schema.oneOf;
      const discriminator = Object.keys(branches[0]?.properties ?? {}).find(
        (key) =>
          branches.every(
            (b: any) =>
              b.type === "object" &&
              b.required?.includes(key) &&
              b.properties?.[key]?.type === "string" &&
              b.properties[key].enum?.length === 1,
          ),
      );
      if (discriminator) {
        const choices = branches.map(
          (b: any) => b.properties[discriminator].enum[0],
        );
        check(
          new Set(choices).size === choices.length,
          "CAPABILITY",
          "Ambiguous authentication choices",
        );
        unions.push(path);
        const selectorPath = [...path, discriminator];
        walk({ type: "string", enum: choices }, selectorPath, required, when);
        for (const branch of branches)
          for (const [key, child] of Object.entries(branch.properties))
            if (key !== discriminator)
              walk(
                child,
                [...path, key],
                required && branch.required.includes(key),
                [
                  ...when,
                  {
                    field: fieldKey(selectorPath, when),
                    equals: branch.properties[discriminator].enum[0],
                  },
                ],
              );
        return;
      }
    }
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
          when,
        );
      return;
    }
    check(
      path.length > 0,
      "CAPABILITY",
      "Connector requires a structured settings schema",
    );
    const fieldId = fieldKey(path, when);
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
      ...(when.length ? { when } : {}),
      inherited:
        !!current?.binding &&
        (current.binding !== ownBinding(args.connection!) ||
          Object.values(project.connections).some(
            (c) => c !== current && c.binding === current.binding,
          )) &&
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
    resolvedSettings,
    fields,
    paths,
    unions,
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
  const settings = structuredClone(
    e.current?.binding === ownBinding(args.id)
      ? e.resolvedSettings
      : (e.current?.settings ?? {}),
  ) as Record<string, unknown>;
  // Rebuild discriminated objects so changing auth never retains credentials from
  // the old alternative. Inherited objects remain owned by their binding.
  for (const path of e.unions) {
    const owned = e.fields.some(
      (f) =>
        !f.inherited &&
        e.paths.get(f.id)?.slice(0, path.length).join("/") === path.join("/"),
    );
    if (!owned) continue;
    let target: any = settings;
    for (const part of path.slice(0, -1)) target = target[part] ??= {};
    target[path.at(-1)!] = {};
  }
  const submitted = {
    ...Object.fromEntries(e.fields.map((f) => [f.id, f.value])),
    ...args.values,
  };
  for (const [key, supplied] of Object.entries(submitted)) {
    const field = e.fields.find((f) => f.id === key),
      path = e.paths.get(key);
    check(field && path, "AUTHORING", "Unknown connection field");
    check(
      !field.inherited || supplied === field.value,
      "OWNER",
      "Edit inherited values in the environment binding",
    );
    if (
      field.inherited ||
      field.when?.some((c) => submitted[c.field] !== c.equals)
    )
      continue;
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
  const proposal = args.connection
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
  return args.environmentSecrets
    ? environmentSecretReferences(
        root,
        environment,
        args.id,
        proposal,
        e.reader,
        e.project,
        e.current,
      )
    : proposal;
}

/** Keep each connection's settings and secret references in its selected environment.
 * On first conversion, preserve other environments using the previous settings.
 * Existing shared bindings remain owned by their own editor. */
function environmentSecretReferences(
  root: string,
  environment: string,
  connection: string,
  proposal: Proposal,
  reader: Configuration,
  project: any,
  current: any,
) {
  const binding = ownBinding(connection);
  if (current?.binding && current.binding !== binding) return proposal;
  const replacements = Object.fromEntries(
    proposal.changes.map((c) => [c.path, c.after]),
  );
  const projectDoc = parseDocument(
    replacements["project.yaml"] ?? reader.text("project.yaml"),
  );
  const docs = new Map<string, ReturnType<typeof parseDocument>>([
    ["project.yaml", projectDoc],
  ]);
  const next = structuredClone(project);
  const settings = projectDoc.toJS().connections[connection].settings;
  if (!connectionSecretNames(settings).size && !current?.binding)
    return proposal;
  check(
    !Object.entries(project.connections).some(
      ([id, c]: [string, any]) => id !== connection && c.binding === binding,
    ),
    "OWNER",
    "Connection binding is shared; edit it through environment settings",
  );
  for (const env of Object.keys(project.environments)) {
    const existing = project.environments[env].bindings[binding];
    check(
      existing === undefined || current?.binding === binding,
      "OWNER",
      "Environment binding already exists",
    );
    if (env !== environment && current?.binding === binding) continue;
    const value =
      env === environment ? settings : structuredClone(current?.settings ?? {});
    const ref = projectDoc.toJS().environments[env];
    const file = ref?.$resolve
      ? relative(reader.root, reader.path(ref.$resolve))
      : "project.yaml";
    let doc = docs.get(file);
    if (!doc) {
      doc = parseDocument(reader.text(file));
      docs.set(file, doc);
    }
    check(!doc.errors.length, "YAML", "Invalid environment file");
    doc.setIn(
      ref?.$resolve
        ? ["bindings", binding]
        : ["environments", env, "bindings", binding],
      value,
    );
    next.environments[env].bindings[binding] = value;
  }
  projectDoc.setIn(["connections", connection, "binding"], binding);
  projectDoc.setIn(["connections", connection, "settings"], {});
  const nextConnection = projectDoc.toJS().connections[connection];
  validateAuthoredConnection(reader, next, environment, nextConnection);
  for (const [file, doc] of docs) replacements[file] = doc.toString();
  return preview(root, replacements, { ...proposal.inputs, ...reader.files });
}
