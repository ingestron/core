import { readFileSync } from "node:fs";
import { fence } from "./packages.js";
import { connectorPackageSchema } from "./connector-package.js";
import { contractColumns } from "./contracts.js";
import { resolveModelContracts } from "./model-packs.js";
/** Project-owned configuration; schemas and runtime assets remain plugin-owned. */
import { Ajv2020 } from "ajv/dist/2020.js";
import { Configuration } from "./config.js";
import { projectSchema, flowSchema } from "./schema.js";
import { projectPackages } from "./project-packages.js";
import { canonical, check, digest, isMap } from "./errors.js";
import {
  configuredPackageReference,
  resolvePackage,
  packageYaml,
  providerPackageSchema,
} from "./packages.js";
import { checkProviderCompatibility } from "../plugins/compatibility.js";
import {
  runProviderCommand,
  validateSchemaShape,
} from "./provider-commands.js";

function validate(schema: any, value: unknown, label: string) {
  validateSchemaShape(schema);
  const ajv = new Ajv2020({ strict: true, validateFormats: false });
  const fn = ajv.compile(schema);
  check(fn(value), "CONNECTION", `${label}: ${ajv.errorsText(fn.errors)}`);
}

export function prepareConnection(
  root: string,
  environment: string,
  flowId: string,
  validateOnly = false,
  reviewFile?: string,
  configureExecution?: (execution: Record<string, any>) => Record<string, any>,
) {
  // Do not interpolate $env here: connection credentials must never enter compiler memory/output.
  const reader = new Configuration(root, {});
  const project = reader.parse(projectSchema, reader.load());
  const profile = project.environments[environment];
  check(profile, "ENVIRONMENT", `Unknown environment ${environment}`);
  check(
    !profile.environment || profile.environment === environment,
    "ENVIRONMENT",
    "Environment name differs from selected profile",
  );
  const flows = project.flows.map((f) => reader.parse(flowSchema, f));
  resolveModelContracts(reader, project, flows);
  check(
    new Set(flows.map((f) => f.id)).size === flows.length,
    "FLOW",
    "Duplicate flow IDs",
  );
  const flow = flows.find((f) => f.id === flowId);
  check(
    flow && flow.kind === "ingestion" && !flow.steps,
    "FLOW",
    "Select an ingestion flow",
  );
  const ingestion = flow.ingestion!;
  check(
    isMap(ingestion) &&
      Object.keys(ingestion).every((k) =>
        ["connection", "execution", "timeoutSeconds"].includes(k),
      ),
    "CONNECTION",
    "Connection ingestion accepts connection, execution and timeoutSeconds only",
  );
  check(
    !Object.keys(flow.requires).length && !Object.keys(flow.publishes).length,
    "CONNECTION",
    "Downstream dataset handovers require reviewed contracts",
  );
  const connection = project.connections[String(ingestion.connection)];
  check(connection, "CONNECTION", "Unknown ingestion connection");
  const configured =
    project.providers.configurations[
      flow.provider ?? project.defaults.provider ?? ""
    ];
  check(configured, "PROVIDER", "Select the execution provider configuration");
  const packages = projectPackages(project);
  const owner = packages[connection.package];
  const executor = packages[configured.package];
  check(owner && executor, "PACKAGE", "Unknown connection/execution package");
  const load = (pkg: typeof owner) => {
    const ref = configuredPackageReference(pkg);
    const locked = resolvePackage(root, ref);
    const manifest = providerPackageSchema.parse(packageYaml(locked.file));
    checkProviderCompatibility(manifest);
    return { ref, locked, manifest };
  };
  const sourceRef = configuredPackageReference(owner);
  const sourceLock = resolvePackage(root, sourceRef);
  const sourceRaw = packageYaml(sourceLock.file);
  check(
    sourceRaw.apiVersion === "ingestron.connector/v1",
    "CONNECTION",
    "Select an independently installed source connector package",
  );
  const connectorPackage = connectorPackageSchema.parse(sourceRaw);
  const source = { ref: sourceRef, locked: sourceLock };
  const target = load(executor);
  const connector = connectorPackage.connector;
  check(
    !connection.connector || connection.connector === connector,
    "CONNECTION",
    "Connection must use the exact installed connector identity",
  );
  check(
    connectorPackage.upstream.licenceStatus === "evidenced",
    "LICENCE",
    "Connector licence evidence is unresolved",
  );
  const descriptor = connectorPackage.definition;
  const runtimeContract = connectorPackage.runtime.contract;
  const adapter = target.manifest.connectorRuntimes?.[runtimeContract];
  check(
    adapter &&
      adapter.executionPlatforms.includes(target.manifest.platform) &&
      Object.hasOwn(connectorPackage.execution, target.manifest.platform),
    "CONNECTION",
    "Selected execution provider does not support this connector runtime",
  );
  const binding = connection.binding
    ? profile.bindings[connection.binding]
    : {};
  check(binding, "CONNECTION", "Missing connection environment binding");
  let settings = { ...connection.settings, ...binding };
  const rejectEnvironment = (v: any): void => {
    if (Array.isArray(v)) return v.forEach(rejectEnvironment);
    if (!isMap(v)) return;
    check(
      !Object.hasOwn(v, "$env"),
      "SECRET",
      "Use runtime $secret references, not compiler $env values, in connections",
    );
    Object.values(v).forEach(rejectEnvironment);
  };
  rejectEnvironment(settings);
  const context = {
    env: environment,
    project: { id: project.id },
    values: profile.values,
  };
  settings = reader.values(settings, context);
  rejectEnvironment(settings);
  validate(descriptor.settingsSchema, settings, "Connection settings");
  check(
    flow.tables && Object.keys(flow.tables).length > 0,
    "CONNECTION",
    "Select at least one table with an ODCS contract",
  );
  const streams = new Set<string>();
  const tables = Object.fromEntries(
    Object.entries(flow.tables).map(([name, table]) => {
      const source = descriptor.tableSourceSchema
        ? { ...table.source, stream: name }
        : table.source;
      if (descriptor.tableSourceSchema)
        validate(descriptor.tableSourceSchema, table.source, `${name} source`);
      else
        check(
          Object.keys(table.source).length === 1 &&
            typeof table.source.stream === "string",
          "CONNECTION",
          `${name}: source must identify one connector stream`,
        );
      check(
        typeof source.stream === "string",
        "CONNECTION",
        `${name}: invalid source stream`,
      );
      check(
        !streams.has(source.stream),
        "CONNECTION",
        "Duplicate source stream",
      );
      streams.add(source.stream);
      check(
        !table.ingestion && !Object.keys(table.steps).length,
        "CONNECTION",
        "Connection tables do not accept ingestion/step overrides",
      );
      return [
        name,
        {
          source,
          contract: table.contract,
          columns: contractColumns(table.contract),
        },
      ];
    }),
  );
  rejectEnvironment(ingestion.execution);
  let execution = reader.values(
    ingestion.execution ?? { mode: "local" },
    context,
  );
  rejectEnvironment(execution);
  if (configureExecution) execution = configureExecution(execution);
  else if (target.manifest.projectAssembly) {
    const configuration = flow.provider ?? project.defaults.provider!;
    const configured = project.providers.configurations[configuration];
    const result: any = runProviderCommand(root, environment, {
      configuration,
      command: target.manifest.projectAssembly.command,
      input: {
        phase: "configure",
        project: project.id,
        environment,
        configuration,
        flow: flowId,
        scope: { id: "full", partial: false },
        execution,
        binding: profile.bindings[configured.binding],
        options: configured.options,
      },
    });
    check(
      isMap(result.result?.execution),
      "PROVIDER",
      "Invalid project execution configuration",
    );
    execution = result.result.execution;
  }
  rejectEnvironment(execution);
  validate(adapter.executionSchema, execution, "Execution settings");
  check(
    connectorPackage.execution[target.manifest.platform]?.modes.includes(
      execution.mode,
    ),
    "CONNECTION",
    "Connector package does not support the selected execution mode",
  );
  const timeoutSeconds = ingestion.timeoutSeconds ?? 600;
  check(
    Number.isInteger(timeoutSeconds) &&
      Number(timeoutSeconds) >= 1 &&
      Number(timeoutSeconds) <= 604800,
    "CONNECTION",
    "Timeout must be 1–604800 seconds",
  );

  const asset = connectorPackage.runtime;
  check(
    Object.hasOwn(sourceLock.entry.files, asset.path),
    "PACKAGE",
    "Runtime asset is not locked",
  );
  const content = readFileSync(fence(sourceLock.root, asset.path), "utf8");
  check(
    digest(content) === asset.sha256,
    "PACKAGE",
    "Runtime asset digest mismatch",
  );
  const parsed = JSON.parse(content);
  check(
    isMap(parsed) &&
      Object.keys(parsed).length <= 100 &&
      Object.entries(parsed).every(
        ([name, value]) =>
          /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) &&
          typeof value === "string",
      ),
    "PACKAGE",
    "Invalid runtime asset map",
  );
  const runtimeAssets = parsed;
  const specification = {
    runtimeContract,
    runtimeAssetSha256: connectorPackage.runtime.sha256,
    apiVersion: "ingestron.connection-request/v1",
    project: project.id,
    environment,
    flow: flowId,
    connection: String(ingestion.connection),
    connector,
    sourceId: connection.sourceId,
    tenantId: connection.tenantId,
    settings,
    tables,
    execution,
    timeoutSeconds,
    sourcePackage: {
      reference: source.ref,
      commit: source.locked.entry.commit,
    },
    executionPackage: {
      reference: target.ref,
      commit: target.locked.entry.commit,
    },
  };
  const input = {
    ...specification,
    specificationSha256: digest(canonical(specification)),
  };
  if (reviewFile) {
    const review = JSON.parse(reader.text(reviewFile));
    check(
      review.status === "approved" &&
        review.identity?.projectSpecSha256 === input.specificationSha256,
      "CONNECTION",
      "Review does not match the current project specification",
    );
    check(
      canonical(review.contracts) ===
        canonical(
          Object.fromEntries(
            Object.entries(flow.tables!).map(([name, table]) => [
              name,
              table.contract,
            ]),
          ),
        ),
      "CONNECTION",
      "Review selection differs from project",
    );
    check(
      adapter.contractsCommand,
      "CONNECTION",
      "Provider does not declare contract export",
    );
    return runProviderCommand(root, environment, {
      configuration: flow.provider ?? project.defaults.provider!,
      command: adapter.contractsCommand,
      input: { review },
    });
  }
  const result = runProviderCommand(root, environment, {
    configuration: flow.provider ?? project.defaults.provider!,
    command: adapter.prepareCommand,
    input: { ...input, runtimeAssets },
  });
  return validateOnly
    ? {
        valid: true,
        specificationSha256: input.specificationSha256,
        sourceBoundarySha256: digest(
          canonical({
            ...specification,
            tables: Object.fromEntries(
              Object.entries(tables).map(([name, table]: [string, any]) => [
                name,
                table.source,
              ]),
            ),
          }),
        ),
        connection: input.connection,
        flow: flowId,
      }
    : result;
}
