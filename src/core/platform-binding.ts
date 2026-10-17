import { z } from "zod";
import { relative, dirname, resolve, isAbsolute } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import addFormats from "ajv-formats";
import { parseDocument, stringify, visit } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Configuration } from "./config.js";
import { canonical, check, digest } from "./errors.js";
import { readProgramme } from "./programme.js";
import { withProgrammeWrite } from "./programme-transaction.js";
import { compilerProjectId } from "./programme-schema.js";
import { platformProvider, platformTargetSchema } from "./platform-schema.js";
import { platformCatalogue } from "./platform-catalogue.js";
import { reviewGeneration } from "./platform-generation.js";
import { projectSchema } from "./schema.js";
import {
  platformBindingSchema,
  type PlatformBinding,
} from "./platform-binding-schema.js";
import { providerAuthor, providerReference } from "../plugins/authoring.js";
import { apply, editableProject, preview, type Proposal } from "./authoring.js";
import { auditSecrets } from "./planner.js";
import { projectPackages } from "./project-packages.js";
import {
  configuredPackageReference,
  fence,
  installedProviders,
} from "./packages.js";

export const programmeSourceSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/),
    root: z
      .string()
      .min(1)
      .max(4096)
      .refine(isAbsolute, "Programme root must be absolute"),
  })
  .strict();
export const bindingInspectSchema = z
  .object({
    programme: programmeSourceSchema,
    project: z.string().min(1).max(160),
  })
  .strict();
export const bindingProposeSchema = bindingInspectSchema
  .extend({
    sharedEnvironment: compilerProjectId,
    target: platformProvider,
    reference: z.string().min(1).max(500),
    configuration: compilerProjectId.refine(
      (v) => v.length <= 71,
      "Configuration name must leave room for its binding suffix",
    ),
    resources: z.record(z.string(), z.string().max(300)).default({}),
  })
  .strict();
export const bindingApplySchema = z
  .object({ programme: programmeSourceSchema, proposal: z.unknown() })
  .strict();
