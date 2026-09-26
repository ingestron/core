import { executionSchemas, performExecution } from "./execution.js";
import { buildProject } from "./project-build.js";
import { prepareConnection } from "./connections.js";
import { reportPackSchema } from "./report-pack-schema.js";
import { modelPackSchema } from "./model-pack-schema.js";
import { deliveryIndexSchema } from "./deliveries.js";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { check, Problem, canonical, digest } from "./errors.js";
import { Configuration } from "./config.js";
import {
  projectSchema,
  flowSchema,
  stepSchema,
  environmentSchema,
  type Plan,
} from "./schema.js";
import { inspectProject, planProject } from "./planner.js";
import { renderProject, writeOutput, validateOutput } from "./generate.js";
import { contractColumns, validateContract } from "./contracts.js";
import {
  packageLock,
  installedProviders,
  installedActivities,
  installPackage,
  externalActivitySchema,
  providerPackageSchema,
  extensionPackSchema,
  fence,
} from "./packages.js";
import {
  providerCommands,
  runProviderCommand,
  pluginCommands,
  runPluginCommand,
} from "./provider-commands.js";
import * as development from "./development.js";
import { scaffoldProvider } from "./provider-starter.js";
import * as ecosystemAuthor from "./ecosystem-authoring.js";
import * as author from "./authoring.js";
import * as workflows from "./workflows.js";
import { providerVersions, friendlyReference } from "./package-references.js";
import { browseProviders, pluginDetails } from "./installed-plugins.js";
export const operationSchemas = {
  ...executionSchemas,
  connection_add: z
    .object({
      id: workflows.identifier,
      package: workflows.identifier,
      sourceId: workflows.identifier,
      tenantId: workflows.identifier,
      binding: workflows.identifier.optional(),
      settings: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  connection_flow_add: z
    .object({
      id: workflows.identifier,
      provider: workflows.identifier,
      connection: workflows.identifier,
      table: workflows.identifier,
      contract: z.string().min(1),
      source: z.record(z.string(), z.unknown()).default({}),
      execution: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  contract_scaffold: z
    .object({
      id: workflows.identifier,
      table: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      field: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      type: z.enum(["string", "integer", "number", "boolean"]),
    })
    .strict(),
  contract_map_fields: z
    .object({
      apiVersion: z.literal("ingestron.field-mapping/v1"),
      flow: workflows.identifier,
      environment: workflows.identifier,
      contract: z.string().min(1),
      discovery: z.string().min(1),
      stream: z.string().min(1),
      table: workflows.identifier,
      fields: z
        .array(
          z
            .object({
              source: workflows.identifier,
              target: workflows.identifier,
            })
            .strict(),
        )
        .min(1)
        .max(500),
    })
    .strict(),
  provider_scaffold: z
    .object({ id: workflows.identifier, out: z.string() })
    .strict(),
  pack_configure: z
    .object({
      reference: z.string(),
      name: workflows.identifier,
      provider: workflows.identifier.optional(),
    })
    .strict(),
  flow_connect: z
    .object({
      id: workflows.identifier,
      input: workflows.identifier,
      dataset: z.string(),
      handover: z.enum(["files", "relation"]),
      table: workflows.identifier.optional(),
    })
    .strict(),
  flow_export: z
    .object({ id: workflows.identifier, group: workflows.identifier })
    .strict(),
  provider_check: z.object({ delivery: z.boolean().default(false) }).strict(),
  plugin_show: z.object({ id: z.string().min(1).max(200) }).strict(),
  plugin_browse: z
    .object({
      engine: z.string().min(1).optional(),
      installable: z.boolean().optional(),
      query: z.string().max(128).optional(),
      kind: z
        .enum([
          "provider",
          "connector",
          "model-pack",
          "activity-pack",
          "report-pack",
        ])
        .optional(),
    })
    .strict(),
  plugin_versions: z
    .object({
      provider: z.string(),
      fromGit: z.string().optional(),
      tagPrefix: z.string().optional(),
    })
    .strict(),
  source_list: z.object({}).strict(),
  source_show: z.object({ id: workflows.identifier }).strict(),
  source_add: workflows.sourceSchema.omit({
    apiVersion: true,
    environments: true,
  }),
  source_configure: z
    .object({
      id: workflows.identifier,
      patch: z.record(z.string(), z.unknown()),
    })
    .strict(),
  source_prepare: z
    .object({
      id: workflows.identifier,
      input: z.string(),
      out: z.string().optional(),
    })
    .strict(),
  source_import: z
    .object({ id: workflows.identifier, metadata: z.string() })
    .strict(),
  plugin_configure: z
    .object({
      reference: z.string(),
      name: workflows.identifier.optional(),
      update: z.boolean().optional(),
    })
    .strict(),
  contract_list: z.object({}).strict(),
  contract_show: z.object({ id: z.string() }).strict(),
  contract_check: z
    .object({ id: z.string(), native: z.boolean().default(false) })
    .strict(),
  contract_create: z
    .object({
      id: workflows.identifier,
      source: workflows.identifier.optional(),
      metadata: z.string().optional(),
      entity: z.string().optional(),
      out: z.string().optional(),
      provider: z.string().optional(),
    })
    .strict(),
  flow_create: z
    .object({
      id: workflows.identifier,
      kind: z.enum(["ingestion", "transformation"]).default("ingestion"),
      standard: z.string().optional(),
      sourceKind: z.string().optional(),
      format: z.string().optional(),
      sourceBinding: workflows.identifier.optional(),
      inputDataset: z.string().optional(),
      provider: z.string().optional(),
      source: workflows.identifier.optional(),
      contract: z.string().optional(),
    })
    .strict(),
  flow_show: z.object({ id: workflows.identifier }).strict(),
  build: z
    .object({
      provider: z.string().optional(),
      delivery: z.boolean().default(false),
      flow: z.string().optional(),
      table: z.string().optional(),
      step: z.string().optional(),
      out: z.string().default("build/generated"),
      ownership: z.enum(["managed", "team"]).default("managed"),
    })
    .strict(),
  environments: z.object({}).strict(),
  environment_add: z.object({ name: z.string(), from: z.string() }).strict(),
  datasets: z.object({}).strict(),
  tables: z.object({}).strict(),
  config_explain: z.object({ path: z.string() }).strict(),
  diff: z.object({ plan: z.string() }).strict(),
  inspect: z.object({}).strict(),
  schema: z
    .object({
      name: z.enum([
        "project",
        "source",
        "flow",
        "delivery-index",
        "step",
        "environment",
        "activity",
        "provider",
        "extension-pack",
      ]),
    })
    .strict(),
  read: z.object({ path: z.string() }).strict(),
  validate: z
    .object({
      mode: z.enum(["draft", "strict"]).default("strict"),
      flow: z.string().optional(),
      table: z.string().optional(),
      step: z.string().optional(),
    })
    .strict(),
  resolve: z.object({}).strict(),
  plan: z
    .object({
      flow: z.string().optional(),
      table: z.string().optional(),
      step: z.string().optional(),
    })
    .strict(),
  generate: z
    .object({
      plan: z.string(),
      out: z.string(),
      ownership: z.enum(["managed", "team"]).default("managed"),
    })
    .strict(),
  validate_output: z.object({ directory: z.string() }).strict(),
  catalogue: z
    .object({
      kind: z.enum(["activities", "standards", "providers"]),
      id: z.string().optional(),
    })
    .strict(),
  initialise: z
    .object({
      id: z.string(),
      provider: z.string().optional(),
      environments: z.array(z.string()).optional(),
    })
    .strict(),
  activity_inspect: z.object({ path: z.string() }).strict(),
  contract_draft: z
    .object({ metadata: z.string(), id: z.string(), out: z.string() })
    .strict(),
  contract_validate: z.object({ path: z.string() }).strict(),
  flow_configure: z
    .object({ flow: z.string(), patch: z.record(z.string(), z.unknown()) })
    .strict(),
  step_add: z
    .object({
      flow: z.string(),
      step: stepSchema,
      after: z.string().optional(),
    })
    .strict(),
  flow_add: z
    .object({
      id: z.string(),
      kind: z.enum(["ingestion", "transformation"]),
      standard: z.string().optional(),
      sourceKind: z.string().optional(),
      provider: z.string().optional(),
      format: z.string().min(1).max(32).optional(),
      inputDataset: z.string().optional(),
      sourceBinding: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/)
        .optional(),
    })
    .strict(),
  table_add: z
    .object({
      id: z.string(),
      flow: z.string(),
      contract: z.string(),
    })
    .strict(),
  table_configure: z
    .object({
      id: z.string(),
      flow: z.string(),
      patch: z.record(z.string(), z.unknown()),
    })
    .strict(),
  dataset_add: z
    .object({
      id: z.string(),
      flow: z.string(),
      contract: z.string(),
      from: z.string(),
    })
    .strict(),
  config_set: z.object({ path: z.string(), value: z.unknown() }).strict(),
  edit: z.object({ files: z.record(z.string(), z.string()) }).strict(),
  apply: z.object({ proposal: z.unknown() }).strict(),
  packages_install: z
    .object({
      reference: z.string(),
      kind: z.enum(["provider", "connector"]).optional(),
      fromGit: z.string().optional(),
      update: z.boolean().optional(),
      frozen: z.boolean().optional(),
      tagPrefix: z.string().optional(),
    })
    .strict(),
  provider_migrate: z.object({ package: z.string(), to: z.string() }).strict(),
  provider_export: z.object({ result: z.string(), out: z.string() }).strict(),
  connection_prepare: z
    .object({
      flow: z.string(),
      validateOnly: z.boolean().default(false),
      review: z.string().optional(),
    })
    .strict(),
  plugin_commands: z.object({}).strict(),
  plugin_command: z
    .object({
      namespace: z.string(),
      target: z.string().optional(),
      command: z.string(),
      input: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  provider_commands: z.object({ configuration: z.string() }).strict(),
  provider_command: z
    .object({
      configuration: z.string(),
      command: z.string(),
      input: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  packages_list: z.object({}).strict(),
  doctor: z.object({}).strict(),
} as const;
export type OperationName = keyof typeof operationSchemas;
export interface Context {
  root: string;
  environment?: string;
  allowWrite?: boolean;
  allowNetwork?: boolean;
  allowExecute?: boolean;
}
export interface Result {
  apiVersion: "ingestron.operation/v1";
  operation: string;
  ok: boolean;
  result?: any;
  diagnostics: {
    code: string;
    message: string;
    file?: string;
    pointer?: string;
    hint?: string;
  }[];
}
export function execute(
  context: Context,
  operation: OperationName,
  request: unknown = {},
): Result {
  try {
    check(
      Object.hasOwn(operationSchemas, operation),
      "OPERATION",
      "Unknown operation",
    );
    const parsed = operationSchemas[operation].safeParse(request);
    check(
      parsed.success,
      "SCHEMA",
      parsed.error?.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ") ?? "Invalid request",
    );
    const args: any = parsed.data,
      root = existsSync(context.root)
        ? realpathSync(context.root)
        : resolve(context.root),
      environment = context.environment ?? "dev";
    const write = () =>
      check(
        context.allowWrite,
        "PERMISSION",
        "This operation requires local-write access",
      );
    let result: any;
    switch (operation) {
      case "connection_add":
        result = author.addConnection(root, args);
        break;
      case "connection_flow_add":
        result = author.addConnectionFlow(root, args);
        break;
      case "contract_map_fields": {
        check(
          args.environment === environment,
          "ENVIRONMENT",
          "Mapping draft is for another environment",
        );
        const prepared = prepareConnection(
          root,
          environment,
          args.flow,
          true,
        ) as {
          specificationSha256: string;
          sourceBoundarySha256: string;
        };
        const reader = new Configuration(root);
        const discovery = JSON.parse(reader.text(args.discovery));
        const discoveredSpec = discovery.identity?.projectSpecSha256;
        if (discoveredSpec !== prepared.specificationSha256) {
          const saved = JSON.parse(
            reader.text(
              `build/generated/flows/${args.flow}/project-connection.lock.json`,
            ),
          );
          const { specificationSha256: savedDigest, ...savedSpec } = saved;
          const sourceBoundary = {
            ...savedSpec,
            tables: Object.fromEntries(
              Object.entries(savedSpec.tables ?? {}).map(
                ([name, table]: [string, any]) => [name, table.source],
              ),
            ),
          };
          check(
            savedDigest === discoveredSpec &&
              savedDigest === digest(canonical(savedSpec)) &&
              digest(canonical(sourceBoundary)) ===
                prepared.sourceBoundarySha256,
            "DISCOVERY",
            "Source configuration changed since discovery; rebuild and rediscover before mapping fields",
          );
        }
        result = author.mapContractFields(root, args);
        break;
      }
      case "runtime_prepare":
      case "run":
      case "run_status":
        throw new Problem(
          "EXECUTION",
          "Use executeAsync for execution operations",
        );
      case "provider_scaffold":
        result = scaffoldProvider(root, args);
        break;
      case "pack_configure":
        result = ecosystemAuthor.configurePack(root, args);
        break;
      case "flow_connect":
      case "flow_export":
        result = ecosystemAuthor.configureFlow(root, args);
        break;
      case "provider_check": {
        const plan = planProject(root, environment, {
          delivery: args.delivery,
        });
        const first = renderProject(root, plan),
          second = renderProject(
            root,
            planProject(root, environment, { delivery: args.delivery }),
          );
        check(
          canonical(first) === canonical(second),
          "DETERMINISM",
          "Provider output differs between repeated builds",
        );
        result = {
          evidence: "offline",
          execution: "not-run",
          planDigest: plan.digest,
          files: Object.keys(first).length,
          deterministic: true,
        };
        break;
      }
      case "plugin_show":
        result = pluginDetails(root, args.id);
        break;
      case "plugin_browse":
        result = browseProviders(root, args.query, args.kind, args);
        break;
      case "plugin_versions":
        check(
          context.allowNetwork || args.fromGit,
          "PERMISSION",
          "Provider version discovery requires allowNetwork in the operation context",
        );
        if (args.fromGit && !context.allowNetwork)
          args.fromGit = fence(root, args.fromGit);
        result = providerVersions(args.provider, args.fromGit, args.tagPrefix);
        break;
      case "source_list":
        result = workflows.sourceList(root, environment);
        break;
      case "source_show":
        result = workflows.sourceShow(root, args.id, environment);
        break;
      case "source_add":
        result = workflows.sourceAdd(root, args);
        break;
      case "source_configure":
        result = workflows.sourceConfigure(root, args);
        break;
      case "source_prepare":
        result = workflows.sourcePrepare(root, environment, args);
        break;
      case "source_import":
        result = workflows.sourceImport(root, environment, args);
        break;
      case "plugin_configure":
        result = workflows.pluginConfigure(root, args);
        break;
      case "contract_list":
        result = workflows.contractList(root);
        break;
      case "contract_show":
        result = new Configuration(root).load(
          workflows.contractPath(root, args.id),
        );
        validateContract(result);
        break;
      case "contract_check": {
        const path = workflows.contractPath(root, args.id),
          contract = new Configuration(root).load(path);
        validateContract(contract, path);
        result = {
          path,
          valid: true,
          status: contract.status,
          ...(args.native ? { columns: contractColumns(contract, path) } : {}),
          evidence:
            "Offline ODCS validation; business review and source execution are separate",
        };
        break;
      }
      case "contract_create":
        result = workflows.draftContract(root, environment, args);
        break;
      case "contract_scaffold":
        result = author.scaffoldContract(root, args);
        break;
      case "flow_create":
        result = workflows.flowCreate(root, environment, args);
        break;
      case "flow_show": {
        const state = inspectProject(root, environment, { draft: true });
        result = state.flows.find((f) => f.id === args.id);
        check(result, "SELECT", `Unknown flow ${args.id}`);
        break;
      }
      case "build": {
        write();
        result = buildProject(root, environment, args);
        break;
      }
      case "datasets":
        result = planProject(root, environment).datasets;
        break;
      case "environment_add":
        result = author.addEnvironment(root, args);
        break;
      case "environments":
        result = {
          selected: environment,
          available: Object.keys(
            new Configuration(root).load().environments ?? {},
          ),
        };
        break;
      case "config_explain": {
        const reader = new Configuration(root);
        const raw = reader.load();
        const profile = raw.environments[environment];
        check(profile, "ENVIRONMENT", `Unknown environment ${environment}`);
        const keys = args.path.split(".");
        check(
          ["values", "bindings"].includes(keys[0]),
          "CONFIG",
          "Explain a values.* or bindings.* path",
        );
        let value = profile,
          owner = profile;
        for (const key of keys) {
          check(
            value &&
              typeof value === "object" &&
              Object.hasOwn(value, key) &&
              !["__proto__", "prototype", "constructor"].includes(key),
            "CONFIG",
            `Unknown field ${args.path}`,
          );
          owner = value;
          value = value[key];
        }
        result = {
          path: args.path,
          environment,
          declared: value,
          resolved: reader.values(
            value,
            {
              env: environment,
              project: { id: raw.id },
              values: profile.values,
            },
            { draft: true },
          ),
          source: reader.locations.get(owner),
          pending: reader.pending,
        };
        break;
      }
      case "diff": {
        const previous = JSON.parse(
            new Configuration(root).text(args.plan),
          ) as Plan,
          current = planProject(root, environment, previous.selection);
        check(
          previous.apiVersion === "ingestron.plan/v1",
          "VERSION",
          "Diff requires a current saved plan",
        );
        const before = new Map(previous.nodes.map((n) => [n.id, canonical(n)])),
          after = new Map(current.nodes.map((n) => [n.id, canonical(n)]));
        result = {
          added: [...after.keys()].filter((id) => !before.has(id)),
          removed: [...before.keys()].filter((id) => !after.has(id)),
          changed: [...after.keys()].filter(
            (id) => before.has(id) && before.get(id) !== after.get(id),
          ),
          configurationChanged:
            canonical(previous.bindings) !== canonical(current.bindings),
          sourceChanged: canonical(previous.files) !== canonical(current.files),
          beforeDigest: previous.digest,
          afterDigest: current.digest,
          evidence: "Local plans only; no platform drift lookup",
        };
        break;
      }
      case "tables": {
        const state = inspectProject(root, environment, { draft: true });
        result = state.flows
          .filter((flow) => flow.kind === "ingestion")
          .map((flow) => ({
            flow: flow.id,
            tables: Object.keys(flow.tables ?? {}),
          }));
        break;
      }
      case "inspect": {
        const state = inspectProject(root, environment, { draft: true });
        result = {
          project: state.project.id,
          environment,
          flows: state.flows.map((f) => ({
            id: f.id,
            kind: f.kind,
            tables: Object.keys(f.tables ?? {}),
            inputs: f.requires,
            outputs: Object.keys(f.publishes),
          })),
          providers: state.project.providers,
          pending: state.reader.pending,
        };
        break;
      }
      case "schema":
        result = z.toJSONSchema(
          (
            {
              project: projectSchema,
              source: workflows.sourceSchema,
              flow: flowSchema,
              "delivery-index": deliveryIndexSchema,
              step: stepSchema,
              environment: environmentSchema,
              activity: externalActivitySchema,
              provider: providerPackageSchema,
              "extension-pack": z.union([
                extensionPackSchema,
                modelPackSchema,
                reportPackSchema,
              ]),
            } as any
          )[args.name],
        );
        break;
      case "read":
        check(
          /\.(ya?ml|json|sql|py|md)$/.test(args.path) &&
            !args.path.split("/").some((p: string) => p.startsWith(".")),
          "PATH",
          "Read only project configuration and source files",
        );
        result = {
          path: args.path,
          content: new Configuration(root).text(args.path),
        };
        break;
      case "validate": {
        if (args.mode === "draft") {
          check(
            !args.flow && !args.table && !args.step,
            "OPTION",
            "Draft validation checks the whole project; use strict mode for flow/table/step selection",
          );
          const state = inspectProject(root, environment, { draft: true });
          result = {
            mode: "draft",
            pending: state.reader.pending,
            flows: state.flows.length,
          };
        } else {
          const state = inspectProject(root, environment, { draft: true });
          const selected = state.flows.filter(
            (f) => !args.flow || f.id === args.flow,
          );
          check(selected.length > 0, "FLOW", "Unknown flow");
          const connected = selected.filter((f) => f.ingestion?.connection);
          if (connected.length) {
            check(
              !args.table && !args.step,
              "CONNECTION",
              "Validate connector flows as a whole",
            );
            const checks = connected.map((f) =>
              prepareConnection(root, environment, f.id, true),
            );
            // Validate native flows as one complete target. Selecting each flow
            // separately makes providers that own shared resources reject an
            // otherwise valid full project as an unsafe partial deployment.
            if (selected.some((f) => !f.ingestion?.connection))
              planProject(root, environment, { nativeOnly: true });
            result = {
              mode: "strict",
              evidence: "offline",
              connections: checks,
            };
            break;
          }
          const plan = planProject(root, environment, args);
          result = {
            mode: "strict",
            nodes: plan.nodes.length,
            digest: plan.digest,
            evidence: "offline",
          };
        }
        break;
      }
      case "resolve": {
        const state = inspectProject(root, environment, { draft: true });
        result = {
          project: state.project,
          flows: state.flows,
          pending: state.reader.pending,
          sources: state.reader.files,
        };
        break;
      }
      case "plan":
        result = planProject(root, environment, args);
        break;
      case "generate": {
        write();
        const plan = JSON.parse(new Configuration(root).text(args.plan));
        check(
          plan.environment === environment,
          "ENVIRONMENT",
          `Saved plan is for ${plan.environment}, not selected ${environment}`,
        );
        result = writeOutput(
          fence(root, args.out),
          plan,
          renderProject(root, plan),
          args.ownership,
        );
        break;
      }
      case "validate_output":
        result = validateOutput(fence(root, args.directory));
        break;
      case "catalogue": {
        const installed = installedProviders(root);
        const entries =
          args.kind === "standards"
            ? installed.flatMap((p) =>
                (p.standards ?? []).map((s) => ({
                  ...s,
                  provider: p.reference,
                  version: p.version,
                  evidence: "offline",
                })),
              )
            : args.kind === "activities"
              ? installedActivities(root)
              : installed;
        result = args.id
          ? entries.filter(
              (e: any) =>
                e.id.replace(/@v1$/, "") === args.id.replace(/@v1$/, ""),
            )
          : entries;
        check(
          !args.id || result.length,
          "SELECT",
          `Unknown ${args.kind} entry ${args.id}`,
        );
        break;
      }
      case "initialise":
        result = author.initialise(root, args);
        break;
      case "activity_inspect":
        result = development.activityInspect(root, args.path);
        break;
      case "contract_draft":
        result = development.contractDraft(
          root,
          args.metadata,
          args.id,
          args.out,
        );
        break;
      case "contract_validate":
        result = {
          columns: contractColumns(new Configuration(root).load(args.path)),
          evidence: "offline",
        };
        break;
      case "flow_configure":
        result = author.configureFlow(root, args.flow, args.patch);
        break;
      case "step_add":
        result = author.addStep(root, args.flow, args.step, args.after);
        break;
      case "flow_add":
        result = author.addFlow(root, args);
        break;
      case "table_add":
        result = author.addTable(root, args);
        break;
      case "table_configure":
        result = author.configureTable(root, args.flow, args.id, args.patch);
        break;
      case "dataset_add":
        result = author.addDataset(root, args);
        break;
      case "config_set":
        result = author.editValue(root, environment, args.path, args.value);
        break;
      case "edit": {
        for (const file of Object.keys(args.files))
          check(
            /\.(yaml|yml|json|sql|py|md)$/.test(file),
            "PATH",
            "Only configuration, source and Markdown files may be edited",
          );
        result = author.preview(root, args.files);
        break;
      }
      case "apply":
        write();
        result = author.apply(root, args.proposal);
        break;
      case "packages_install":
        write();
        check(
          context.allowNetwork || args.fromGit,
          "PERMISSION",
          "Package fetch requires explicit package-network access",
        );
        if (args.fromGit && !context.allowNetwork)
          args.fromGit = fence(root, args.fromGit);
        result = installPackage(root, args.reference, args);
        result.displayReference = friendlyReference(result.reference);
        break;
      case "provider_migrate":
        result = author.migrateProvider(root, args);
        break;
      case "provider_export":
        result = development.exportProviderArtifacts(
          root,
          args.result,
          args.out,
        );
        break;
      case "connection_prepare":
        result = prepareConnection(
          root,
          context.environment ?? "dev",
          args.flow,
          args.validateOnly,
          args.review,
        );
        break;
      case "plugin_commands":
        result = pluginCommands(root, environment);
        break;
      case "plugin_command":
        result = runPluginCommand(root, environment, args);
        break;
      case "provider_commands":
        result = providerCommands(
          root,
          context.environment ?? "dev",
          args.configuration,
        );
        break;
      case "provider_command":
        result = runProviderCommand(root, context.environment ?? "dev", args);
        break;
      case "packages_list":
        result = packageLock(root);
        result = {
          ...result,
          entries: Object.entries(result.packages).map(
            ([reference, entry]: any) => ({
              reference: friendlyReference(reference),
              canonicalReference: reference,
              commit: entry.commit,
            }),
          ),
        };
        break;
      case "doctor": {
        const state = inspectProject(root, environment, { draft: true });
        result = {
          node: process.version,
          project: state.project.id,
          environment,
          pending: state.reader.pending,
          platformAccess: "Not checked; compiler is offline",
          packages: Object.keys(packageLock(root).packages),
          next: state.reader.pending.length
            ? "Supply missing environment inputs or create a config_set proposal"
            : "Use validate and build for selected flows",
        };
        break;
      }
    }
    return {
      apiVersion: "ingestron.operation/v1",
      operation,
      ok: true,
      result,
      diagnostics: [],
    };
  } catch (error) {
    const e =
      error instanceof Problem
        ? error
        : error instanceof z.ZodError
          ? new Problem(
              "SCHEMA",
              error.issues
                .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
                .join("; "),
            )
          : new Problem(
              "INTERNAL",
              error instanceof Error ? error.message : "Operation failed",
            );
    return {
      apiVersion: "ingestron.operation/v1",
      operation,
      ok: false,
      diagnostics: [
        {
          code: e.code,
          message: e.message,
          file: e.file,
          pointer: e.pointer,
          hint: e.hint,
        },
      ],
    };
  }
}

/** Shared CLI/MCP entry point; ordinary compiler operations remain synchronous/offline. */
export async function executeAsync(
  context: Context,
  operation: OperationName,
  request: unknown = {},
): Promise<Result> {
  if (!Object.hasOwn(executionSchemas, operation))
    return execute(context, operation, request);
  try {
    const name = operation as keyof typeof executionSchemas;
    const parsed = executionSchemas[name].safeParse(request);
    check(
      parsed.success,
      "SCHEMA",
      parsed.error?.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ") ?? "Invalid execution request",
    );
    const result = await performExecution(context, name, parsed.data);
    return {
      apiVersion: "ingestron.operation/v1",
      operation,
      ok: true,
      result,
      diagnostics: [],
    };
  } catch (error) {
    const e =
      error instanceof Problem
        ? error
        : new Problem(
            "EXECUTION",
            "Execution preflight failed; check generated files and runtime preparation",
          );
    return {
      apiVersion: "ingestron.operation/v1",
      operation,
      ok: false,
      diagnostics: [{ code: e.code, message: e.message }],
    };
  }
}
