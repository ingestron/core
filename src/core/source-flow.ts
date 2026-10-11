import { sourceBridgeSchema, attachSourceBridge } from "./source-bridge.js";
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseDocument, stringify, isSeq } from "yaml";
import { z } from "zod";
import { projectPackages } from "./project-packages.js";
import { Configuration } from "./config.js";
import { check, digest, canonical } from "./errors.js";
import { preview } from "./authoring.js";
import { auditSecrets } from "./planner.js";
import { contractColumns } from "./contracts.js";
import {
  fence,
  resolvePackage,
  packageYaml,
  configuredPackageReference,
} from "./packages.js";
import { identifier, pluginConfigure } from "./workflows.js";
import { sourceAccessDefinition } from "./source-access.js";
import type { Context } from "./operations.js";

export const sourceFlowSchema = z
  .object({
    id: identifier,
    connection: identifier,
    executor: z.string().min(1).optional(),
    bridge: sourceBridgeSchema.optional(),
    receipt: z.string().uuid(),
    provider: identifier.optional(),
    runtime: z.string().min(1).optional(),
    target: z
      .object({
        provider: identifier,
        source: z.record(z.string(), z.unknown()),
        ingestion: z
          .record(z.string(), z.unknown())
          .and(z.object({ standard: z.string().min(1) })),
      })
      .strict()
      .optional(),
    tables: z
      .array(
        z
          .object({
            id: z.string().min(1),
            table: identifier,
            contract: z.string().min(1),
            receipt: z.string().uuid().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

/** One offline, reviewable proposal. Source mappings come from saved metadata. */
export function proposeSourceFlow(
  context: Context,
  args: z.infer<typeof sourceFlowSchema>,
) {
  check(
    !args.bridge ||
      (args.target &&
        !Object.keys(args.target.source).length &&
        !args.provider &&
        !args.runtime),
    "PROFILE",
    "A native bridge needs a target and does not create a local test profile",
  );
  const root = resolve(context.root),
    reader = new Configuration(root);
  const def = sourceAccessDefinition(context, {
    connection: args.connection,
    ...(args.executor ? { executor: args.executor } : {}),
  });
  check(
    !def.unsupported && def.fingerprint,
    "CAPABILITY",
    "Select a portable source with current metadata",
  );
  const inputs: Record<string, string> = {};
  const receipts = new Map<string, any>();
  const metadata = (id: string) => {
    if (receipts.has(id)) return receipts.get(id);
    const path = `.ingestron/source-access/${id}.json`;
    const text = reader.text(path),
      receipt = JSON.parse(text);
    check(
      receipt.apiVersion === "ingestron.source-access-receipt/v1" &&
        receipt.action === "metadata" &&
        receipt.status === "succeeded" &&
        receipt.connection === args.connection &&
        receipt.environment === (context.environment ?? "dev") &&
        receipt.fingerprint === def.fingerprint &&
        receipt.result?.status === "succeeded",
      "STALE",
      "Metadata no longer matches this source and environment",
    );
    inputs[path] = digest(text);
    receipts.set(id, receipt);
    return receipt;
  };
  metadata(args.receipt);
  const parsed = def.project;
  auditSecrets(parsed.connections, "connections");
  auditSecrets(parsed.environments, "environments");
  check(
    !parsed.flows.some((flow: any) => flow.id === args.id),
    "OWNER",
    `Flow ${args.id} already exists`,
  );
  const flowPath = `flows/${args.id}/flow.yaml`;
  check(
    !existsSync(fence(root, flowPath)),
    "OWNER",
    `Flow file ${flowPath} already exists`,
  );
  check(
    new Set(args.tables.map((t) => t.id)).size === args.tables.length &&
      new Set(args.tables.map((t) => t.table)).size === args.tables.length,
    "SELECT",
    "Choose each source object and output table only once",
  );
  const replacements: Record<string, string> = {};
  check(
    args.target || args.provider,
    "PROVIDER",
    "Choose a target platform or explicitly opt into local execution",
  );
  check(
    !args.runtime || args.provider,
    "PROVIDER",
    "A local runtime requires an explicit local provider selection",
  );
  if (args.provider && !parsed.providers.configurations[args.provider]) {
    check(
      args.runtime,
      "PROVIDER",
      "Select an installed local runtime or configured provider",
    );
    const manifest = packageYaml(resolvePackage(root, args.runtime!).file);
    check(
      manifest.platform === "local",
      "PROVIDER",
      "Automatic configuration is limited to an explicitly selected local provider",
    );
    for (const change of pluginConfigure(root, {
      reference: args.runtime,
      name: args.provider,
    }).changes)
      replacements[change.path] = change.after;
  } else if (args.provider) {
    const config = parsed.providers.configurations[args.provider];
    const pkg = projectPackages(parsed)[config.package];
    check(
      pkg &&
        packageYaml(resolvePackage(root, configuredPackageReference(pkg)).file)
          .platform === "local",
      "PROVIDER",
      "This reviewed source handoff requires a local provider",
    );
    check(
      !args.runtime,
      "PROVIDER",
      "Use the existing configuration without replacing its runtime",
    );
  }
  if (args.target) {
    auditSecrets(args.target, "target");
    const config = parsed.providers.configurations[args.target.provider];
    check(config, "PROVIDER", "Choose a configured target provider");
    const pkg = projectPackages(parsed)[config.package];
    check(pkg, "PROVIDER", "The target configuration requires a package");
    const manifest = packageYaml(
      resolvePackage(root, configuredPackageReference(pkg)).file,
    );
    check(
      manifest.platform !== "local",
      "PROVIDER",
      "The target profile requires a target platform provider",
    );
    const standard = manifest.standards?.find(
      (standard: any) => standard.id === args.target!.ingestion.standard,
    );
    check(
      standard,
      "STANDARD",
      "Choose a standard declared by the target provider",
    );
    const kind = args.target.source.kind;
    check(
      !!args.bridge ||
        !standard.sourceKinds ||
        standard.sourceKinds.includes(kind as string),
      "STANDARD",
      "The target standard does not support the selected source kind",
    );
    check(
      !("connection" in args.target.ingestion) &&
        !("execution" in args.target.ingestion),
      "PROFILE",
      "Target settings cannot replace the local connector execution binding",
    );
    check(
      !("table" in args.target.source) && !("schema" in args.target.source),
      "PROFILE",
      "Target settings cannot replace shared table identity",
    );
  }
  const tables: Record<string, unknown> = {};
  for (const selected of args.tables) {
    const discovered = metadata(
      selected.receipt ?? args.receipt,
    ).result.tables?.find((t: any) => t.id === selected.id);
    check(
      discovered?.columns?.length && discovered.source,
      "DISCOVERY",
      "Selected object is absent from this metadata receipt",
    );
    check(
      selected.contract.startsWith(
        `contracts/discovery/${context.environment ?? "dev"}/${args.connection}/`,
      ) &&
        /^contracts\/discovery\/[\w-]+\/[\w-]+\/[0-9a-f-]{36}\/[\w-]+\.odcs\.yaml$/.test(
          selected.contract,
        ),
      "PATH",
      "Select an isolated contract draft for this source",
    );
    const text = reader.text(selected.contract),
      contract = reader.load(selected.contract);
    const columns = contractColumns(contract, selected.contract);
    check(
      !args.bridge ||
        (columns.some((c) => c.key) &&
          columns.filter((c) => c.key).every((c) => c.required)),
      "ODCS",
      "Snapshot publication needs explicitly reviewed, required primary keys on every selected contract",
    );
    check(
      contract.schema.length === 1 &&
        contract.schema[0].name === selected.table,
      "ODCS",
      "Contract table must match the selected output table",
    );
    inputs[selected.contract] = digest(text);
    const ref = relative(
      dirname(resolve(root, flowPath)),
      fence(root, selected.contract),
    ).replaceAll("\\", "/");
    tables[selected.table] = {
      source: discovered.source,
      contract: { $resolve: ref.startsWith(".") ? ref : `./${ref}` },
    };
  }
  const project = parseDocument(
    replacements["project.yaml"] ?? reader.text("project.yaml"),
  );
  if (!project.has("flows")) project.set("flows", []);
  const registry = project.get("flows", true);
  check(
    isSeq(registry),
    "FLOW",
    "Flow creation requires a project-owned flow list",
  );
  registry.add({ $resolve: `./${flowPath}` });
  replacements["project.yaml"] = project.toString();
  replacements[flowPath] = stringify({
    apiVersion: "ingestron.flow/v1",
    kind: "ingestion",
    id: args.id,
    provider: args.target?.provider ?? args.provider!,
    ...(args.target ? { defaults: { source: args.target.source } } : {}),
    ingestion: args.target?.ingestion ?? {
      connection: args.connection,
      execution: { mode: "local" },
    },
    ...(args.provider && args.target
      ? {
          executionProfiles: {
            local_test: {
              provider: args.provider,
              source: {},
              ingestion: {
                connection: args.connection,
                execution: { mode: "local" },
              },
            },
          },
        }
      : {}),
    tables,
  });
  const proposal = preview(root, replacements, inputs);
  return args.bridge
    ? attachSourceBridge(
        root,
        context.environment ?? "dev",
        {
          id: args.id,
          connection: args.connection,
          target: args.target!,
          bridge: args.bridge,
        },
        proposal,
      )
    : proposal;
}

export const sourceFlowsSchema = sourceFlowSchema.extend({
  tables: z.array(sourceFlowSchema.shape.tables.element).min(1).max(500),
  groupFields: z.array(identifier).min(1).max(10).optional(),
});

/** Deterministic bounded flows in one proposal; earlier groups never overwrite later registry edits. */
export function proposeSourceFlows(
  context: Context,
  args: z.infer<typeof sourceFlowsSchema>,
) {
  check(
    !args.bridge || args.tables.length <= 100,
    "LIMIT",
    "Choose at most 100 contracts per reviewed bridge flow",
  );
  const objects = [...args.tables].sort((a, b) =>
    a.table < b.table ? -1 : a.table > b.table ? 1 : 0,
  );
  check(
    new Set(objects.map((object) => object.id)).size === objects.length &&
      new Set(objects.map((object) => object.table)).size === objects.length,
    "SELECT",
    "Choose each source object and output table only once across all groups",
  );
  check(
    new Set([
      args.receipt,
      ...objects.map((object) => object.receipt ?? args.receipt),
    ]).size <= 20,
    "LIMIT",
    "Choose at most 20 current metadata batches in one flow proposal",
  );
  check(
    !args.groupFields ||
      (args.target &&
        new Set(args.groupFields).size === args.groupFields.length &&
        args.groupFields.every(
          (key) =>
            !["standard", "connection", "execution"].includes(key) &&
            typeof args.target!.ingestion[key] === "string" &&
            args.target!.ingestion[key] !== "",
        )),
    "PROFILE",
    "Grouping fields must name distinct nonempty native resource names in ingestion settings",
  );
  const { groupFields, ...baseArgs } = args;
  const count = Math.ceil(objects.length / 100);
  check(
    count === 1 || args.id.length <= 96,
    "FLOW",
    "Use a group prefix of at most 96 characters",
  );
  const replacements: Record<string, string> = {},
    inputs: Record<string, string> = {};
  let registry: ReturnType<typeof parseDocument> | undefined,
    common: string | undefined;
  for (let index = 0; index < count; index++) {
    const id =
      count === 1
        ? args.id
        : `${args.id}_${String(index + 1).padStart(3, "0")}`;
    const proposal = proposeSourceFlow(context, {
      ...baseArgs,
      id,
      ...(args.target && count > 1
        ? {
            target: {
              ...args.target,
              ingestion: {
                ...args.target.ingestion,
                ...Object.fromEntries(
                  (groupFields ?? []).map((key) => [
                    key,
                    `${args.target!.ingestion[key]}_${String(index + 1).padStart(3, "0")}`,
                  ]),
                ),
              },
            },
          }
        : {}),
      tables: objects.slice(index * 100, (index + 1) * 100),
    });
    for (const [path, hash] of Object.entries(proposal.inputs ?? {})) {
      check(
        !inputs[path] || inputs[path] === hash,
        "STALE",
        "Reviewed source inputs changed while grouping",
      );
      inputs[path] = hash;
    }
    const project = proposal.changes.find(
      (change) => change.path === "project.yaml",
    );
    check(
      project,
      "PROJECT",
      "Flow proposal did not include the project registry",
    );
    const document = parseDocument(project.after),
      value = document.toJS();
    const { flows, ...configuration } = value;
    const shape = canonical(configuration);
    check(
      common === undefined || common === shape,
      "CONFLICT",
      "Grouped flows require one consistent project configuration",
    );
    common = shape;
    if (!registry) registry = document;
    else {
      const sequence = registry.get("flows", true);
      check(
        isSeq(sequence),
        "FLOW",
        "Grouped flows require a project-owned flow list",
      );
      sequence.add(flows.at(-1));
    }
    for (const change of proposal.changes) {
      if (change.path === "project.yaml") continue;
      check(
        !Object.hasOwn(replacements, change.path) ||
          replacements[change.path] === change.after,
        "OWNER",
        "Grouped source flows have conflicting output ownership",
      );
      replacements[change.path] = change.after;
    }
  }
  replacements["project.yaml"] = registry!.toString();
  return preview(context.root, replacements, inputs);
}
