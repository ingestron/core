import {
  policyEditorReviewSchema,
  readPolicyEditor,
  reviewPolicyEditor,
} from "./policy-editor.js";
import {
  snapshotImportReviewSchema,
  snapshotImportApplySchema,
  reviewSnapshotImport,
  applySnapshotImport,
} from "./presentation-snapshot.js";
import {
  executionProfilesReadSchema,
  executionProfilesReviewSchema,
  readExecutionProfiles,
  reviewExecutionProfile,
} from "./execution-profile-editor.js";
import { deliverySchemas, performDelivery } from "./delivery-workflow.js";
import {
  sharedConnectionReviewSchema,
  sharedConnectionApplySchema,
  reviewSharedConnection,
  applySharedConnection,
} from "./platform-reuse.js";
import {
  platformReuseReadSchema,
  platformReuseReviewSchema,
  platformReuseApplySchema,
  inspectPlatformReuse,
  reviewPlatformReuse,
  applyPlatformReuse,
} from "./platform-reuse.js";
import {
  presentationReviewSchema,
  inspectPresentations,
  reviewPresentation,
} from "./presentation.js";
import {
  packageInstallReviewSchema,
  packageInstallApplySchema,
  packageConfigureSchema,
  inspectPackageLibrary,
  reviewPackageInstall,
  applyPackageInstall,
  reviewPackageConfiguration,
} from "./package-library.js";
import { sourceJourneySchema, inspectSourceJourney } from "./source-journey.js";
import { inspectEngineering } from "./engineering-workbench.js";
import {
  connectionEditorReadSchema,
  connectionEditorReviewSchema,
  readConnectionEditor,
  reviewConnectionEditor,
} from "./connection-editor.js";
import {
  buildStatusSchema,
  buildFileSchema,
  inspectBuild,
  readBuildFile,
} from "./generated-assets.js";
import {
  targetSetupSchema,
  targetSetupApplySchema,
  reviewTargetSetup,
  applyTargetSetup,
} from "./target-setup.js";
import {
  providerInstallSchema,
  providerInstallApplySchema,
  reviewProviderInstall,
  applyProviderInstall,
} from "./provider-install.js";
import {
  workspaceInitialisationSchema,
  workspaceInitialisationApplySchema,
  inspectWorkspace,
  reviewWorkspaceInitialisation,
  applyWorkspaceInitialisation,
} from "./workspace-initialisation.js";
import {
  flowEditorCreateSchema,
  createFlowEditor,
  flowEditorReadSchema,
  flowEditorReviewSchema,
  readFlowEditor,
  reviewFlowEditor,
} from "./flow-editor.js";
import {
  programmeManifestSchema,
  platformDefinitionSchema,
  platformEnvironmentSchema,
  requirementsDefinitionSchema,
} from "./programme-storage-schema.js";
import {
  programmeMigrationSchema,
  programmeMigrationApplySchema,
  inspectProgrammeStorage,
  reviewProgrammeMigration,
  applyProgrammeMigration,
} from "./programme-migration.js";
import {
  buildReviewSchema,
  buildApplySchema,
  reviewBuild,
  applyBuild,
} from "./build-review.js";
import {
  programmeSourceSchema,
  bindingInspectSchema,
  bindingProposeSchema,
  bindingApplySchema,
  inspectPlatformBindings,
  proposePlatformBinding,
  applyPlatformBinding,
} from "./platform-binding.js";
import {
  requirementsTemplateSchema,
  requirementsTemplate,
} from "./requirements-catalogue.js";
import { reviewGeneration } from "./platform-generation.js";
import { platformCatalogue } from "./platform-catalogue.js";
import {
  platformSecretSchema,
  platformSecretSetSchema,
  platformSecretStatus,
  platformSecretSet,
} from "./platform-secrets.js";
import {
  programmeProjectTemplateSchema,
  programmeProjectTemplate,
} from "./programme-template.js";
import {
  programmeReadSchema,
  programmeSaveSchema,
  programmeSchema,
} from "./programme-schema.js";
import { readProgramme, saveProgramme } from "./programme.js";
import {
  inspectProgrammeDefinition,
  proposeProgrammeRegistration,
  programmeRegistrationSchema,
} from "./programme-definition.js";
import {
  buildRetainSchema,
  buildRetainedSchema,
  retainBuild,
  inspectRetainedBuild,
} from "./build-retention.js";
import {
  inspectProviderConfiguration,
  proposeProviderConfiguration,
} from "./provider-configuration.js";
import {
  scheduleOccurrences,
  scheduleOccurrencesSchema,
} from "./schedule-clock.js";
import { schedulerSchemas, performScheduler } from "./scheduler.js";
import { workerSchemas, performSchedulerWorker } from "./scheduler-worker.js";
import { scheduleSchema } from "./schedule-schema.js";
import {
  sourceFlowSchema,
  sourceFlowsSchema,
  proposeSourceFlow,
  proposeSourceFlows,
} from "./source-flow.js";
import { sourceAccessSchemas, performSourceAccess } from "./source-access.js";
import {
  executionSchemas,
  performExecution,
  executionFeatures,
} from "./execution.js";
import { dataProducts } from "./governance.js";
import { compilerIdentity } from "./compiler-identity.js";
import { projectGovernance } from "./project-governance.js";
import { policySchema } from "./policy-schema.js";
import {
  buildProject,
  qualityCoverage,
  sourceRouting,
} from "./project-build.js";
import { checkRoutes } from "./sources.js";
import { isPortableConnection } from "./native-connections.js";
import { checkCoverage, coverageSummary } from "./quality.js";
import { prepareConnection } from "./connections.js";
import { reportPackSchema } from "./report-pack-schema.js";
import { modelPackSchema } from "./model-pack-schema.js";
import { deliveryIndexSchema } from "./deliveries.js";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { check, Problem, canonical, digest } from "./errors.js";
import { Configuration } from "./config.js";
import { deliveryPlanSchema } from "./delivery-plan-schema.js";
import {
  checkDeliveryPlan,
  proposeDeliveryPlan,
  proposeDeliveryBaseline,
} from "./delivery-plan.js";
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
  platform_binding_inspect: bindingInspectSchema,
  platform_binding_propose: bindingProposeSchema,
  platform_binding_apply: bindingApplySchema,
  programme_requirements_template: requirementsTemplateSchema,
  programme_platform_catalogue: z.object({ id: z.string() }).strict(),
  programme_secret_status: platformSecretSchema,
  programme_secret_set: platformSecretSetSchema,
  compiler_identity: z.object({}).strict(),
  build_retain: buildRetainSchema,
  build_retained: buildRetainedSchema,
  ...deliverySchemas,
  ...executionSchemas,
  ...schedulerSchemas,
  ...workerSchemas,
  ...sourceAccessSchemas,
  provider_configuration_inspect: z
    .object({ configuration: workflows.identifier })
    .strict(),
  provider_configuration_propose: z
    .object({
      configuration: workflows.identifier,
      options: z.record(z.string(), z.unknown()),
      expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  schedule_occurrences: scheduleOccurrencesSchema,
  schedule_check: z.object({ schedule: scheduleSchema }).strict(),
  schedule_propose: z
    .object({ flow: workflows.identifier, schedule: scheduleSchema.nullable() })
    .strict(),
  schedule_inspect: z.object({ flow: workflows.identifier }).strict(),
  governance_check: z.object({ flow: z.string().optional() }).strict(),
  policy_editor_read: z.object({}).strict(),
  policy_editor_review: policyEditorReviewSchema,
  policy_propose: z.object({ policy: policySchema }).strict(),
  connection_journey: sourceJourneySchema,
  connection_flow_review: sourceFlowSchema,
  connection_flows_review: sourceFlowsSchema,
  programme_project_template: programmeProjectTemplateSchema,
  workspace_inspect: z.object({}).strict(),
  workspace_initialisation_review: workspaceInitialisationSchema,
  workspace_initialisation_apply: workspaceInitialisationApplySchema,
  programme_read: programmeReadSchema,
  programme_storage_inspect: programmeReadSchema,
  programme_migration_review: programmeMigrationSchema,
  programme_migration_apply: programmeMigrationApplySchema,
  programme_definition_inspect: programmeReadSchema,
  programme_registration_propose: programmeRegistrationSchema,
  programme_save: programmeSaveSchema,
  delivery_plan_check: z
    .object({
      path: z.string().default("delivery-plan.yaml"),
      baseline: z.string().optional(),
    })
    .strict(),
  delivery_plan_propose: z
    .object({
      plan: deliveryPlanSchema,
      path: z.string().default("delivery-plan.yaml"),
    })
    .strict(),
  delivery_plan_baseline: z
    .object({
      path: z.string().default("delivery-plan.yaml"),
      baseline: z.string().default("delivery-plan.baseline.yaml"),
    })
    .strict(),
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
  connection_setup: z
    .object({
      id: workflows.identifier,
      package: workflows.identifier,
      reference: z.string().min(1),
      sourceId: workflows.identifier,
      tenantId: workflows.identifier,
      binding: workflows.identifier.optional(),
      settings: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  connection_configure: z
    .object({
      id: workflows.identifier,
      sourceId: workflows.identifier,
      tenantId: workflows.identifier,
      settings: z.record(z.string(), z.unknown()),
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
      profile: workflows.identifier.optional(),
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
  engineering_inspect: z.object({}).strict(),
  connection_editor_read: connectionEditorReadSchema,
  connection_editor_review: connectionEditorReviewSchema,
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
  contract_location: z
    .object({ flow: workflows.identifier, table: workflows.identifier })
    .strict(),
  authoring_locations: z.object({ flow: workflows.identifier }).strict(),
  authoring_locations_batch: z
    .object({ flows: z.array(workflows.identifier).min(1).max(20) })
    .strict(),
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
      transformationSettings: z.record(z.string(), z.unknown()).optional(),
      language: z.enum(["sql", "python"]).optional(),
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
  flow_editor_create: flowEditorCreateSchema,
  flow_profiles_read: executionProfilesReadSchema,
  flow_profiles_review: executionProfilesReviewSchema,
  flow_editor_read: flowEditorReadSchema,
  flow_editor_review: flowEditorReviewSchema,
  flow_show: z.object({ id: workflows.identifier }).strict(),
  build_status: buildStatusSchema,
  build_file: buildFileSchema,
  build_review: buildReviewSchema,
  build_apply: buildApplySchema,
  build: z
    .object({
      programme: programmeSourceSchema.optional(),
      provider: z.string().optional(),
      delivery: z.boolean().default(false),
      flow: z.string().optional(),
      profile: workflows.identifier.optional(),
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
        "programme",
        "programme-manifest",
        "platform-definition",
        "platform-environment",
        "requirements-definition",
        "project",
        "source",
        "flow",
        "schedule",
        "delivery-index",
        "delivery-plan",
        "policy",
        "step",
        "environment",
        "activity",
        "provider",
        "extension-pack",
      ]),
    })
    .strict(),
  read: z
    .object({
      path: z.string(),
      slice: z
        .object({
          offset: z
            .number()
            .int()
            .min(0)
            .max(10 * 1024 * 1024),
          limit: z
            .number()
            .int()
            .min(2)
            .max(256 * 1024),
          sha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  validate: z
    .object({
      mode: z.enum(["draft", "strict"]).default("strict"),
      flow: z.string().optional(),
      profile: workflows.identifier.optional(),
      table: z.string().optional(),
      step: z.string().optional(),
    })
    .strict(),
  resolve: z
    .object({
      flow: workflows.identifier.optional(),
      profile: workflows.identifier.optional(),
    })
    .strict(),
  plan: z
    .object({
      flow: z.string().optional(),
      profile: workflows.identifier.optional(),
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
  provider_activity_inspect: z
    .object({ reference: z.string().min(1), activity: z.string().min(1) })
    .strict(),
  contract_draft: z
    .object({ metadata: z.string(), id: z.string(), out: z.string() })
    .strict(),
  contract_validate: z.object({ path: z.string() }).strict(),
  flow_configure: z
    .object({ flow: z.string(), patch: z.record(z.string(), z.unknown()) })
    .strict(),
  ingestion_configure: z
    .object({
      flow: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/),
      execution: z.record(z.string(), z.unknown()),
      sources: z
        .record(
          z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/),
          z.record(z.string(), z.unknown()),
        )
        .default({}),
    })
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
      transformationSettings: z.record(z.string(), z.unknown()).optional(),
      language: z.enum(["sql", "python"]).optional(),
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
  target_setup_review: targetSetupSchema,
  target_setup_apply: targetSetupApplySchema,
  shared_connection_review: sharedConnectionReviewSchema,
  shared_connection_apply: sharedConnectionApplySchema,
  platform_reuse_read: platformReuseReadSchema,
  platform_reuse_review: platformReuseReviewSchema,
  platform_reuse_apply: platformReuseApplySchema,
  presentation_snapshot_review: snapshotImportReviewSchema,
  presentation_snapshot_apply: snapshotImportApplySchema,
  presentation_catalogue: z.object({}).strict(),
  presentation_review: presentationReviewSchema,
  package_library: z.object({}).strict(),
  package_install_review: packageInstallReviewSchema,
  package_install_apply: packageInstallApplySchema,
  package_configure_review: packageConfigureSchema,
  provider_install_review: providerInstallSchema,
  provider_install_apply: providerInstallApplySchema,
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
      case "programme_platform_catalogue":
        result = { document: null, digest: null, catalogue: platformCatalogue };
        break;
      case "programme_secret_status":
        result = platformSecretStatus(root, args);
        break;
      case "programme_secret_set":
        write();
        result = platformSecretSet(root, args);
        break;
      case "programme_requirements_template":
        result = requirementsTemplate(args);
        break;
      case "programme_project_template":
        result = programmeProjectTemplate(args);
        break;
      case "programme_storage_inspect":
        result = inspectProgrammeStorage(root, args.id);
        break;
      case "programme_migration_review":
        result = reviewProgrammeMigration(root, args);
        break;
      case "programme_migration_apply":
        write();
        result = applyProgrammeMigration(root, args);
        break;
      case "workspace_inspect":
        result = inspectWorkspace(root);
        break;
      case "workspace_initialisation_review":
        result = reviewWorkspaceInitialisation(root, args);
        break;
      case "workspace_initialisation_apply":
        write();
        result = applyWorkspaceInitialisation(root, args);
        break;
      case "programme_read":
        result = readProgramme(root, args.id);
        if (result.document)
          result.generationReviews = (result.document.platforms ?? []).flatMap(
            (p: any) =>
              (p.configuration?.targets ?? []).map((t: any) => ({
                platform: p.id,
                provider: t.provider,
                items: reviewGeneration(t),
              })),
          );
        break;
      case "programme_definition_inspect":
        result = inspectProgrammeDefinition(root, args.id);
        break;
      case "programme_registration_propose":
        result = proposeProgrammeRegistration(root, args);
        break;
      case "programme_save":
        write();
        result = saveProgramme(
          root,
          args.id,
          args.expectedDigest,
          args.document,
        );
        if (result.document)
          result.generationReviews = (result.document.platforms ?? []).flatMap(
            (p: any) =>
              (p.configuration?.targets ?? []).map((t: any) => ({
                platform: p.id,
                provider: t.provider,
                items: reviewGeneration(t),
              })),
          );
        break;
      case "build_retained":
        result = inspectRetainedBuild({ ...context, root, environment }, args);
        break;
      case "build_retain":
        write();
        result = retainBuild({ ...context, root, environment }, args);
        break;
      case "compiler_identity":
        result = compilerIdentity();
        break;
      case "execution_features":
        result = executionFeatures();
        break;
      case "provider_configuration_inspect":
        result = inspectProviderConfiguration(
          root,
          environment,
          args.configuration,
        );
        break;
      case "provider_configuration_propose":
        result = proposeProviderConfiguration(root, environment, args);
        break;
      case "schedule_occurrences":
        result = scheduleOccurrences(args);
        break;
      case "schedule_check":
        result = {
          schedule: args.schedule,
          digest: digest(canonical(args.schedule)),
          scope: "definition",
          executionEnabled: false,
        };
        break;
      case "schedule_propose":
        result = author.configureSchedule(root, args.flow, args.schedule);
        break;
      case "schedule_inspect": {
        const found = inspectProject(root, environment, {
          draft: true,
        }).flows.find((flow) => flow.id === args.flow);
        check(found, "FLOW", "Select one existing flow identity");
        const schedule = found.schedule ?? null;
        result = {
          flow: args.flow,
          schedule,
          digest: digest(canonical(schedule)),
          scope: "definition",
          executionEnabled: false,
        };
        break;
      }
      case "governance_check":
        result = projectGovernance(
          inspectProject(root, environment, {
            ...args,
            draft: true,
          }),
          args,
        );
        break;
      case "policy_editor_read":
        result = readPolicyEditor(root);
        break;
      case "policy_editor_review":
        result = reviewPolicyEditor(root, args);
        break;
      case "policy_propose":
        result = author.configurePolicy(root, args.policy);
        break;
      case "delivery_plan_check":
        result = checkDeliveryPlan(root, args.path, args.baseline);
        break;
      case "delivery_plan_propose":
        result = proposeDeliveryPlan(root, args.plan, args.path);
        break;
      case "delivery_plan_baseline":
        result = proposeDeliveryBaseline(root, args.path, args.baseline);
        break;
      case "connection_add":
        result = author.addConnection(root, args, environment);
        break;
      case "connection_setup": {
        const registration = workflows.pluginConfigure(root, {
          reference: args.reference,
          name: args.package,
        });
        result = author.addConnection(root, args, environment, registration);
        break;
      }
      case "connection_configure":
        result = author.configureConnection(root, args, environment);
        break;
      case "connection_flows_review":
        result = proposeSourceFlows({ ...context, root, environment }, args);
        break;
      case "connection_journey":
        result = inspectSourceJourney({ ...context, root, environment }, args);
        break;
      case "connection_flow_review":
        result = proposeSourceFlow({ ...context, root, environment }, args);
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
          undefined,
          undefined,
          args.profile,
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
              `${dirname(args.discovery)}/project-connection.lock.json`,
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
        result = author.mapContractFields(root, args, reader.files);
        break;
      }
      case "connection_access":
      case "connection_runtime_prepare":
      case "connection_test":
      case "connection_inventory":
      case "connection_sample":
      case "connection_metadata":
      case "connection_contracts":
      case "connection_drafts":
      case "delivery_inspect":
      case "delivery_execution_review":
      case "delivery_execution_apply":
      case "runtime_prepare":
      case "run":
      case "scheduler_inspect":
      case "scheduler_status":
      case "scheduler_register":
      case "scheduler_tick":
      case "scheduler_pause":
      case "scheduler_cancel":
      case "scheduler_retry":
      case "checkpoint_preview":
      case "checkpoint_apply":
      case "execution_recover":
      case "execution_evidence":
      case "run_status":
      case "execution_resources":
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
      case "engineering_inspect":
        result = inspectEngineering(root, environment);
        break;
      case "connection_editor_read":
        result = readConnectionEditor(root, environment, args);
        break;
      case "connection_editor_review":
        result = reviewConnectionEditor(root, environment, args);
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
      case "contract_location":
        result = author.contractLocation(root, args.flow, args.table);
        break;
      case "authoring_locations_batch":
        result = author.authoringLocationsBatch(root, args.flows);
        break;
      case "authoring_locations":
        result = author.authoringLocations(root, args.flow);
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
      case "flow_editor_create":
        result = createFlowEditor(root, environment, args);
        break;
      case "flow_profiles_read":
        result = readExecutionProfiles(root, args);
        break;
      case "flow_profiles_review":
        result = reviewExecutionProfile(root, args);
        break;
      case "flow_editor_read":
        result = readFlowEditor(root, args.flow);
        break;
      case "flow_editor_review":
        result = reviewFlowEditor(root, args);
        break;
      case "flow_show": {
        const state = inspectProject(root, environment, { draft: true });
        result = state.flows.find((f) => f.id === args.id);
        check(result, "SELECT", `Unknown flow ${args.id}`);
        break;
      }
      case "platform_binding_inspect":
        result = inspectPlatformBindings(root, environment, args);
        break;
      case "platform_binding_propose":
        result = proposePlatformBinding(root, environment, args);
        break;
      case "platform_binding_apply":
        write();
        result = applyPlatformBinding(root, args.programme, args.proposal);
        break;
      case "build_status":
        result = inspectBuild(root, environment, args);
        break;
      case "build_file":
        result = readBuildFile(root, environment, args);
        break;
      case "build_review":
        result = reviewBuild(root, environment, args);
        break;
      case "build_apply":
        write();
        result = applyBuild(root, environment, args);
        break;
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
              programme: programmeSchema,
              "programme-manifest": programmeManifestSchema,
              "platform-definition": platformDefinitionSchema,
              "platform-environment": platformEnvironmentSchema,
              "requirements-definition": requirementsDefinitionSchema,
              project: projectSchema,
              source: workflows.sourceSchema,
              flow: flowSchema,
              schedule: scheduleSchema,
              "delivery-index": deliveryIndexSchema,
              "delivery-plan": deliveryPlanSchema,
              policy: policySchema,
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
        if (args.slice) {
          const text = result.content,
            hash = digest(text),
            { offset, limit, sha256 } = args.slice;
          check(
            !sha256 || sha256 === hash,
            "STALE",
            "File changed between read pages",
          );
          check(
            offset <= text.length,
            "SELECT",
            "Read offset exceeds file length",
          );
          const high = (value: number) => value >= 0xd800 && value <= 0xdbff,
            low = (value: number) => value >= 0xdc00 && value <= 0xdfff;
          check(
            !offset ||
              !low(text.charCodeAt(offset)) ||
              !high(text.charCodeAt(offset - 1)),
            "SELECT",
            "Read offset splits a Unicode character",
          );
          let end = Math.min(text.length, offset + limit);
          if (high(text.charCodeAt(end - 1)) && low(text.charCodeAt(end)))
            end--;
          result = {
            path: args.path,
            content: text.slice(offset, end),
            slice: {
              offset,
              ...(end < text.length ? { nextOffset: end } : {}),
              totalCharacters: text.length,
              totalBytes: Buffer.byteLength(text),
              sha256: hash,
            },
          };
        }
        break;
      case "validate": {
        if (args.mode === "draft") {
          check(
            !args.flow && !args.table && !args.step && !args.profile,
            "OPTION",
            "Draft validation checks the whole project; use strict mode for flow/table/step selection",
          );
          const state = inspectProject(root, environment, {
            ...args,
            draft: true,
          });
          result = {
            mode: "draft",
            pending: state.reader.pending,
            flows: state.flows.length,
          };
        } else {
          const state = inspectProject(root, environment, {
            ...args,
            draft: true,
          });
          const selected = state.flows.filter(
            (f) => !args.flow || f.id === args.flow,
          );
          check(selected.length > 0, "FLOW", "Unknown flow");
          // Native flows on several provider configurations (for example a
          // bridge, or ADF and Databricks together) plan as build does: a
          // coordinated delivery with one export per configuration.
          const delivery =
            !args.table &&
            !args.step &&
            new Set(
              state.flows
                .filter((f) => !isPortableConnection(state.project, f))
                .map((f) => f.provider ?? state.project.defaults.provider),
            ).size > 1;
          const connected = selected.filter((f) =>
            isPortableConnection(state.project, f),
          );
          if (connected.length) {
            check(
              !args.table && !args.step,
              "CONNECTION",
              "Validate connector flows as a whole",
            );
            const checks = connected.map((f) =>
              prepareConnection(
                root,
                environment,
                f.id,
                true,
                undefined,
                undefined,
                args.profile,
              ),
            );
            // Validate native flows as one complete target. Selecting each flow
            // separately makes providers that own shared resources reject an
            // otherwise valid full project as an unsafe partial deployment.
            if (selected.some((f) => !isPortableConnection(state.project, f)))
              planProject(root, environment, {
                ...args,
                nativeOnly: true,
                // One export per configuration, as build groups them.
                ...(delivery ? { delivery, projectBuild: true } : {}),
              });
            const coverage = qualityCoverage(root, state, selected as any);
            checkCoverage(
              coverage,
              state.project.defaults.quality?.unsupported,
            );
            const sources = sourceRouting(root, state, selected as any);
            checkRoutes(sources);
            result = {
              mode: "strict",
              evidence: "offline",
              connections: checks,
              dataProducts: dataProducts(selected as any),
              quality: { summary: coverageSummary(coverage), rules: coverage },
              sources,
            };
            break;
          }
          const plan = planProject(root, environment, {
            ...args,
            // One export per configuration, as build groups them.
            ...(delivery ? { delivery, projectBuild: true } : {}),
          });
          const coverage = qualityCoverage(root, state, selected as any);
          checkCoverage(coverage, state.project.defaults.quality?.unsupported);
          const sources = sourceRouting(root, state, selected as any);
          result = {
            mode: "strict",
            nodes: plan.nodes.length,
            digest: plan.digest,
            evidence: "offline",
            dataProducts: dataProducts(selected as any),
            quality: { summary: coverageSummary(coverage), rules: coverage },
            ...(sources.length ? { sources } : {}),
          };
        }
        break;
      }
      case "resolve": {
        const state = inspectProject(root, environment, {
          ...args,
          draft: true,
        });
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
      case "provider_activity_inspect":
        result = development.providerActivityInspect(
          root,
          args.reference,
          args.activity,
        );
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
      case "ingestion_configure":
        result = author.configureIngestion(root, args);
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
      case "target_setup_review":
        result = reviewTargetSetup(root, args);
        break;
      case "target_setup_apply":
        write();
        result = applyTargetSetup(root, args);
        break;
      case "shared_connection_review":
        result = reviewSharedConnection(root, environment, args);
        break;
      case "shared_connection_apply":
        write();
        result = applySharedConnection(root, args.programme, args.review);
        break;
      case "platform_reuse_read":
        result = inspectPlatformReuse(root, environment, args);
        break;
      case "platform_reuse_review":
        result = reviewPlatformReuse(root, environment, args);
        break;
      case "platform_reuse_apply":
        write();
        result = applyPlatformReuse(root, args.programme, args.review);
        break;
      case "presentation_snapshot_review":
        result = reviewSnapshotImport(root, args);
        break;
      case "presentation_snapshot_apply":
        write();
        result = applySnapshotImport(root, args);
        break;
      case "presentation_catalogue":
        result = inspectPresentations(root, environment);
        break;
      case "presentation_review":
        result = reviewPresentation(root, environment, args);
        break;
      case "package_library":
        result = inspectPackageLibrary(root);
        break;
      case "package_configure_review":
        result = reviewPackageConfiguration(root, args);
        break;
      case "package_install_review":
      case "package_install_apply":
        if (operation === "package_install_apply") write();
        check(
          context.allowNetwork || args.fromGit,
          "PERMISSION",
          "Package access requires explicit package-network permission",
        );
        if (args.fromGit && !context.allowNetwork)
          args.fromGit = fence(root, args.fromGit);
        result =
          operation === "package_install_review"
            ? reviewPackageInstall(root, args)
            : applyPackageInstall(root, args);
        break;
      case "provider_install_review":
      case "provider_install_apply":
        if (operation === "provider_install_apply") write();
        check(
          context.allowNetwork || args.fromGit,
          "PERMISSION",
          "Provider package access requires explicit package-network permission",
        );
        if (args.fromGit && !context.allowNetwork)
          args.fromGit = fence(root, args.fromGit);
        result =
          operation === "provider_install_review"
            ? reviewProviderInstall(root, args)
            : applyProviderInstall(root, args);
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
  const asyncSchemas = {
    ...deliverySchemas,
    ...executionSchemas,
    ...sourceAccessSchemas,
    ...schedulerSchemas,
    ...workerSchemas,
  };
  if (!Object.hasOwn(asyncSchemas, operation))
    return execute(context, operation, request);
  try {
    const name = operation as keyof typeof asyncSchemas;
    const parsed = asyncSchemas[name].safeParse(request);
    check(
      parsed.success,
      "SCHEMA",
      parsed.error?.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ") ?? "Invalid execution request",
    );
    const result = Object.hasOwn(deliverySchemas, name)
      ? await performDelivery(
          context,
          name as keyof typeof deliverySchemas,
          parsed.data,
        )
      : Object.hasOwn(workerSchemas, name)
        ? await performSchedulerWorker(
            context,
            name as keyof typeof workerSchemas,
            parsed.data,
          )
        : Object.hasOwn(schedulerSchemas, name)
          ? await performScheduler(
              context,
              name as keyof typeof schedulerSchemas,
              parsed.data,
            )
          : Object.hasOwn(sourceAccessSchemas, name)
            ? await performSourceAccess(
                context,
                name as keyof typeof sourceAccessSchemas,
                parsed.data,
              )
            : await performExecution(
                context,
                name as keyof typeof executionSchemas,
                parsed.data,
              );
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
