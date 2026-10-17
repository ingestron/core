/** Offline settings validation shared by authoring, source access and preparation. */
import { Ajv2020 } from "ajv/dist/2020.js";
import { Configuration } from "./config.js";
import { check, isMap } from "./errors.js";
import type { Project } from "./schema.js";
import { validateSchemaShape } from "./provider-commands.js";

export function rejectConnectionEnvironment(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(rejectConnectionEnvironment);
  if (!isMap(value)) return;
  check(
    !Object.hasOwn(value, "$env"),
    "SECRET",
    "Use runtime $secret references, not compiler $env values, in connections",
  );
  Object.values(value).forEach(rejectConnectionEnvironment);
}

/** Return lookup names without reading a process environment or credential file. */
export function connectionSecretNames(value: unknown): Set<string> {
  const names = new Set<string>();
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!isMap(item)) return;
    if (Object.hasOwn(item, "$secret")) {
      const secret = item.$secret;
      check(
        Object.keys(item).length === 1 &&
          isMap(secret) &&
          Object.keys(secret).length === 1 &&
          typeof secret.env === "string" &&
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(secret.env) &&
          !/^(PYTHON|PIP|LD_|DYLD_|PATH$|HOME$|TMPDIR$)/i.test(secret.env),
        "SECRET",
        "Unsupported secret environment reference",
      );
      names.add(secret.env);
    } else Object.values(item).forEach(visit);
  };
  visit(value);
  return names;
}

export function resolveConnectionSettings(
  reader: Configuration,
  project: Project,
  environment: string,
  connection: Project["connections"][string],
  schema: unknown,
) {
  const profile = project.environments[environment];
  check(profile, "ENVIRONMENT", "Unknown selected environment");
  check(
    !profile.environment || profile.environment === environment,
    "ENVIRONMENT",
    "Environment name differs from selected profile",
  );
  const binding =
    connection.binding && !["native", "bridge"].includes(connection.route ?? "")
      ? profile.bindings[connection.binding]
      : {};
  check(binding, "CONNECTION", "Missing connection environment binding");
  let settings = {
    ...reader.resolveReferences(connection.settings),
    ...binding,
  };
  rejectConnectionEnvironment(settings);
  connectionSecretNames(settings);
  settings = reader.values(
    settings,
    {
      env: environment,
      project: { id: project.id },
      values: profile.values,
    },
    { allowEnvironment: false },
  );
  rejectConnectionEnvironment(settings);
  connectionSecretNames(settings);
  validateSchemaShape(schema);
  const ajv = new Ajv2020({ strict: true, validateFormats: false });
  check(
    ajv.validate(schema as object, settings),
    "CONNECTION",
    "Connection settings do not match the installed connector schema",
  );
  return settings;
}
