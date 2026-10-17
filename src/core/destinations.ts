/** Standalone destination authoring uses the installed provider binding contract. */
import { relative, resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { parseDocument, visit } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod";
import { editableProject, preview } from "./authoring.js";
import { projectSchema } from "./schema.js";
import { destinationReviewSchema } from "./destination-schema.js";
import { canonical, check, digest } from "./errors.js";
import { installedProviders, fence } from "./packages.js";
import { providerAuthor, providerReference } from "../plugins/authoring.js";
import { generationCatalogue } from "./platform-generation.js";
import { platformCatalogue } from "./platform-catalogue.js";
import { auditSecrets } from "./planner.js";

function state(root: string, environment: string) {
  const workspace = editableProject(root),
    project = projectSchema.parse(workspace.reader.load());
  check(
    project.environments[environment],
    "ENVIRONMENT",
    "Choose an existing environment",
  );
  return {
    workspace,
    project,
    revision: digest(canonical(workspace.reader.files)),
  };
}
export function readDestinations(root: string, environment: string) {
  const { project, revision } = state(root, environment);
  return {
    apiVersion: "ingestron.destinations/v1",
    revision,
    setups: project.destinationSetups?.[environment] ?? {},
    configured: Object.keys(project.providers.configurations),
    targets: platformCatalogue.map((t) => ({
      id: t.id,
      label: t.name,
      methods: (generationCatalogue[t.id] ?? []).filter((s) =>
        ["ingestion", "transformation"].includes(s.id),
      ),
      providers: installedProviders(root)
        .filter((p) => p.platform === t.id)
        .map((p) => ({
          reference: p.reference,
          version: p.version,
          resourcesSchema: p.platformBinding?.resourcesSchema ?? null,
          standards: p.standards ?? [],
        })),
    })),
    executionEnabled: false,
  };
}
export function reviewDestination(
  root: string,
  environment: string,
  raw: z.infer<typeof destinationReviewSchema>,
) {
  const args = destinationReviewSchema.parse(raw),
    { workspace, project, revision } = state(root, environment);
  check(
    args.revision === revision,
    "STALE",
    "Project changed; refresh destination setup",
  );
  const setup = args.setup;
  const choice = (generationCatalogue[setup.target] ?? [])
    .filter((s) => ["ingestion", "transformation"].includes(s.id))
    .flatMap((s) => s.options)
    .find((o) => o.id === setup.method);
  check(
    choice && (setup.deferred || choice.support === "provider"),
    "CAPABILITY",
    "This method is not available for configuration",
  );
  check(
    Object.keys(project.destinationSetups?.[environment] ?? {}).length < 100 ||
      !!project.destinationSetups?.[environment]?.[args.configuration],
    "LIMIT",
    "A project environment supports at most 100 destination configurations",
  );
  check(
    !Object.entries(project.destinationSetups ?? {}).some(
      ([e, setups]) =>
        e !== environment && Object.hasOwn(setups, args.configuration),
    ),
    "OWNER",
    "Use a separate configuration name for each environment",
  );
  const previous =
    project.destinationSetups?.[environment]?.[args.configuration];
  check(
    !project.platformBindings?.[args.configuration],
    "OWNER",
    "Configure shared platform destinations through their owning platform",
  );
  const changed = new Set<string>();
  const locate = (keys: string[]) => {
    let at = { file: workspace.projectFile, prefix: [] as (string | number)[] };
    for (const key of keys)
      at = workspace.location({ file: at.file, prefix: [...at.prefix, key] });
    return at;
  };
  const write = (keys: string[], key: string, value: unknown) => {
    const at = locate(keys),
      doc = workspace.document(at.file);
    visit(doc, {
      Alias() {
        check(
          false,
          "OWNER",
          "Separate shared YAML aliases before configuring destinations",
        );
      },
    });
    doc.setIn([...at.prefix, key], value);
    changed.add(at.file);
  };
  let references: string[] = [];
  if (!setup.deferred || (setup.reference && choice?.support === "provider")) {
    check(
      setup.reference,
      "PROVIDER",
      "Install the selected destination support before configuring resources",
    );
    const installed = providerReference(root, setup.reference);
    check(
      installed.manifest.platform === setup.target &&
        installed.manifest.platformBinding,
      "CAPABILITY",
      "Installed destination does not support resource configuration yet",
    );
    check(
      !project.providers.configurations[args.configuration] ||
        (previous &&
          previous.target === setup.target &&
          previous.reference === setup.reference),
      "OWNER",
      "Choose a new configuration name; existing provider settings are owned elsewhere",
    );
    check(
      !setup.deferred ||
        (choice?.support === "provider" &&
          installed.manifest.platformBinding.designResources),
      "CAPABILITY",
      "Installed destination needs design configuration support for deferred resources",
    );
    check(
      !setup.deferred || Object.keys(setup.resources).length === 0,
      "INPUT",
      "Deferred destinations use provider-owned design settings; leave resource fields empty",
    );
    const resources = setup.deferred
      ? installed.manifest.platformBinding.designResources!
      : setup.resources;
    const validator = new Ajv2020({ strict: false, allErrors: true });
    (addFormats as any)(validator);
    check(
      validator.compile(installed.manifest.platformBinding.resourcesSchema)(
        resources,
      ),
      "PROVIDER",
      "Complete the resource fields declared by the installed destination",
    );
    auditSecrets(setup.resources, "destination.resources");
    const files = providerAuthor(
      root,
      setup.reference,
      {
        operation: "platform_binding",
        options: {
          projectId: project.id,
          environment,
          profile: {
            name: environment,
            purpose: "development",
            authentication:
              setup.target === "databricks" ? "databricks-cli" : "azure-cli",
            configuration: {},
            secrets: [],
          },
          resources,
        },
      },
      (name) => name === "binding.yaml",
    );
    const output = parseDocument(files["binding.yaml"] ?? "", {
      uniqueKeys: true,
    });
    check(
      !output.errors.length && !output.warnings.length,
      "PROVIDER",
      "Invalid destination binding response",
    );
    const result = z
      .object({
        apiVersion: z.literal("ingestron.provider-binding/v1"),
        binding: z.record(z.string(), z.unknown()),
        options: z.record(z.string(), z.unknown()),
        ownership: z.string().max(2000),
        pendingIntent: z.array(z.string().max(2000)).max(20),
      })
      .strict()
      .parse(output.toJS({ maxAliasCount: 50 }));
    auditSecrets(result, "destination.materialised");
    const schema =
      typeof installed.manifest.configurationSchema === "string"
        ? JSON.parse(
            readFileSync(
              fence(
                installed.root,
                relative(
                  installed.root,
                  resolve(
                    dirname(installed.file),
                    installed.manifest.configurationSchema,
                  ),
                ),
              ),
              "utf8",
            ),
          )
        : installed.manifest.configurationSchema;
    check(
      schema && validator.compile(schema)(result.options),
      "PROVIDER",
      "Invalid destination options",
    );
    check(
      !project.packages[args.configuration] ||
        (previous && previous.reference === setup.reference),
      "OWNER",
      "The package alias belongs to another configuration",
    );
    check(
      !Object.entries(project.providers.configurations).some(
        ([name, c]) =>
          name !== args.configuration &&
          (c.package === args.configuration ||
            c.binding === args.configuration + "_target"),
      ),
      "OWNER",
      "Destination aliases are used by another provider configuration",
    );
    const bindingName = args.configuration + "_target";
    const owned =
      previous?.reference === setup.reference &&
      project.providers.configurations[args.configuration]?.package ===
        args.configuration &&
      project.providers.configurations[args.configuration]?.binding ===
        bindingName;
    check(
      !project.environments[environment].bindings[bindingName] || owned,
      "OWNER",
      "Destination binding already belongs to another configuration",
    );
    for (const other of Object.keys(project.environments).filter(
      (e) => e !== environment,
    )) {
      const a = locate(["environments", environment, "bindings"]),
        b = locate(["environments", other, "bindings"]);
      check(
        a.file !== b.file || canonical(a.prefix) !== canonical(b.prefix),
        "OWNER",
        "Separate shared environment bindings before configuration",
      );
    }
    write(["packages"], args.configuration, installed.reference);
    write(["providers", "configurations"], args.configuration, {
      package: args.configuration,
      binding: bindingName,
      options: result.options,
    });
    write(
      ["environments", environment, "bindings"],
      bindingName,
      result.binding,
    );
    references = [installed.reference];
  } else {
    check(
      !project.providers.configurations[args.configuration] &&
        (!previous || previous.deferred),
      "OWNER",
      "An active destination cannot be replaced with a deferred setup",
    );
    check(
      Object.keys(setup.resources).length === 0,
      "INPUT",
      "Deferred setup leaves resource settings empty until deployment preparation",
    );
  }
  write(["destinationSetups", environment], args.configuration, setup);
  return preview(
    root,
    Object.fromEntries(
      [...changed].map((file) => [
        relative(workspace.reader.root, file),
        workspace.document(file).toString(),
      ]),
    ),
    workspace.reader.files,
    references,
  );
}
