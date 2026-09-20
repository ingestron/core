import { resolveModelContracts } from "./model-packs.js";
import { extensionActivities } from "./extension-packs.js";
import { expandProvider } from "../plugins/provider-renderer.js";
import { validateProviderPlan } from "../plugins/generation.js";
import addFormats from "ajv-formats";
import { resolve, relative, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { Configuration } from "./config.js";
import {
  projectSchema,
  flowSchema,
  stepSchema,
  type Plan,
  type Project,
  type Node,
  type Platform,
} from "./schema.js";
import { check, canonical, digest, isMap, merge, Problem } from "./errors.js";
import { executeProvider } from "../plugins/provider-renderer.js";
import { contractColumns } from "./contracts.js";
import {
  resolvePackage,
  providerPackageSchema,
  externalActivitySchema,
  fence,
  packageYaml,
} from "./packages.js";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import { compilerFingerprint } from "./fingerprint.js";
import { version } from "../version.js";
import { checkProviderCompatibility } from "../plugins/compatibility.js";
const secretFields = new Set([
  "password",
  "auth_token",
  "token",
  "accessToken",
  "clientSecret",
  "accountKey",
  "sasToken",
]);
const auditSecrets = (value: any, path: string) => {
  if (Array.isArray(value)) {
    value.forEach((child, index) => auditSecrets(child, `${path}[${index}]`));
    return;
  }
  if (!isMap(value) || value.$secret) return;
  for (const [key, child] of Object.entries(value)) {
    if (secretFields.has(key))
      check(
        isMap(child) && !!child.$secret,
        "SECRET",
        `${path}.${key}: use a runtime $secret reference`,
      );
    if (typeof child === "string" && key === "jdbcUrl")
      check(
        !/(password|pwd|token|accesskey)\s*=/i.test(child),
        "SECRET",
        "Keep credentials out of JDBC URLs; use runtime secret options",
      );
    auditSecrets(child, path + "." + key);
  }
};

export interface Select {
  nativeOnly?: boolean;
  flowIds?: string[];
  projectBuild?: boolean;
  flow?: string;
  table?: string;
  step?: string;
  draft?: boolean;
  delivery?: boolean;
  environmentVariables?: Record<string, string | undefined>;
}
export function inspectProject(
  root: string,
  environment = "dev",
  options: Select = {},
) {
  const reader = new Configuration(root, options.environmentVariables);
  const raw = reader.load();
  check(
    raw.apiVersion === "ingestron.project/v1",
    "VERSION",
    "This CLI accepts ingestron.project/v1 only; legacy project formats are not supported",
  );
  const initial = reader.parse(projectSchema, raw);
  const profile = initial.environments[environment];
  check(
    profile,
    "ENVIRONMENT",
    `Unknown environment ${environment}; available: ${Object.keys(initial.environments).join(", ")}`,
  );
  check(
    !profile.environment || profile.environment === environment,
    "ENVIRONMENT",
    `Profile name ${environment} differs from environment: ${profile.environment}`,
  );
  auditSecrets(profile.bindings, "bindings");
  auditSecrets(initial.connections, "connections");
  const context = {
    env: environment,
    project: { id: initial.id },
    values: profile.values,
  };
  const resolvedProfile = reader.values(profile, context, { draft: true });
  const project = {
    ...initial,
    providers: {
      ...initial.providers,
      configurations: Object.fromEntries(
        Object.entries(initial.providers.configurations).map(
          ([name, config]) => [
            name,
            {
              ...config,
              options: reader.values(
                config.options,
                { ...context, values: resolvedProfile.values },
                { draft: true },
              ),
            },
          ],
        ),
      ),
    },
    environments: { [environment]: resolvedProfile },
  };
  const flows = initial.flows.map((rawFlow) =>
    reader.parse(
      flowSchema,
      reader.values(
        rawFlow,
        {
          ...context,
          values: resolvedProfile.values,
          flow: { id: (rawFlow as any).id },
        },
        { draft: true, table: true, runtime: true },
      ),
    ),
  );
  resolveModelContracts(reader, project, flows);
  const ids = new Set<string>();
  for (const flow of flows) {
    check(!ids.has(flow.id), "OWNER", `Duplicate flow ${flow.id}`);
    ids.add(flow.id);
    check(
      [flow.steps, flow.ingestion].filter(Boolean).length === 1,
      "FLOW",
      `${flow.id}: select an ingestion standard or transformation steps`,
    );
    check(
      options.draft ||
        flow.kind !== "ingestion" ||
        !!flow.ingestion?.connection ||
        (!!flow.tables && Object.keys(flow.tables).length > 0),
      "FLOW",
      `${flow.id}: ingestion requires tables`,
    );
    check(
      flow.kind !== "transformation" || !flow.tables,
      "FLOW",
      `${flow.id}: transformation uses named requires/publishes, not a table loop`,
    );
    if (flow.kind === "transformation" && !options.draft)
      check(
        Object.keys(flow.publishes).length,
        "FLOW",
        `${flow.id}: declare published outputs`,
      );
  }
  return {
    reader,
    project,
    flows,
    profile: resolvedProfile,
    context: { ...context, values: resolvedProfile.values },
  };
}
function noPending(value: any, label: string) {
  if (Array.isArray(value)) value.forEach((v) => noPending(v, label));
  else if (isMap(value)) {
    if (value.$secret) return;
    check(
      !Object.hasOwn(value, "$env"),
      "INPUT",
      `${label}: supply environment variable ${value.$env}`,
    );
    Object.values(value).forEach((v) => noPending(v, label));
  } else {
    check(
      typeof value !== "string" ||
        !/{{\s*(?!run\.)[A-Za-z_][\w.]*\s*}}/.test(value),
      "INPUT",
      `${label}: unresolved value ${value}`,
    );
    check(
      value !== "SPECIFY",
      "INPUT",
      `${label}: replace SPECIFY with a value or a declared $env input`,
    );
  }
}
function provider(
  project: Project,
  bindings: Record<string, any>,
  reader: Configuration,
  selected?: string,
) {
  const name = selected ?? project.defaults.provider;
  check(name, "PROVIDER", "Select a provider or set defaults.provider");
  const configured = project.providers.configurations[name];
  check(configured, "PROVIDER", `Unknown provider configuration ${name}`);
  const pkg = project.providers.packages[configured.package];
  check(pkg, "PROVIDER", `Unknown provider package ${configured.package}`);
  let rendererCode: string | undefined;
  let plannerCode: string | undefined;
  let providerVersion: string | undefined;
  let lifecycleCode: string | undefined;
  let outputSchemas: Record<string, string> = {};
  let platform: Platform;
  let packageSource: { file: string; root: string; entry?: any } | undefined;
  let exports: Record<string, string> | undefined;
  let packageOptions: Record<string, unknown> | undefined;
  let capabilities: NonNullable<Node["runtime"]>["capabilities"];
  let packs: ReturnType<typeof extensionActivities> = {};
  check(
    !pkg.source.startsWith("builtin:"),
    "MIGRATION",
    "Bundled providers have retired. Install an exact provider version and use plugin migrate --from <package> --to <reference> to review the project change.",
  );
  {
    packageSource = pkg.source.startsWith(".")
      ? { file: reader.path(pkg.source), root: reader.root }
      : resolvePackage(reader.root, `${pkg.source}@${pkg.version}`);
    const descriptor = providerPackageSchema.parse(
      packageYaml(packageSource.file),
    );
    check(
      pkg.version === "v1" ||
        pkg.version === descriptor.version ||
        /^[a-f0-9]{40}$/.test(pkg.version),
      "PACKAGE",
      "Provider manifest version differs from its selector",
    );
    checkProviderCompatibility(descriptor);
    if (descriptor.outputSchemas)
      outputSchemas = Object.fromEntries(
        Object.entries(descriptor.outputSchemas).map(([key, path]) => [
          key,
          reader.text(
            fence(
              packageSource.root,
              relative(
                packageSource.root,
                resolve(dirname(packageSource.file), path),
              ),
            ),
          ),
        ]),
      );
    if (descriptor.lifecycle)
      lifecycleCode = reader.text(
        fence(
          packageSource.root,
          relative(
            packageSource.root,
            resolve(dirname(packageSource.file), descriptor.lifecycle.module),
          ),
        ),
      );
    if (descriptor.planner) {
      plannerCode = reader.text(
        fence(
          packageSource.root,
          relative(
            packageSource.root,
            resolve(dirname(packageSource.file), descriptor.planner.module),
          ),
        ),
      );
    }
    if (descriptor.configurationSchema) {
      const configAjv = new Ajv({
        allErrors: true,
        strict: false,
        useDefaults: true,
      });
      (addFormats as any)(configAjv);
      const configSchema =
        typeof descriptor.configurationSchema === "string"
          ? JSON.parse(
              reader.text(
                fence(
                  packageSource.root,
                  relative(
                    packageSource.root,
                    resolve(
                      dirname(packageSource.file),
                      descriptor.configurationSchema,
                    ),
                  ),
                ),
              ),
            )
          : descriptor.configurationSchema;
      const validateConfig = configAjv.compile(configSchema);
      packageOptions = structuredClone(configured.options);
      check(
        validateConfig(packageOptions),
        "PROVIDER",
        `Provider options: ${configAjv.errorsText(validateConfig.errors)}`,
      );
    }
    platform = descriptor.platform;
    capabilities = descriptor.capabilities;
    packs = extensionActivities(reader, project, configured.packs, descriptor);
    if (descriptor.renderer) {
      check(
        descriptor.configurationSchema,
        "PROVIDER",
        "A renderer provider must declare its own configurationSchema",
      );
      rendererCode = reader.text(
        fence(
          packageSource.root,
          relative(
            packageSource.root,
            resolve(dirname(packageSource.file), descriptor.renderer.module),
          ),
        ),
      );
      providerVersion = descriptor.version;

      if (Object.keys(descriptor.activities).length)
        exports = descriptor.activities;
    } else
      throw new Problem(
        "PROVIDER",
        "Extension providers must declare a renderer",
      );
    reader.text(packageSource.file);
    if (packageSource.entry) reader.text("packages.lock.yaml");
  }
  check(
    bindings[configured.binding],
    "BINDING",
    `Missing existing binding ${configured.binding}`,
  );
  check(
    bindings[configured.binding].kind === platform,
    "BINDING",
    `${configured.binding}.kind must be ${platform}`,
  );
  return {
    platform,
    plannerCode,
    binding: configured.binding,
    packageSource,

    exports,
    packs,
    runtime: {
      implementation: "native" as const,
      configuration: name,
      ...(capabilities ? { capabilities } : {}),
      options: packageOptions ?? configured.options,
      version: providerVersion,
      rendererCode,
      lifecycleCode,
      outputSchemas,
    },
  };
}
function refs(value: any, found: string[] = []): string[] {
  if (isMap(value)) {
    if (typeof value.from === "string") found.push(value.from);
    for (const v of Object.values(value)) refs(v, found);
  } else if (Array.isArray(value)) value.forEach((v) => refs(v, found));
  return found;
}
export function planProject(
  root: string,
  environment = "dev",
  options: Select = {},
): Plan {
  const inspected = inspectProject(root, environment, {
    ...options,
    draft: !!options.flow || options.draft,
  });
  const { reader, project, profile, context } = inspected;
  let flows = options.nativeOnly
    ? inspected.flows.filter((f) => !f.ingestion?.connection)
    : inspected.flows;
  if (options.flowIds)
    flows = flows.filter((f) => options.flowIds!.includes(f.id));
  if (options.flow) {
    const wanted = new Set<string>();
    const include = (id: string) => {
      if (wanted.has(id)) return;
      wanted.add(id);
      const flow = inspected.flows.find((f) => f.id === id);
      check(flow, "SELECT", `Unknown flow ${id}`);
      if (options.delivery && flow.export)
        for (const peer of inspected.flows)
          if (
            peer.export === flow.export &&
            (peer.provider ?? project.defaults.provider) ===
              (flow.provider ?? project.defaults.provider)
          )
            include(peer.id);
      for (const input of Object.values(flow.requires)) {
        const parts = input.dataset.split(".");
        check(
          parts[0] === project.id && parts.length >= 3,
          "DATASET",
          `Unknown project dataset ${input.dataset}`,
        );
        include(parts[1]);
      }
    };
    include(options.flow);
    flows = flows.filter((f) => wanted.has(f.id));
  }
  check(
    !options.delivery || (!options.table && !options.step),
    "SELECT",
    "Delivery builds require complete export groups; table/step selection is unsafe",
  );
  check(!options.table || options.flow, "SELECT", "Use --flow with --table");
  check(!options.step || options.flow, "SELECT", "Use --flow with --step");
  const nodes: Node[] = [],
    datasets: Plan["datasets"] = {},
    recovery: Plan["recovery"] = [],
    targets = new Map<string, string>(),
    byFlow = new Map<string, Node[]>();
  const selectedFlow = options.flow
    ? flows.find((f) => f.id === options.flow)
    : undefined;
  check(
    !options.flow || selectedFlow,
    "SELECT",
    `Unknown flow ${options.flow}`,
  );
  // Model producers before consumers regardless of file declaration order.
  const sorted: typeof flows = [],
    visiting = new Set<string>(),
    visitedFlows = new Set<string>();
  const visitFlow = (flow: (typeof flows)[number]) => {
    check(
      !visiting.has(flow.id),
      "CYCLE",
      `Flow dependency cycle at ${flow.id}`,
    );
    if (visitedFlows.has(flow.id)) return;
    visiting.add(flow.id);
    for (const required of Object.values(flow.requires)) {
      const parts = required.dataset.split(".");
      check(
        parts[0] === project.id,
        "DATASET",
        `Unknown project dataset ${required.dataset}`,
      );
      const parent = flows.find((f) => f.id === parts[1]);
      check(parent, "DATASET", `Unknown producer flow for ${required.dataset}`);
      visitFlow(parent);
    }
    visiting.delete(flow.id);
    visitedFlows.add(flow.id);
    sorted.push(flow);
  };
  flows.forEach(visitFlow);
  flows = sorted;
  for (const flow of flows) {
    check(
      !flow.ingestion?.connection,
      "CONNECTION",
      `${flow.id}: prepare reviewed connector assets with connections prepare ${flow.id}; native build does not execute source discovery`,
    );
    check(
      flow.kind !== "ingestion" || Object.keys(flow.tables ?? {}).length > 0,
      "FLOW",
      `${flow.id}: add ingestion tables before planning`,
    );
    check(
      flow.kind !== "transformation" || Object.keys(flow.publishes).length > 0,
      "FLOW",
      `${flow.id}: declare published outputs`,
    );
    // Global ownership is checked for all declared datasets; incomplete unrelated
    // flows remain draft. Their nodes are excluded after dependency selection.
    let steps = flow.steps ?? [];
    if (flow.ingestion) {
      const configuration =
        project.providers.configurations[
          flow.provider ?? project.defaults.provider ?? ""
        ];
      check(
        configuration,
        "PROVIDER",
        "Select a provider for the ingestion flow",
      );
      const selectedProvider = provider(
        project,
        profile.bindings,
        reader,
        flow.provider,
      );
      const providerSource =
        project.providers.packages[configuration.package]?.source;
      check(
        selectedProvider.plannerCode,
        "PROVIDER",
        "Ingestion requires a provider planner",
      );
      const preset = flow.ingestion.preset
        ? selectedProvider.packs[String(flow.ingestion.preset)]
        : undefined;
      check(
        !flow.ingestion.preset || preset,
        "PACK",
        `Unknown ingestion preset ${flow.ingestion.preset}`,
      );
      const ingestion = { ...flow.ingestion };
      delete ingestion.preset;
      const planningFlow = preset
        ? { ...flow, ingestion: merge(preset.with, ingestion) }
        : flow;
      const built = expandProvider(selectedProvider.plannerCode, {
        apiVersion: "ingestron.provider-planning/v1",
        flow: planningFlow,
        providerSource,
        columns: Object.fromEntries(
          Object.entries(flow.tables ?? {}).map(([id, table]) => [
            id,
            contractColumns(table.contract),
          ]),
        ),
      });
      if (preset)
        check(
          built.steps.every(
            (step: any) => step.uses.replace(/@.*$/, "") === preset.uses,
          ),
          "PACK",
          "Preset standard expanded an activity outside its allowed base activity",
        );
      steps = built.steps;
      recovery.push({ ...built.recovery, flow: flow.id });
    }
    steps = steps.map((s) => reader.parse(stepSchema, s));
    const stepIds = new Set<string>();
    for (const step of steps) {
      check(
        !stepIds.has(step.id),
        "STEP",
        `Duplicate step ${flow.id}/${step.id}`,
      );
      stepIds.add(step.id);
    }
    const tableEntries =
      flow.kind === "ingestion"
        ? Object.entries(flow.tables!)
        : ([["", undefined]] as const);
    const flowNodes: Node[] = [];
    byFlow.set(flow.id, flowNodes);
    for (const [tableId, table] of tableEntries) {
      if (table) {
        contractColumns(table.contract);
        for (const name of Object.keys(table.steps))
          check(
            stepIds.has(name),
            "STEP",
            `Unknown table override ${flow.id}/${tableId}/${name}`,
          );
      }
      let previous: Node | undefined;
      const previousById = new Map<string, Node>();
      for (const step of steps) {
        if (step.select) {
          check(
            flow.kind === "ingestion",
            "SELECT",
            "Table selection is only valid in an ingestion flow",
          );
          for (const selected of step.select)
            check(
              Object.hasOwn(flow.tables!, selected),
              "SELECT",
              `Unknown selected table ${selected}`,
            );
          if (!step.select.includes(tableId)) continue;
        }
        const chosen = provider(
          project,
          profile.bindings,
          reader,
          step.provider ?? flow.provider,
        );
        const preset = chosen.packs[step.uses];
        check(
          !step.uses.includes(":") || preset,
          "PACK",
          `Unknown pack activity ${step.uses}`,
        );
        const activityUse = preset?.uses ?? step.uses;
        let descriptor: {
          id: string;
          description: string;
          platforms: Platform[];
          input: string;
          output: string;
          effect: string;
          evidence: string;
          required?: string[];
        };
        let implementation: Node["implementation"];
        let generation: Node["generation"];
        let external:
          ReturnType<typeof externalActivitySchema.parse> | undefined;
        let packageRoot: string | undefined;
        let activityFile: string | undefined;
        let builtinActivity = false;
        if (activityUse.startsWith(".")) {
          activityFile = reader.path(activityUse);
          packageRoot = reader.root;
        } else if (
          chosen.exports &&
          chosen.packageSource &&
          !activityUse.includes("/")
        ) {
          const name = activityUse.replace(/@(v1|[1-9]\d*\.\d+\.\d+)$/, "");
          const exported = chosen.exports[name];
          check(exported, "ACTIVITY", `Provider does not export ${name}`);
          activityFile = fence(
            chosen.packageSource.root,
            relative(
              chosen.packageSource.root,
              resolve(dirname(chosen.packageSource.file), exported),
            ),
          );
          packageRoot = chosen.packageSource.root;
        } else if (activityUse.includes("/")) {
          const resolved = resolvePackage(reader.root, activityUse);
          activityFile = resolved.file;
          packageRoot = resolved.root;
          reader.text("packages.lock.yaml");
        }
        if (activityFile && packageRoot) {
          // Bundled files are covered by the compiler fingerprint. All user/Git
          // activity sources remain project-fenced and enter the source inventory.
          const readActivity = (file: string) =>
            builtinActivity ? readFileSync(file, "utf8") : reader.text(file);
          external = externalActivitySchema.parse(packageYaml(activityFile));
          const selectedVersion = /@([1-9]\d*\.\d+\.\d+)$/.exec(step.uses)?.[1];
          check(
            !selectedVersion || selectedVersion === external.version,
            "PACKAGE",
            "Activity manifest version differs from its exact selector",
          );
          if (
            external.generator?.kind === "native-pipeline" &&
            external.templates.some((t) => t.format === "sql")
          )
            check(
              external.input === "relation" && external.output === "relation",
              "INTERFACE",
              "SQL query activities require relation input and output",
            );
          check(
            external.platform === chosen.platform,
            "CAPABILITY",
            `${external.id} targets ${external.platform}, not ${chosen.platform}`,
          );
          readActivity(activityFile);
          descriptor = {
            id: external.id,
            description: external.description,
            platforms: [external.platform],
            input: external.input,
            output: external.output,
            effect: external.effect,
            evidence: "offline",
          };
          if (external.generator) {
            generation = {
              ...external.generator,
              builtin: builtinActivity,
              requirements: external.requirements,
            };
            if (external.generator.code)
              generation.code = readActivity(
                fence(
                  packageRoot!,
                  relative(
                    packageRoot!,
                    resolve(dirname(activityFile!), external.generator.code),
                  ),
                ),
              );
            if (external.generator.runtime)
              generation.runtime = readActivity(
                fence(
                  packageRoot!,
                  relative(
                    packageRoot!,
                    resolve(dirname(activityFile!), external.generator.runtime),
                  ),
                ),
              );
          }
          implementation = {
            dependencies: external.dependencies,
            templates: external.templates.map((template) => {
              const absolute = resolve(dirname(activityFile!), template.source);
              const rel = relative(packageRoot!, absolute);
              const file = fence(packageRoot!, rel);
              return {
                content: readActivity(file),
                ...(template.source.endsWith(".j2")
                  ? { engine: "jinja" as const }
                  : {}),
                output: template.output,
                format: template.format,
              };
            }),
          };
        } else
          throw new Problem(
            "ACTIVITY",
            `No activity definition for ${step.uses}`,
          );
        check(
          generation &&
            ["native-pipeline", "native-notebook", "native-project"].includes(
              generation.kind,
            ),
          "CAPABILITY",
          "Activities require a provider-native definition",
        );
        if (generation?.kind === "native-project")
          check(
            generation.artifactKind &&
              chosen.runtime.capabilities?.artifactKinds.includes(
                generation.artifactKind,
              ),
            "CAPABILITY",
            "native-project requires a provider-declared artifactKind",
          );
        let settings = merge(
          merge(
            merge(
              merge(preset?.with ?? {}, project.defaults.with),
              flow.defaults.with,
            ),
            step.with,
          ),
          table?.steps[step.id]?.with ?? {},
        );
        auditSecrets(settings, step.id);
        settings = reader.values(
          settings,
          {
            ...context,
            table: { id: tableId },
            flow: { id: flow.id },
            step: { id: step.id },
          },
          { draft: true, runtime: true },
        );
        if (external) {
          const optionsAjv = new Ajv({
            allErrors: true,
            strict: false,
            useDefaults: true,
          });
          (addFormats as any)(optionsAjv);
          const validate = optionsAjv.compile(external.optionsSchema);
          check(
            validate(settings),
            "ACTIVITY_INPUT",
            new Ajv().errorsText(validate.errors),
          );
        }
        for (const required of descriptor.required ?? [])
          check(
            settings[required] !== undefined,
            "ACTIVITY_INPUT",
            `${flow.id}/${tableId}/${step.id}: ${descriptor.id} requires ${required}`,
          );
        const explicit = refs(settings),
          needs: string[] = [];
        for (const ref of explicit) {
          if (ref.startsWith("requires.")) {
            check(
              Object.hasOwn(flow.requires, ref.slice(9)),
              "REFERENCE",
              `Unknown input ${ref}`,
            );
            continue;
          }
          const m =
            /^steps\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)$/.exec(ref);
          check(
            m && previousById.has(m[1]),
            "REFERENCE",
            `Unavailable output ${ref}`,
          );
          check(
            ["result", "table", "files", "receipt"].includes(m[2]),
            "REFERENCE",
            `Unknown primary output ${ref}`,
          );
          needs.push(previousById.get(m[1])!.id);
        }
        if (!explicit.length && previous) {
          check(
            descriptor.input === previous.interface.output ||
              (descriptor.input === "relation" &&
                previous.interface.output === "committed"),
            "INTERFACE",
            `${previous.uses} produces ${previous.interface.output}; ${step.uses} requires ${descriptor.input}`,
          );
        }
        if (previous) needs.push(previous.id);
        if (!previous && flow.kind === "ingestion")
          check(
            descriptor.input === "source" ||
              (descriptor.input === "files" &&
                typeof (table?.source?.from ?? flow.defaults.source?.from) ===
                  "string" &&
                !!flow.requires[
                  String(
                    table?.source?.from ?? flow.defaults.source?.from,
                  ).replace(/^requires\./, "")
                ]?.handover),
            "INTERFACE",
            `${step.uses} cannot start an ingestion flow without a source`,
          );
        const node: Node = {
          id: [flow.id, tableId, step.id].filter(Boolean).join("/"),
          flow: flow.id,
          ...(tableId ? { table: tableId } : {}),
          step: step.id,
          ...(flow.export ? { exportGroup: flow.export } : {}),
          uses: descriptor.id + "@v1",
          platform: chosen.platform,
          runtime: chosen.runtime,
          binding: chosen.binding,
          ...(implementation ? { implementation } : {}),
          ...(generation ? { generation } : {}),
          with: settings,
          needs: [...new Set(needs)],
          ...(table
            ? {
                source: reader.values(
                  merge(flow.defaults.source, table.source),
                  {
                    ...context,
                    flow: { id: flow.id },
                    table: { id: tableId },
                    step: { id: step.id },
                  },
                  { draft: true, runtime: true },
                ),
                contract:
                  settings.outputContract ??
                  previous?.contract ??
                  table.contract,
              }
            : {}),
          output: [project.id, flow.id, tableId, step.id]
            .filter(Boolean)
            .join("."),
          interface: {
            input: descriptor.input,
            output: descriptor.output,
          },
        };
        for (const field of ["sqlFile", "pythonFile", "moduleFile"])
          if (typeof settings[field] === "string") reader.text(settings[field]);
        flowNodes.push(node);
        nodes.push(node);
        previousById.set(step.id, node);
        previous = node;
        if (chosen.runtime.lifecycleCode) {
          const modeled: any = executeProvider(
            chosen.runtime.lifecycleCode,
            {
              apiVersion: "ingestron.provider-model/v1",
              node: {
                ...node,
                runtime: {
                  implementation: node.runtime!.implementation,
                  version: node.runtime!.version,
                  options: node.runtime!.options,
                },
              },
              bindings: profile.bindings,
              outputs: Object.fromEntries(
                Object.entries(flow.publishes).filter(([, output]) =>
                  output.from.startsWith(`steps.${node.step}.outputs.`),
                ),
              ),
              inputs: Object.fromEntries(
                Object.entries(flow.requires).map(([alias, requirement]) => {
                  const dataset = datasets[requirement.dataset];
                  check(
                    dataset,
                    "DATASET",
                    `Missing upstream dataset ${requirement.dataset}`,
                  );
                  return [
                    alias,
                    {
                      ...dataset,
                      dataset: requirement.dataset,
                      handover: requirement.handover,
                    },
                  ];
                }),
              ),
              tableName: reader.values(
                project.defaults.naming.table ?? "{{table.id}}",
                {
                  ...context,
                  table: { id: tableId },
                  flow: { id: flow.id },
                  step: { id: step.id },
                },
              ),
              project: project.id,
              environment,
              draft: !!options.draft,
            },
            false,
            "model",
          );
          check(
            isMap(modeled.with) &&
              isMap(modeled.datasets) &&
              Array.isArray(modeled.targets),
            "PROVIDER",
            "Invalid provider model response",
          );
          node.with = modeled.with;
          if (modeled.source !== undefined) {
            check(isMap(modeled.source), "PROVIDER", "Invalid modelled source");
            auditSecrets(modeled.source, node.id);
            node.source = modeled.source;
          }
          if (modeled.resources !== undefined) {
            check(
              Array.isArray(modeled.resources) &&
                modeled.resources.length <= 100 &&
                modeled.resources.every(
                  (r: any) =>
                    isMap(r) &&
                    Object.keys(r).every((k) =>
                      ["scope", "kind", "name"].includes(k),
                    ) &&
                    [r.scope, r.kind, r.name].every(
                      (v) =>
                        typeof v === "string" &&
                        v.length > 0 &&
                        v.length <= 1024,
                    ),
                ),
              "PROVIDER",
              "Invalid native resource claims",
            );
            node.resources = modeled.resources;
          }
          for (const target of modeled.targets) {
            check(
              typeof target === "string" && target.length <= 1024,
              "PROVIDER",
              "Invalid provider target identity",
            );
            const owner = node.binding + ":" + target;
            check(
              !targets.has(owner),
              "OWNER",
              `Target collision ${owner}: ${targets.get(owner)} and ${node.id}`,
            );
            targets.set(owner, node.id);
          }
          for (const [suffix, dataset] of Object.entries(modeled.datasets) as [
            string,
            any,
          ][]) {
            check(
              /^[A-Za-z_][\w-]*$/.test(suffix) && isMap(dataset),
              "PROVIDER",
              "Invalid published dataset",
            );
            contractColumns(dataset.contract);
            const id = [project.id, flow.id, tableId, suffix]
              .filter(Boolean)
              .join(".");
            check(!datasets[id], "OWNER", `Duplicate dataset ${id}`);
            datasets[id] = {
              ...dataset,
              contract: dataset.contract,
              producer: node.id,
            };
          }
        }
        if (generation?.requirements?.sourceKinds && node.source)
          check(
            generation.requirements.sourceKinds.includes(
              node.source.kind ?? profile.bindings[node.source.binding]?.kind,
            ),
            "CAPABILITY",
            `Activity ${descriptor.id} supports sources: ${generation.requirements.sourceKinds.join(", ")}`,
          );
      }
    }
    for (const [name, publish] of Object.entries(flow.publishes)) {
      contractColumns(publish.contract);
      const match =
        /^steps\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)$/.exec(
          publish.from,
        );
      check(match, "REFERENCE", `Invalid published output ${publish.from}`);
      const producer = flowNodes.find((n) => n.step === match[1]);
      check(
        producer && ["result", "table"].includes(match[2]),
        "REFERENCE",
        `Unknown published port ${publish.from}`,
      );
      datasets[`${project.id}.${flow.id}.${name}`] = {
        producer: producer.id,
        contract: publish.contract,
        location:
          publish.location ??
          datasets[`${project.id}.${flow.id}.${name}`]?.location,
      };
      producer.contract ??= publish.contract;
    }
  }
  for (const flow of flows) {
    if (flow.kind === "transformation") {
      const own = byFlow.get(flow.id) ?? [];
      let current: Record<string, any> | undefined;
      for (const node of own) {
        current = node.with.outputContract ?? node.contract ?? current;
        if (!current) {
          const downstream = own
            .slice(own.indexOf(node) + 1)
            .find((n) => n.contract);
          current = downstream?.contract;
        }
        node.contract ??= current;
      }
    }
    const inputNodes = Object.values(flow.requires).map((input) => {
      const found = datasets[input.dataset];
      check(found, "DATASET", `${flow.id}: unknown dataset ${input.dataset}`);
      return found.producer;
    });
    const localNodes = byFlow.get(flow.id) ?? [];
    const localIds = new Set(localNodes.map((node) => node.id));
    for (const node of localNodes) {
      const required = refs(node.with)
        .filter((ref) => ref.startsWith("requires."))
        .map((ref) => datasets[flow.requires[ref.slice(9)].dataset].producer);
      const first = !node.needs.some((id) => localIds.has(id));
      node.needs = [
        ...new Set([...required, ...node.needs, ...(first ? inputNodes : [])]),
      ];
    }
  }
  for (const node of nodes) {
    if (node.contract) contractColumns(node.contract);
  }
  const byId = new Map(nodes.map((n) => [n.id, n])),
    visited = new Set<string>(),
    active = new Set<string>();
  const visit = (id: string) => {
    check(!active.has(id), "CYCLE", `Flow dependency cycle at ${id}`);
    if (visited.has(id)) return;
    active.add(id);
    const node = byId.get(id);
    check(node, "REFERENCE", `Missing dependency ${id}`);
    node.needs.forEach(visit);
    active.delete(id);
    visited.add(id);
  };
  for (const node of nodes)
    for (const parentId of node.needs) {
      const parent = byId.get(parentId)!;
      const consumerFlow = flows.find((f) => f.id === node.flow)!;
      const requirements = Object.values(consumerFlow.requires).filter(
        (r) => datasets[r.dataset]?.producer === parent.id,
      );
      for (const input of requirements)
        if (input.handover) {
          check(
            parent.runtime?.capabilities?.handovers.includes(input.handover) &&
              node.runtime?.capabilities?.handovers.includes(input.handover),
            "CAPABILITY",
            `Both providers must support ${input.handover} handovers`,
          );
          check(
            input.handover === "files"
              ? parent.interface.output === "files"
              : ["relation", "committed"].includes(parent.interface.output),
            "INTERFACE",
            "Handover kind differs from producer output",
          );
          const location = datasets[input.dataset].location;
          check(
            location?.kind === input.handover &&
              typeof location.binding === "string" &&
              profile.bindings[location.binding] &&
              typeof location.name === "string" &&
              location.name.length > 0,
            "HANDOVER",
            `Dataset ${input.dataset} requires a ${input.handover} location with an existing binding and name`,
          );
          auditSecrets(location, input.dataset);
          if (!options.draft) noPending(location, input.dataset);
        }
      if (parent.platform !== node.platform)
        check(
          parent.interface.output === "files" ||
            (requirements.length > 0 &&
              requirements.every((input) => input.handover === "relation")),
          "CAPABILITY",
          `Cross-platform edge ${parent.id} → ${node.id} requires an explicit file export/import boundary or declared relation handover`,
        );
      if (parent.flow !== node.flow)
        check(
          node.interface.input === parent.interface.output ||
            (node.interface.input === "relation" &&
              parent.interface.output === "committed"),
          "INTERFACE",
          `${node.id}: required dataset has incompatible ${parent.interface.output} interface`,
        );
    }
  nodes.forEach((n) => visit(n.id));
  check(nodes.length <= 10000, "LIMIT", "Plan exceeds 10,000 expanded nodes");
  let selected = nodes;
  if (options.flow && !options.delivery) {
    const matches = nodes.filter(
      (n) =>
        n.flow === options.flow &&
        (!options.table || n.table === options.table) &&
        (!options.step || n.step === options.step),
    );
    check(matches.length, "SELECT", "Selection contains no activity nodes");
    const closure = new Set<string>();
    const add = (id: string) => {
      if (closure.has(id)) return;
      closure.add(id);
      byId.get(id)!.needs.forEach(add);
    };
    matches.forEach((n) => add(n.id));
    selected = nodes.filter((n) => closure.has(n.id));
  }
  const selectedBindings = new Set<string>();
  for (const node of selected) {
    selectedBindings.add(node.binding);
    if (node.source?.binding) selectedBindings.add(node.source.binding);
    const flow = flows.find((f) => f.id === node.flow)!;
    for (const input of Object.values(flow.requires))
      if (input.handover)
        selectedBindings.add(datasets[input.dataset].location!.binding);
  }
  for (const dataset of Object.values(datasets))
    if (
      selected.some((n) => n.id === dataset.producer) &&
      ["files", "relation"].includes(dataset.location?.kind) &&
      typeof dataset.location?.binding === "string"
    )
      selectedBindings.add(dataset.location.binding);
  const bindings = Object.fromEntries(
    [...selectedBindings].map((name) => {
      check(profile.bindings[name], "BINDING", `Missing binding ${name}`);
      return [name, profile.bindings[name]];
    }),
  );
  auditSecrets(bindings, "bindings");
  if (!options.draft)
    for (const [name, binding] of Object.entries(bindings))
      noPending(binding, name);
  if (!options.draft)
    for (const node of selected) {
      const {
        implementation: _templates,
        generation: _generation,
        ...configuration
      } = node;
      const {
        rendererCode: _rendererSource,
        lifecycleCode: _lifecycle,
        outputSchemas: _schemas,
        ...runtimeOptions
      } = node.runtime ?? {};
      noPending({ ...configuration, runtime: runtimeOptions }, node.id);
      noPending(profile.bindings[node.binding], node.binding);
      if (node.source?.binding) {
        check(
          profile.bindings[node.source.binding],
          "BINDING",
          `Missing source binding ${node.source.binding}`,
        );
        noPending(profile.bindings[node.source.binding], node.source.binding);
      }
    }
  const names = {
    jobs: {} as Record<string, string>,
    nodes: {} as Record<string, string>,
  };
  const nameOwners = new Set<string>();
  for (const node of selected) {
    const ctx = {
      ...context,
      flow: { id: node.flow },
      table: { id: node.table ?? "flow" },
      step: { id: node.step },
    };
    const kind = "asset";
    const name = node.id.replace(/[^A-Za-z0-9_]/g, "_");
    check(
      /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name),
      "NAMING",
      `Invalid ${kind} name ${name}; use letters, digits and underscores, starting with a letter`,
    );
    const owner = node.binding + ":" + kind + ":" + name;
    check(!nameOwners.has(owner), "NAMING", `Duplicate resource name ${name}`);
    nameOwners.add(owner);
    names.nodes[node.id] = name;
    names.jobs[node.flow] = reader.values(
      project.defaults.naming.job ?? "{{env}}_{{project.id}}_{{flow.id}}",
      ctx,
    );
    check(
      /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(names.jobs[node.flow]),
      "NAMING",
      "Invalid job name",
    );
  }
  const activitySources: Record<string, string> = {};
  for (const node of selected)
    if (node.runtime?.rendererCode) {
      const ref = digest(node.runtime.rendererCode);
      activitySources[ref] = node.runtime.rendererCode;
      node.runtime.rendererRef = ref;
      delete node.runtime.rendererCode;
    }
  for (const node of selected)
    if (node.runtime?.outputSchemas) {
      const ref = digest(canonical(node.runtime.outputSchemas));
      activitySources[ref] = canonical(node.runtime.outputSchemas);
      node.runtime.outputSchemasRef = ref;
      delete node.runtime.outputSchemas;
    }
  for (const node of selected)
    if (node.runtime?.lifecycleCode) {
      const ref = digest(node.runtime.lifecycleCode);
      activitySources[ref] = node.runtime.lifecycleCode;
      node.runtime.lifecycleRef = ref;
      delete node.runtime.lifecycleCode;
    }
  for (const node of selected)
    if (node.generation?.runtime) {
      const ref = digest(node.generation.runtime);
      activitySources[ref] = node.generation.runtime;
      node.generation.runtimeRef = ref;
      delete node.generation.runtime;
    }
  for (const node of selected)
    if (node.generation?.code) {
      const ref = digest(node.generation.code);
      activitySources[ref] = node.generation.code;
      node.generation.codeRef = ref;
      delete node.generation.code;
    }
  const body = {
    activitySources,
    apiVersion: "ingestron.plan/v1" as const,
    compilerVersion: version,
    compilerDigest: compilerFingerprint(),
    names,
    inputDigests: reader.inputs,
    selection: {
      ...(options.flow ? { flow: options.flow } : {}),
      ...(options.table ? { table: options.table } : {}),
      ...(options.step ? { step: options.step } : {}),
      ...(options.delivery ? { delivery: true } : {}),
      ...(options.projectBuild ? { projectBuild: true } : {}),
    },
    project: project.id,
    environment,
    bindings,
    nodes: selected,
    flows: flows.filter((f) => selected.some((n) => n.flow === f.id)),
    files: reader.files,
    datasets: Object.fromEntries(
      Object.entries(datasets).filter(([, d]) =>
        selected.some((n) => n.id === d.producer),
      ),
    ),
    recovery: recovery.filter((r) => selected.some((n) => n.flow === r.flow)),
    pending: options.draft ? reader.pending : [],
  };
  const plan = { ...body, digest: digest(canonical(body)) };
  for (const flow of plan.flows) {
    if (
      Object.values(flow.requires).some(
        (input) => input.select.mode === "same-run",
      )
    )
      check(
        plan.nodes
          .filter((n) => n.flow === flow.id)
          .every((n) => n.runtime?.implementation === "native"),
        "CAPABILITY",
        "same-run dataset selection requires native provider generation",
      );
  }
  if (!options.draft) validateProviderPlan(plan);
  return plan;
}