/** Shared by inspection and proposal validation; inspection never grants execution authority. */
function bindingConstraints(target: z.infer<typeof platformTargetSchema>) {
  const catalogue = platformCatalogue.find((p) => p.id === target.provider)!;
  const blockers: {
    setting: string;
    label: string;
    value: string;
    reason: string;
  }[] = (["policies", "capabilities"] as const).flatMap((group) =>
    Object.entries(target[group])
      .filter(([, value]) => value !== "inherit")
      .map(([setting, value]) => ({
        setting: `${group}.${setting}`,
        label: catalogue[group].find((c) => c.id === setting)?.label ?? setting,
        value,
        reason:
          "This explicit constraint has no binding enforcement adapter. Keep the requirement recorded; binding needs adapter support or a separately reviewed policy decision.",
      })),
  );
  if (target.generation?.overrides)
    blockers.push({
      setting: "generation.overrides",
      label: "Project overrides",
      value: target.generation.overrides,
      reason:
        "Project exception policy has no binding enforcement adapter. Keep the policy recorded until enforcement is available or a policy decision is reviewed.",
    });
  return { target: target.provider, blockers };
}
function source(programme: z.infer<typeof programmeSourceSchema>) {
  const saved = readProgramme(programme.root, programme.id);
  check(saved.document, "PROGRAMME", "Save the registered programme first");
  return {
    document: saved.document,
    definitionDigest: digest(canonical(saved.document)),
  };
}
function state(root: string) {
  const reader = new Configuration(root, {});
  const project = reader.parse(projectSchema, reader.load());
  for (const [name, binding] of Object.entries(project.platformBindings ?? {}))
    check(
      name === binding.configuration &&
        binding.materialised.packageAlias === name &&
        binding.materialised.bindingName === `${name}_platform`,
      "BINDING",
      "Binding keys differ from their materialised identities",
    );
  return { reader, project };
}
function assertMaterialised(
  project: z.infer<typeof projectSchema>,
  binding: PlatformBinding,
) {
  check(
    binding.projectId === project.id &&
      binding.source.document.id === binding.programmeId &&
      digest(canonical(binding.source.document)) ===
        binding.source.definitionDigest,
    "BINDING",
    "Binding snapshot identity or digest differs",
  );
  const registered = binding.source.document.projects.find(
    (p) => p.id === binding.planProjectId,
  );
  check(
    registered?.compilerId === project.id &&
      registered.platformId === binding.platformId,
    "BINDING",
    "Binding snapshot differs from its registered project",
  );
  const configured = project.providers.configurations[binding.configuration];
  const pkg = projectPackages(project)[binding.materialised.packageAlias];
  check(
    configured &&
      pkg &&
      configured.package === binding.materialised.packageAlias &&
      configured.binding === binding.materialised.bindingName &&
      configured.packs.length === 0 &&
      canonical(configured.options) ===
        canonical(binding.materialised.options) &&
      configuredPackageReference(pkg) === binding.package.reference,
    "BINDING",
    "Provider inputs differ from the reviewed platform binding; review again",
  );
  check(
    canonical(
      project.environments[binding.projectEnvironment]?.bindings[
        binding.materialised.bindingName
      ],
    ) === canonical(binding.materialised.binding),
    "BINDING",
    "Environment resource references differ from the reviewed binding",
  );
}
export function inspectPlatformBindings(
  root: string,
  environment: string,
  args: z.infer<typeof bindingInspectSchema>,
) {
  const { project } = state(root),
    saved = source(args.programme);
  const selected = saved.document.projects.find((p) => p.id === args.project);
  check(
    selected?.compilerId === project.id,
    "PROGRAMME",
    "Register this compiler project with the selected programme record first",
  );
  const platform = saved.document.platforms?.find(
    (p) => p.id === selected.platformId,
  );
  check(
    platform,
    "PROGRAMME",
    "Choose a shared platform for this programme project",
  );
  check(
    project.environments[environment],
    "ENVIRONMENT",
    "Choose a declared project environment",
  );
  return {
    apiVersion: "ingestron.platform-binding-inspection/v1",
    projectId: project.id,
    planProjectId: selected.id,
    platformId: platform.id,
    environment,
    sharedEnvironments: platform.configuration?.environments ?? [],
    targets: selected.targets ?? [],
    targetProfiles: platform.configuration?.targets ?? [],
    constraints: (platform.configuration?.targets ?? [])
      .filter((t) => selected.targets?.some((s) => s.provider === t.provider))
      .map((t) => ({
        ...bindingConstraints(t),
        preferences: reviewGeneration(t)
          .filter((i) => i.support !== "unset")
          .map((i) => ({
            setting: `generation.${i.setting}`,
            label: i.label,
            value: i.selection,
            mapping: i.mapping,
            reason:
              i.setting === "qualityFailure" &&
              t.generation?.qualityFailure === "block"
                ? "A current resource binding prevents the project from choosing report-only quality handling. Provider support for individual checks is verified during generation."
                : "Resource binding does not apply this preference. Review the concrete flow, contract and installed provider before generation.",
          })),
      })),
    providers: installedProviders(root)
      .filter(
        (p) =>
          p.platformBinding &&
          selected.targets?.some((t) => t.provider === p.platform),
      )
      .map((p) => {
        providerReference(root, p.reference);
        return {
          reference: p.reference,
          commit: p.commit,
          id: p.id,
          version: p.version,
          platform: p.platform,
          resourcesSchema: p.platformBinding!.resourcesSchema,
        };
      }),
    sourceDigest: saved.definitionDigest,
    bindings: Object.values(project.platformBindings ?? {}).map((binding) => {
      let intact = true;
      try {
        assertMaterialised(project, binding);
      } catch {
        intact = false;
      }
      if (binding.resources)
        auditSecrets(binding.resources, "platform.resources");
      return {
        ...(binding.resources ? { resources: binding.resources } : {}),
        configuration: binding.configuration,
        projectEnvironment: binding.projectEnvironment,
        sharedEnvironment: binding.sharedEnvironment,
        target: binding.target,
        package: binding.package,
        stale:
          binding.programmeId !== args.programme.id ||
          binding.source.definitionDigest !== saved.definitionDigest,
        intact,
        ownership: binding.ownership,
        pendingIntent: binding.pendingIntent,
      };
    }),
    executionEnabled: false,
  };
}
export function proposePlatformBinding(
  root: string,
  environment: string,
  args: z.infer<typeof bindingProposeSchema>,
) {
  const { reader, project } = state(root),
    saved = source(args.programme);
  const selected = saved.document.projects.find((p) => p.id === args.project);
  check(
    selected?.compilerId === project.id,
    "PROGRAMME",
    "Register this compiler project before binding it",
  );
  const platform = saved.document.platforms?.find(
    (p) => p.id === selected.platformId,
  );
  check(
    platform && selected.targets?.some((t) => t.provider === args.target),
    "PROGRAMME",
    "Select a target assigned to this project",
  );
  check(
    platform.configuration?.environments?.some(
      (e) => e.name === args.sharedEnvironment,
    ),
    "ENVIRONMENT",
    "Select an explicit shared platform environment",
  );
  const target = platform.configuration?.targets.find(
    (t) => t.provider === args.target,
  );
  const profile = target?.environments.find(
    (e) => e.name === args.sharedEnvironment,
  );
  check(
    target && profile,
    "ENVIRONMENT",
    "Configure the selected shared target environment first",
  );
  check(
    project.environments[environment],
    "ENVIRONMENT",
    "Select a declared project environment",
  );
  const constraints = bindingConstraints(target);
  check(
    !constraints.blockers.length,
    "POLICY",
    `Resource binding needs enforcement support for ${constraints.blockers.map((b) => `${b.setting}=${b.value}`).join(", ")}. Keep these constraints recorded; review adapter support or an explicit policy decision before binding.`,
  );
  const installed = providerReference(root, args.reference);
  check(
    installed.manifest.platform === args.target &&
      installed.manifest.platformBinding,
    "PROVIDER",
    "Choose an installed provider supporting this platform binding contract",
  );
  const resources = Object.fromEntries(
    Object.entries(profile.configuration).filter(([, value]) => value !== ""),
  );
  for (const [key, value] of Object.entries(args.resources)) {
    check(
      !(key in resources) || resources[key] === value,
      "POLICY",
      "Project binding cannot replace a shared resource reference",
    );
    resources[key] = value;
  }
  const validator = new Ajv2020({ strict: false, allErrors: true }).compile(
    installed.manifest.platformBinding.resourcesSchema,
  );
  check(
    validator(resources),
    "PROVIDER",
    "Complete the resource fields declared by the selected provider; unknown fields are not accepted",
  );
  auditSecrets(resources, "platform.resources");
  const files = providerAuthor(
    root,
    args.reference,
    {
      operation: "platform_binding",
      options: { projectId: project.id, environment, profile, resources },
    },
    (name) => name === "binding.yaml",
  );
  const output = parseDocument(files["binding.yaml"] ?? "", {
    uniqueKeys: true,
  });
  check(
    !output.errors.length && !output.warnings.length,
    "PROVIDER",
    "Invalid provider binding response",
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
  auditSecrets(result, "platform.materialised");
  const optionsSchema =
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
    optionsSchema,
    "PROVIDER",
    "Provider binding requires a configuration schema",
  );
  const optionsAjv = new Ajv2020({ strict: false, allErrors: true });
  (addFormats as any)(optionsAjv);
  check(
    optionsAjv.compile(optionsSchema)(result.options),
    "PROVIDER",
    "Materialised options do not satisfy the provider configuration schema",
  );
  const previous = project.platformBindings?.[args.configuration];
  if (previous) {
    assertMaterialised(project, previous);
    check(
      previous.programmeId === args.programme.id &&
        previous.platformId === platform.id &&
        previous.projectEnvironment === environment &&
        previous.target === args.target &&
        previous.planProjectId === args.project,
      "OWNER",
      "A provider configuration cannot be reassigned to another binding scope",
    );
  } else
    check(
      !project.providers.configurations[args.configuration] &&
        !projectPackages(project)[args.configuration],
      "OWNER",
      "Choose an unused provider configuration name",
    );
  const bindingName = `${args.configuration}_platform`;
  check(
    previous || !project.environments[environment].bindings[bindingName],
    "OWNER",
    "An existing environment binding belongs to another owner",
  );
  const binding: PlatformBinding = platformBindingSchema.parse({
    apiVersion: "ingestron.platform-binding/v1",
    programmeId: args.programme.id,
    planProjectId: args.project,
    projectId: project.id,
    platformId: platform.id,
    projectEnvironment: environment,
    sharedEnvironment: args.sharedEnvironment,
    target: args.target,
    configuration: args.configuration,
    package: {
      reference: installed.reference,
      commit: installed.entry.commit,
      digest: digest(canonical(installed.entry.files)),
    },
    source: saved,
    resources,
    materialised: {
      packageAlias: args.configuration,
      bindingName,
      binding: result.binding,
      options: result.options,
    },
    ownership: result.ownership,
    pendingIntent: result.pendingIntent,
  });
  const workspace = editableProject(root),
    changed = new Set<string>();
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
          "AUTHORING",
          "Review shared YAML aliases manually before materialising a binding",
        );
      },
    });
    doc.setIn([...at.prefix, key], value);
    changed.add(at.file);
  };
  const envAt = locate(["environments", environment, "bindings"]);
  for (const other of Object.keys(project.environments).filter(
    (e) => e !== environment,
  )) {
    const otherAt = locate(["environments", other, "bindings"]);
    check(
      envAt.file !== otherAt.file ||
        canonical(envAt.prefix) !== canonical(otherAt.prefix),
      "OWNER",
      "Selected environments share one binding definition; separate them before binding",
    );
  }
  write(["packages"], args.configuration, installed.reference);
  write(["providers", "configurations"], args.configuration, {
    package: args.configuration,
    binding: bindingName,
    options: result.options,
  });
  write(["environments", environment, "bindings"], bindingName, result.binding);
  const bindingFile = `platform-bindings/${args.configuration}.yaml`;
  const snapshotFile = `platform-bindings/snapshots/${saved.definitionDigest}.json`;
  const bindingAt = locate(["platformBindings"]);
  if (previous) {
    const ownedAt = locate(["platformBindings", args.configuration]);
    check(
      ownedAt.file === fence(root, bindingFile) && ownedAt.prefix.length === 0,
      "OWNER",
      "Binding has moved; review its file ownership before refreshing",
    );
  }
  write(["platformBindings"], args.configuration, {
    $resolve: `./${relative(dirname(bindingAt.file), resolve(root, bindingFile))}`,
  });
  const bindingPath = fence(root, bindingFile);

  check(
    previous || !existsSync(bindingPath),
    "OWNER",
    "The proposed binding file already exists and is not owned by this binding",
  );
  const snapshotPath = fence(root, snapshotFile);
  const snapshotText = JSON.stringify(saved.document, null, 2) + "\n";
  check(
    !existsSync(snapshotPath) ||
      readFileSync(snapshotPath, "utf8") === snapshotText,
    "OWNER",
    "An immutable programme snapshot has different content",
  );
  const replacements = Object.fromEntries(
    [...changed].map((file) => [
      relative(reader.root, file),
      workspace.document(file).toString(),
    ]),
  );
  replacements[bindingFile] = stringify({
    ...binding,
    source: {
      definitionDigest: saved.definitionDigest,
      document: { $resolve: `./snapshots/${saved.definitionDigest}.json` },
    },
  });
  replacements[snapshotFile] = snapshotText;
  const proposal = preview(
    root,
    replacements,
    { ...reader.files, ...workspace.reader.files },
    [installed.reference],
  );
  return {
    apiVersion: "ingestron.platform-binding-review/v1",
    request: args,
    programmeId: args.programme.id,
    sourceDigest: saved.definitionDigest,
    configuration: args.configuration,
    environment,
    sharedEnvironment: args.sharedEnvironment,
    target: args.target,
    package: binding.package,
    materialised: binding.materialised,
    ownership: binding.ownership,
    pendingIntent: binding.pendingIntent,
    proposal,
  };
}
export function applyPlatformBinding(
  root: string,
  programme: z.infer<typeof programmeSourceSchema>,
  input: unknown,
) {
  const review = z
    .object({
      apiVersion: z.literal("ingestron.platform-binding-review/v1"),
      programmeId: z.string(),
      request: bindingProposeSchema,
      environment: compilerProjectId,
      sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
      proposal: z.unknown(),
    })
    .passthrough()
    .parse(input);
  check(
    canonical(review.request.programme) === canonical(programme),
    "PROPOSAL",
    "Review belongs to another programme root",
  );
  // Serialise against programme saves while the project transaction verifies and applies.
  return withProgrammeWrite(programme.root, () => {
    const current = source(programme);
    check(
      review.programmeId === programme.id &&
        review.sourceDigest === current.definitionDigest,
      "STALE",
      "Shared programme changed after review; inspect and review the binding again",
    );
    // Re-derive exactly the reviewed writes. A changed wrapper cannot hide stale source inputs.
    const fresh = proposePlatformBinding(
      root,
      review.environment,
      review.request,
    );
    check(
      canonical(fresh) === canonical(input),
      "STALE",
      "Binding review inputs changed or the proposal was altered; review again",
    );
    return apply(root, fresh.proposal as Proposal);
  });
}
export function verifyBuildBindings(
  root: string,
  environment: string,
  programme?: z.infer<typeof programmeSourceSchema>,
) {
  const { project } = state(root),
    bindings = Object.values(project.platformBindings ?? {}).filter(
      (b) => b.projectEnvironment === environment,
    );
  if (!bindings.length) return;
  check(
    programme,
    "BINDING",
    "Supply the authorised programme ID and root to verify reviewed bindings before building",
  );
  const current = source(programme);
  for (const binding of bindings) {
    assertMaterialised(project, binding);
    check(
      binding.programmeId === programme.id &&
        binding.source.definitionDigest === current.definitionDigest,
      "STALE",
      "Shared programme changed; review the project binding before building",
    );
    const installed = providerReference(root, binding.package.reference);
    check(
      installed.entry.commit === binding.package.commit &&
        digest(canonical(installed.entry.files)) === binding.package.digest,
      "PACKAGE",
      "Installed provider differs from the reviewed binding",
    );
    const target = current.document.platforms
      ?.find((p) => p.id === binding.platformId)
      ?.configuration?.targets.find((t) => t.provider === binding.target);
    if (target?.generation?.qualityFailure === "block")
      check(
        project.defaults.quality?.unsupported !== "report",
        "POLICY",
        "Project cannot weaken the shared quality gate",
      );
  }
}

/** A copied environment does not inherit another environment's reviewed provider authority. */
export function assertBindingEnvironments(
  project: z.infer<typeof projectSchema>,
  environment: string,
  configurations: Iterable<string>,
) {
  const selected = new Set(configurations);
  for (const binding of Object.values(project.platformBindings ?? {}))
    if (selected.has(binding.configuration))
      check(
        binding.projectEnvironment === environment,
        "BINDING",
        `Provider configuration ${binding.configuration} was reviewed for ${binding.projectEnvironment}, not ${environment}; review a separate binding for this environment`,
      );
}
