import { auditSecrets } from "./planner.js";
/** Offline review of provider-owned options. Schema and semantics stay in the installed provider. */
import { dirname, relative, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Configuration } from "./config.js";
import { canonical, check, digest, isMap } from "./errors.js";
import { projectSchema } from "./schema.js";
import { projectPackages } from "./project-packages.js";
import {
  configuredPackageReference,
  fence,
  packageYaml,
  providerPackageSchema,
  resolvePackage,
} from "./packages.js";
import { checkProviderCompatibility } from "../plugins/compatibility.js";
import {
  configureProviderOptions,
  providerOptionsDefinition,
} from "./authoring.js";

function selected(root: string, environment: string, configuration: string) {
  const reader = new Configuration(root, {}),
    project = reader.parse(projectSchema, reader.load());
  check(
    project.environments[environment],
    "ENVIRONMENT",
    "Choose an existing environment",
  );
  const configured = project.providers.configurations[configuration];
  check(configured, "PROVIDER", "Choose an existing provider configuration");
  const pkg = projectPackages(project)[configured.package];
  check(
    pkg && !pkg.source.startsWith("builtin:"),
    "PACKAGE",
    "Choose a configured provider package",
  );
  const reference = configuredPackageReference(pkg),
    source = pkg.source.startsWith(".")
      ? { file: reader.path(pkg.source), root: reader.root }
      : resolvePackage(reader.root, reference);
  const manifest = providerPackageSchema.parse(packageYaml(source.file));
  checkProviderCompatibility(manifest);
  check(
    pkg.version === "v1" ||
      pkg.version === manifest.version ||
      /^[a-f0-9]{40}$/.test(pkg.version),
    "PACKAGE",
    "Provider manifest version differs from its selector",
  );
  reader.text(source.file);
  const schema =
    typeof manifest.configurationSchema === "string"
      ? JSON.parse(
          reader.text(
            fence(
              source.root,
              relative(
                source.root,
                resolve(dirname(source.file), manifest.configurationSchema),
              ),
            ),
          ),
        )
      : (manifest.configurationSchema ?? null);
  check(
    schema === null ||
      (isMap(schema) &&
        Buffer.byteLength(JSON.stringify(schema)) <= 1024 * 1024),
    "LIMIT",
    "Provider configuration schema exceeds inspection limits",
  );
  const definition = providerOptionsDefinition(root, configuration);
  check(
    canonical(definition.options) === canonical(configured.options),
    "STALE",
    "Provider options changed while their definition was read",
  );
  const affectedFlows = project.flows
    .filter((flow: any) => isMap(flow) && typeof flow.id === "string")
    .map((flow: any) => ({
      id: flow.id,
      default: (flow.provider ?? project.defaults.provider) === configuration,
      profiles: Object.entries<any>(flow.executionProfiles ?? {})
        .filter(([, profile]) => profile.provider === configuration)
        .map(([name]) => name)
        .sort(),
    }))
    .filter((flow) => flow.default || flow.profiles.length)
    .sort((a, b) => a.id.localeCompare(b.id));
  auditSecrets(configured.options, "provider." + configuration);
  const options = structuredClone(configured.options);
  return {
    reader,
    configured,
    reference,
    manifest,
    schema,
    definition,
    options,
    affectedFlows,
    digest: digest(canonical({ configuration, configured, reference, schema })),
  };
}
function validate(schema: unknown, options: unknown) {
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    useDefaults: false,
  });
  (addFormats as any)(ajv);
  const validator = ajv.compile(schema as object);
  const valid = validator(options);
  return {
    valid,
    diagnostics: valid
      ? []
      : [
          {
            code: "PROVIDER",
            message: "Provider options: " + ajv.errorsText(validator.errors),
          },
        ],
  };
}
export function inspectProviderConfiguration(
  root: string,
  environment: string,
  configuration: string,
) {
  const s = selected(root, environment, configuration);
  return {
    apiVersion: "ingestron.provider-configuration/v1",
    configuration,
    provider: s.manifest.id,
    version: s.manifest.version,
    reference: s.reference,
    binding: s.configured.binding,
    available: s.schema !== null,
    schema: s.schema,
    options: s.options,
    digest: s.digest,
    definition: { path: s.definition.path, pointer: s.definition.pointer },
    affectedFlows: s.affectedFlows,
    ...(s.schema
      ? validate(s.schema, s.options)
      : { valid: false, diagnostics: [] }),
    executionEnabled: false,
  };
}
export function proposeProviderConfiguration(
  root: string,
  environment: string,
  args: {
    configuration: string;
    options: Record<string, unknown>;
    expectedDigest: string;
  },
) {
  const s = selected(root, environment, args.configuration);
  check(
    s.schema,
    "PROVIDER",
    "This provider does not declare a configuration schema",
  );
  check(
    s.digest === args.expectedDigest,
    "STALE",
    "Provider configuration changed; inspect it again before reviewing options",
  );
  // Resolve local references under the normal project fences, without reading environment values.
  const options = s.reader.resolveReferences(args.options, s.definition.path);
  check(isMap(options), "PROVIDER", "Provider options must be an object");
  auditSecrets(options, "provider." + args.configuration);
  const result = validate(s.schema, options);
  check(
    result.valid,
    "PROVIDER",
    result.diagnostics[0]?.message ?? "Invalid provider options",
  );
  return configureProviderOptions(
    root,
    args.configuration,
    args.options,
    s.reader.files,
  );
}
