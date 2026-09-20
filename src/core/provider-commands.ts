import { reportPackSchema } from "./report-pack-schema.js";
import { validateModelPack } from "./model-pack-schema.js";
/** Provider-owned offline operations. No target access, shell, or filesystem guest APIs. */
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Configuration } from "./config.js";
import { projectSchema } from "./schema.js";
import { canonical, check, digest } from "./errors.js";
import {
  canonicalPackageReference,
  fence,
  packageYaml,
  providerPackageSchema,
  resolvePackage,
} from "./packages.js";
import { executeProvider } from "../plugins/provider-renderer.js";
import { checkProviderCompatibility } from "../plugins/compatibility.js";

// No references, regular expressions or schema code: validation itself must be bounded.
export function validateSchemaShape(schema: unknown) {
  let nodes = 0;
  const allowed = new Set([
    "type",
    "oneOf",
    "properties",
    "items",
    "required",
    "additionalProperties",
    "enum",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
  ]);
  const walk = (value: any, depth = 0) => {
    check(
      ++nodes <= 1000 &&
        depth <= 20 &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value),
      "PACKAGE",
      "Command schema exceeds supported bounds",
    );
    for (const key of Object.keys(value))
      check(
        allowed.has(key),
        "PACKAGE",
        `Unsupported command schema keyword ${key}`,
      );
    if (value.properties)
      for (const child of Object.values(value.properties))
        walk(child, depth + 1);
    if (value.items) walk(value.items, depth + 1);
    if (value.oneOf !== undefined) {
      check(
        Array.isArray(value.oneOf) &&
          value.oneOf.length >= 2 &&
          value.oneOf.length <= 4,
        "PACKAGE",
        "oneOf requires 2–4 bounded alternatives",
      );
      for (const child of value.oneOf) walk(child, depth + 1);
    }
    if (
      value.additionalProperties &&
      typeof value.additionalProperties === "object"
    )
      walk(value.additionalProperties, depth + 1);
    check(
      value.additionalProperties === undefined ||
        (value.additionalProperties &&
          typeof value.additionalProperties === "object") ||
        typeof value.additionalProperties === "boolean",
      "PACKAGE",
      "additionalProperties must be boolean",
    );
  };
  check(
    JSON.stringify(schema).length <= 64000,
    "PACKAGE",
    "Command schema exceeds 64 KB",
  );
  walk(schema);
}
function selected(root: string, environment: string, configuration: string) {
  const reader = new Configuration(root);
  const project = reader.parse(projectSchema, reader.load());
  check(
    project.environments[environment],
    "ENVIRONMENT",
    `Unknown environment ${environment}`,
  );
  const configured = project.providers.configurations[configuration];
  check(
    configured,
    "PROVIDER",
    `Unknown provider configuration ${configuration}`,
  );
  const pkg = project.providers.packages[configured.package];
  check(
    pkg && !pkg.source.startsWith("builtin:") && !pkg.source.startsWith("."),
    "PACKAGE",
    "Provider commands require an installed locked provider",
  );
  const reference = canonicalPackageReference(`${pkg.source}@${pkg.version}`);
  const source = resolvePackage(reader.root, reference);
  const manifest = providerPackageSchema.parse(packageYaml(source.file));
  checkProviderCompatibility(manifest);
  check(
    manifest.commands,
    "PROVIDER",
    "This provider version does not declare commands",
  );
  return {
    reader,
    project,
    source,
    manifest,
    reference,
    configuration,
    environment,
  };
}
export function providerCommands(
  root: string,
  environment: string,
  configuration: string,
) {
  const s = selected(root, environment, configuration);
  return {
    apiVersion: "ingestron.provider-command-catalogue/v1",
    configuration,
    environment,
    provider: s.manifest.id,
    version: s.manifest.version,
    reference: s.reference,
    commit: s.source.entry.commit,
    execution: s.manifest.commands!.execution,
    commands: s.manifest.commands!.definitions,
  };
}
export function runProviderCommand(
  root: string,
  environment: string,
  args: {
    configuration: string;
    command: string;
    input: Record<string, unknown>;
  },
) {
  const s = selected(root, environment, args.configuration),
    commands = s.manifest.commands!;
  const definition = commands.definitions.find((c) => c.name === args.command);
  check(
    definition,
    "PROVIDER",
    `Unknown provider command ${args.command}; list providers commands ${args.configuration}`,
  );
  check(
    Buffer.byteLength(JSON.stringify(args.input)) <=
      (s.manifest.projectAssembly?.command === args.command
        ? 7_000_000
        : 2_000_000),
    "LIMIT",
    "Command input exceeds its bounded transport limit",
  );
  const ajv = new Ajv2020({
    strict: true,
    allErrors: false,
    validateFormats: false,
  });
  validateSchemaShape(definition.inputSchema);
  const validate = ajv.compile(definition.inputSchema);
  check(
    validate(args.input),
    "INPUT",
    `Invalid provider command input: ${ajv.errorsText(validate.errors)}`,
  );
  const module = fence(
    s.source.root,
    relative(s.source.root, resolve(dirname(s.source.file), commands.module)),
  );
  check(
    Object.hasOwn(s.source.entry.files, relative(s.source.root, module)),
    "PACKAGE",
    "Command module is not in the locked inventory",
  );
  let input = args.input;
  let reportLock: Record<string, unknown> | undefined;
  if (definition.reportPack) {
    check(
      typeof input.reportPack === "string",
      "REPORT_PACK",
      "Select an exact installed report pack",
    );
    const packSource = resolvePackage(
      s.reader.root,
      input.reportPack as string,
    );
    const pack = reportPackSchema.parse(packageYaml(packSource.file));
    check(
      pack.platform === s.manifest.platform,
      "REPORT_PACK",
      "Report pack/platform mismatch",
    );
    const modelSource = resolvePackage(s.reader.root, pack.model);
    const model = validateModelPack(packageYaml(modelSource.file));
    reportLock = {
      reference: input.reportPack,
      commit: packSource.entry.commit,
      model: pack.model,
      modelCommit: modelSource.entry.commit,
    };
    input = { ...input, reportPack: pack, modelPack: model, reportLock };
  }
  const request = {
    apiVersion: "ingestron.provider-command-request/v1",
    command: args.command,
    context: {
      project: s.project.id,
      environment,
      configuration: args.configuration,
      provider: s.manifest.id,
      version: s.manifest.version,
      commit: s.source.entry.commit,
    },
    input,
  };
  const result = executeProvider(
    readFileSync(module, "utf8"),
    request,
    false,
    "command",
  );
  return {
    apiVersion: "ingestron.provider-command-result/v1",
    ...request.context,
    command: args.command,
    execution: "offline-json",
    inputDigest: digest(canonical(input)),
    ...(reportLock ? { reportLock } : {}),
    result,
  };
}
