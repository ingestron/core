/** Source access is explicit and independent of flows, builds and delivery targets. */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  renameSync,
} from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { z } from "zod";
import { Ajv2020 } from "ajv/dist/2020.js";
import { stringify } from "yaml";
import { Configuration } from "./config.js";
import {
  resolveConnectionSettings,
  connectionSecretNames,
} from "./connection-settings.js";
import { projectSchema } from "./schema.js";
import { projectPackages } from "./project-packages.js";
import { connectorPackageSchema } from "./connector-package.js";
import {
  fence,
  resolvePackage,
  packageYaml,
  configuredPackageReference,
  installedProviders,
} from "./packages.js";
import { check, digest, canonical, Problem } from "./errors.js";
import { validateSchemaShape } from "./provider-commands.js";
import { launch } from "./execution.js";
import { ExecutionUncertainFailure } from "./execution-outcome.js";
import { draftContract } from "./discovery.js";
import type { Context } from "./operations.js";
const id = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/);
const selection = { connection: id, executor: z.string().optional() };
const access = {
  ...selection,
  python: z.string().optional(),
  envFile: z.string().optional(),
};
const source = z.record(z.string(), z.unknown());
export const sourceAccessSchemas = {
  connection_access: z.object(selection).strict(),
  connection_runtime_prepare: z.object(access).strict(),
  connection_test: z.object({ ...access, source: source.optional() }).strict(),
  connection_inventory: z
    .object({
      ...access,
      query: z.string().max(128).default(""),
      schema: z.string().max(128).default(""),
      scope: source.optional(),
      cursor: z.string().max(4000).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    })
    .strict(),
  connection_sample: z
    .object({
      ...access,
      source,
      limit: z.number().int().min(1).max(50).default(20),
      columns: z.array(z.string().min(1).max(128)).min(1).max(100).optional(),
    })
    .strict(),
  connection_metadata: z
    .object({
      ...access,
      tables: z.array(source).min(1).max(100),
      options: source.optional(),
    })
    .strict(),
  connection_drafts: z
    .object({
      ...access,
      tables: z
        .array(z.object({ source, name: id }).strict())
        .min(1)
        .max(500),
      acceptKeys: z.boolean().default(false),
      options: source.optional(),
    })
    .strict(),
  connection_contracts: z
    .object({
      ...selection,
      receipt: z.string().uuid(),
      tables: z
        .array(z.object({ id: z.string().max(100), name: id }).strict())
        .min(1)
        .max(100),
      acceptKeys: z.boolean().default(false),
    })
    .strict(),
};
const column = z
  .object({
    name: z.string().min(1).max(128),
    type: z.enum([
      "integer",
      "decimal",
      "number",
      "boolean",
      "string",
      "date",
      "timestamp",
    ]),
    nullable: z.boolean(),
    key: z.boolean().optional(),
    supported: z.boolean().optional(),
    sourceType: z.string().max(100).optional(),
    precision: z.number().int().optional(),
    scale: z.number().int().optional(),
  })
  .strict();
const table = z
  .object({
    id: z.string().regex(/^table_[a-f0-9]{16}$/),
    name: z.string().min(1).max(300),
    source,
    kind: z.enum(["table", "view", "object", "file"]),
    columns: z.array(column).max(500).optional(),
    sampling: z
      .object({
        method: z.literal("bounded-records"),
        rowCount: z.number().int().min(1).max(50),
        limit: z.number().int().min(1).max(50),
        byteLimit: z.number().int().min(1).max(1048576),
        truncated: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
const response = z
  .object({
    apiVersion: z.literal("ingestron.source-access-result/v1"),
    status: z.enum(["succeeded", "unsupported", "failed"]),
    action: z.enum(["test", "inventory", "metadata", "sample"]),
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,40}$/)
      .optional(),
    scope: z.enum(["authentication", "connection", "metadata", "file", "data"]),
    sample: z
      .object({
        columns: z.array(z.string().min(1).max(128)).min(1).max(100),
        rows: z
          .array(
            z
              .array(
                z.union([
                  z.string().max(500),
                  z.number().finite(),
                  z.boolean(),
                  z.null(),
                ]),
              )
              .max(100),
          )
          .max(50),
        truncated: z.boolean(),
      })
      .strict()
      .optional(),
    tables: z.array(table).max(200).default([]),
    nextCursor: z.string().max(4000).optional(),
  })
  .strict();
export function sourceAccessDefinition(context: Context, args: any) {
  const reader = new Configuration(resolve(context.root), {});
  const project = reader.parse(projectSchema, reader.load());
  const environment = context.environment ?? "dev";
  const profile = project.environments[environment];
  check(profile, "ENVIRONMENT", "Unknown selected environment");
  const connection = project.connections[args.connection];
  check(connection, "CONNECTION", "Unknown source connection");
  if (
    !connection.package ||
    ["native", "bridge"].includes(connection.route ?? "")
  )
    return { project, environment, unsupported: true as const };
  const pkg = projectPackages(project)[connection.package];
  check(pkg, "PACKAGE", "Unknown source package configuration");
  const reference = configuredPackageReference(pkg);
  const locked = resolvePackage(reader.root, reference);
  const manifest = connectorPackageSchema.parse(packageYaml(locked.file));
  check(
    !connection.connector || connection.connector === manifest.connector,
    "CONNECTION",
    "Connection differs from installed connector identity",
  );
  check(
    manifest.upstream.licenceStatus === "evidenced",
    "LICENCE",
    "Connector licence evidence is unresolved",
  );
  const settings = resolveConnectionSettings(
    reader,
    project,
    environment,
    connection,
    manifest.definition.settingsSchema,
  );
  const candidates = installedProviders(reader.root).filter(
    (p) => p.sourceAccess,
  );
  const executor =
    candidates.find((p) => p.reference === args.executor) ??
    (!args.executor && candidates.length === 1 ? candidates[0] : undefined);
  const fingerprint = digest(
    canonical({
      project: project.id,
      environment,
      connection,
      settings,
      source: {
        reference,
        commit: locked.entry.commit,
        runtime: manifest.runtime.sha256,
      },
      executor: executor && {
        reference: executor.reference,
        commit: executor.commit,
      },
    }),
  );
  return {
    reader,
    project,
    environment,
    connection,
    settings,
    manifest,
    locked,
    reference,
    executor,
    fingerprint,
    unsupported: false as const,
  };
}
function credentials(context: Context, args: any, settings: any) {
  const names = connectionSecretNames(settings);
  const env: NodeJS.ProcessEnv = { PYTHONDONTWRITEBYTECODE: "1" };
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "SSL_CERT_FILE",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
  ])
    if (process.env[name]) env[name] = process.env[name];
  const values = args.envFile
    ? parseEnv(readFileSync(fence(context.root, args.envFile), "utf8"))
    : {};
  for (const name of names) {
    const value = values[name] ?? process.env[name];
    check(
      typeof value === "string" && value.length > 0 && value.length <= 1000000,
      "SECRET",
      `Missing runtime secret ${name}`,
    );
    env[name] = value;
  }
  return env;
}
export async function performSourceAccess(
  context: Context,
  operation: keyof typeof sourceAccessSchemas,
  args: any,
) {
  if (operation === "connection_drafts")
    return draftSourceSelection(context, args);
  const root = resolve(context.root);
  const def = sourceAccessDefinition(context, args);
  if (operation === "connection_access")
    return {
      apiVersion: "ingestron.source-access-info/v1",
      connection: args.connection,
      actions: def.unsupported
        ? []
        : (def.manifest.sourceAccess?.actions ?? []),
      inventoryScopeSchema: def.unsupported
        ? undefined
        : def.manifest.sourceAccess?.inventoryScopeSchema,
      metadataOptionsSchema: def.unsupported
        ? undefined
        : def.manifest.sourceAccess?.metadataOptionsSchema,
      executor: def.unsupported ? undefined : def.executor?.reference,
      fingerprint: def.unsupported ? undefined : def.fingerprint,
      reason: def.unsupported
        ? "Native or bridge connections require their platform's access adapter or an imported metadata export."
        : !def.manifest.sourceAccess
          ? "This locked connector release has no source access methods; upgrade to a qualified release."
          : !def.executor
            ? "Install an exact-version source-access execution provider."
            : undefined,
    };
  check(
    !def.unsupported && def.manifest.sourceAccess && def.executor,
    "CAPABILITY",
    "Source access requires a connector and execution provider declaring the source-access contract",
  );
  if (def.unsupported || !def.manifest.sourceAccess || !def.executor) return;
  check(
    context.allowWrite,
    "PERMISSION",
    "Source access requires private receipt writes",
  );
  if (operation === "connection_inventory") {
    const schema = def.manifest.sourceAccess.inventoryScopeSchema;
    check(
      schema || args.scope === undefined,
      "CAPABILITY",
      "Connector does not declare an inventory scope",
    );
    if (schema) {
      validateSchemaShape(schema);
      check(
        Buffer.byteLength(JSON.stringify(args.scope ?? {})) <= 100000,
        "CONNECTION",
        "Inventory scope exceeds supported bounds",
      );
      const ajv = new Ajv2020({ strict: true, validateFormats: false });
      check(
        ajv.validate(schema, args.scope ?? {}),
        "CONNECTION",
        "Inventory scope does not match the installed connector schema",
      );
    }
  }
  if (operation === "connection_metadata" && args.options !== undefined) {
    const schema = def.manifest.sourceAccess.metadataOptionsSchema;
    check(schema, "CAPABILITY", "Connector does not declare metadata options");
    validateSchemaShape(schema!);
    check(
      Buffer.byteLength(JSON.stringify(args.options)) <= 100000,
      "CONNECTION",
      "Metadata options exceed supported bounds",
    );
    const ajv = new Ajv2020({ strict: true, validateFormats: false });
    check(
      ajv.validate(schema!, args.options),
      "CONNECTION",
      "Metadata options do not match the installed connector schema",
    );
  }
  const sourceSchema = def.manifest.definition.tableSourceSchema;
  const selections =
    args.tables && operation !== "connection_contracts"
      ? args.tables
      : args.source
        ? [args.source]
        : [];
  if (selections.length) {
    check(
      sourceSchema,
      "CAPABILITY",
      "Connector does not declare a selectable object schema",
    );
    validateSchemaShape(sourceSchema);
    const ajv = new Ajv2020({ strict: true, validateFormats: false });
    check(
      selections.every((value: any) => ajv.validate(sourceSchema!, value)),
      "CONNECTION",
      "Selected objects do not match the connector source schema",
    );
    check(
      new Set(selections.map((value: any) => canonical(value))).size ===
        selections.length,
      "SELECT",
      "Duplicate source selections",
    );
  }
  const receiptDir = fence(root, ".ingestron/source-access");
  if (operation === "connection_contracts") {
    const file = fence(root, `.ingestron/source-access/${args.receipt}.json`);
    check(existsSync(file), "DISCOVERY", "Unknown metadata receipt");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    check(
      saved.apiVersion === "ingestron.source-access-receipt/v1" &&
        saved.action === "metadata" &&
        saved.status === "succeeded" &&
        saved.environment === def.environment &&
        saved.fingerprint === def.fingerprint &&
        saved.connection === args.connection &&
        saved.result?.status === "succeeded",
      "STALE",
      "Metadata no longer matches this connection, environment and packages",
    );
    check(
      new Set(args.tables.map((t: any) => t.id)).size === args.tables.length &&
        new Set(args.tables.map((t: any) => t.name)).size ===
          args.tables.length,
      "DISCOVERY",
      "Duplicate draft selection",
    );
    const out = `contracts/discovery/${def.environment}/${args.connection}/${randomUUID()}`;
    const drafts = args.tables.map((selected: any) => {
      const found = response
        .parse(saved.result)
        .tables.find((t) => t.id === selected.id);
      check(
        found?.columns?.length,
        "DISCOVERY",
        "Selected table has no metadata in this receipt",
      );
      const draft = draftContract(
        selected.name,
        found!.columns!,
        args.acceptKeys,
      );
      return {
        id: selected.id,
        name: selected.name,
        source: found!.source,
        ...(found!.sampling ? { sampling: found!.sampling } : {}),
        file: `${out}/${selected.name}.odcs.yaml`,
        ...draft,
      };
    });
    mkdirSync(fence(root, out), { recursive: true, mode: 0o700 });
    try {
      for (const draft of drafts)
        writeFileSync(fence(root, draft.file), stringify(draft.contract), {
          mode: 0o600,
          flag: "wx",
        });
    } catch (error) {
      rmSync(fence(root, out), { recursive: true, force: true });
      throw error;
    }
    return {
      apiVersion: "ingestron.source-contract-drafts/v1",
      connection: args.connection,
      fingerprint: def.fingerprint,
      receipt: args.receipt,
      tables: drafts.map(({ contract, ...draft }: any) => ({
        ...draft,
        fields: contract.schema[0].properties.length,
      })),
      applied: false,
      evidence:
        "Draft files only. Review contracts and bindings before preparing or publishing.",
    };
  }
  check(
    context.allowExecute,
    "PERMISSION",
    "Source access requires explicit local execution authority",
  );
  check(
    process.platform !== "win32",
    "CAPABILITY",
    "Source access currently requires a POSIX customer execution host",
  );
  const prepare = operation === "connection_runtime_prepare";
  check(
    !prepare || context.allowNetwork,
    "PERMISSION",
    "Dependency preparation requires network authority",
  );
  const action = operation.replace("connection_", "");
  check(
    prepare || def.manifest.sourceAccess.actions.includes(action as any),
    "CAPABILITY",
    "Connector does not declare this source access method",
  );
  const asset = def.manifest.runtime;
  check(
    Object.hasOwn(def.locked.entry.files, asset.path),
    "PACKAGE",
    "Source runtime asset is not locked",
  );
  const content = readFileSync(fence(def.locked.root, asset.path), "utf8");
  check(
    digest(content) === asset.sha256,
    "PACKAGE",
    "Source runtime asset digest differs",
  );
  const files = JSON.parse(content);
  check(
    files &&
      !Array.isArray(files) &&
      Object.keys(files).length <= 100 &&
      Object.entries(files).every(
        ([name, value]) =>
          /^[A-Za-z][A-Za-z0-9_.-]*$/.test(name) && typeof value === "string",
      ),
    "PACKAGE",
    "Invalid source runtime asset map",
  );
  const executor = resolvePackage(root, def.executor.reference);
  const entry = def.executor.sourceAccess!.entryPoint;
  const entryPath = relative(
    executor.root,
    resolve(dirname(executor.file), entry),
  );
  check(
    Object.hasOwn(executor.entry.files, entryPath),
    "PACKAGE",
    "Source execution adapter is not locked",
  );
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const folder = mkdtempSync(fence(root, ".ingestron/source-access/task-"));
  const runId = randomUUID();
  const receipt = {
    apiVersion: "ingestron.source-access-receipt/v1",
    id: runId,
    connection: args.connection,
    project: def.project.id,
    environment: def.environment,
    fingerprint: def.fingerprint,
    action: prepare ? "prepare" : action,
    status: "running",
    startedAt: new Date().toISOString(),
    result: undefined as any,
  };
  const receiptFile = fence(root, `.ingestron/source-access/${runId}.json`);
  const store = () => {
    const temp = receiptFile + ".tmp";
    writeFileSync(temp, JSON.stringify(receipt), { mode: 0o600 });
    renameSync(temp, receiptFile);
  };
  store();
  try {
    for (const [name, value] of Object.entries(files))
      writeFileSync(fence(folder, name), value as string, {
        mode: 0o600,
        flag: "wx",
      });
    check(
      typeof files[def.manifest.sourceAccess.entryPoint] === "string",
      "PACKAGE",
      "Source method entry point is absent",
    );
    const body = {
      apiVersion: "ingestron.source-access-request/v1",
      connector: def.manifest.id,
      entryPoint: def.manifest.sourceAccess.entryPoint,
      action: prepare ? "prepare" : action,
      settings: prepare ? {} : def.settings,
      source: args.source,
      tables: args.tables,
      query: args.query,
      schema: args.schema,
      scope: args.scope,
      options: args.options,
      cursor: args.cursor,
      limit: args.limit,
      columns: args.columns,
    };
    writeFileSync(fence(folder, "source-access.json"), JSON.stringify(body), {
      mode: 0o600,
    });
    const cache = fence(root, ".ingestron/runtime-cache");
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    const raw = await launch(
      "python3",
      fence(executor.root, entryPath),
      {
        apiVersion: "ingestron.source-access-host-request/v1",
        directory: folder,
        cache,
        python: args.python,
      },
      root,
      prepare
        ? credentials(context, {}, {})
        : credentials(context, args, def.settings),
    );
    check(
      sourceAccessDefinition(context, args).fingerprint === def.fingerprint,
      "STALE",
      "Source definition changed during access; repeat with the current definition",
    );
    const result = prepare ? raw.result : response.parse(raw.result);
    check(
      prepare || result.action === action,
      "SOURCE_ACCESS",
      "Source response action differs",
    );
    check(
      prepare || action === "sample" || result.sample === undefined,
      "SOURCE_ACCESS",
      "Record previews are only allowed in explicit sample responses",
    );
    if (action === "metadata") {
      check(
        result.tables.every(
          (item: any) =>
            !item.sampling ||
            (result.scope === "data" &&
              item.sampling.rowCount <= item.sampling.limit &&
              item.columns?.every(
                (field: any) => field.nullable && !field.key,
              )),
        ),
        "SOURCE_ACCESS",
        "Sampled metadata must declare its bounds without inferred required fields or keys",
      );
    }
    if (action === "sample" && result.status === "succeeded") {
      check(
        result.scope === "data" &&
          result.sample &&
          result.sample.rows.length <= args.limit &&
          new Set(result.sample.columns).size ===
            result.sample.columns.length &&
          result.sample.rows.every(
            (row: any[]) => row.length === result.sample.columns.length,
          ) &&
          Buffer.byteLength(JSON.stringify(result)) <= 1000000,
        "SOURCE_ACCESS",
        "Source sample is missing or exceeds its declared bounds",
      );
    }
    receipt.status = result.status === "succeeded" ? "succeeded" : "failed";
    // Receipts prove access; business rows remain in the immediate response only.
    receipt.result =
      action === "sample" && result.sample
        ? {
            ...result,
            sample: {
              columns: result.sample.columns,
              rowCount: result.sample.rows.length,
              truncated: result.sample.truncated,
            },
          }
        : result;
    store();
    check(
      result.status === "succeeded",
      result.status === "unsupported" ? "CAPABILITY" : "SOURCE_ACCESS",
      `Source ${action} ${result.status}: ${result.code ?? "ACCESS_FAILED"}. Check the selected scope, network, permissions and referenced credentials.`,
    );
    return {
      ...result,
      ...(args.source ? { accessScope: args.source } : {}),
      receipt: runId,
      fingerprint: def.fingerprint,
      connection: args.connection,
      environment: def.environment,
    };
  } catch (error) {
    if (receipt.status === "running")
      receipt.status =
        error instanceof Problem && error.code === "INTERRUPTED"
          ? "interrupted"
          : "failed";
    store();
    // Read-only source inspection owns no ingestion commit or managed-build claim.
    if (
      error instanceof ExecutionUncertainFailure &&
      error.code === "EXECUTION_UNCERTAIN"
    )
      throw new Problem(
        "RUNTIME",
        "Source access host did not return a valid response; repeat source access with the current definition",
      );
    throw error;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Read schemas in bounded batches and retain one durable, complete review selection. */
async function draftSourceSelection(
  context: Context,
  args: z.infer<typeof sourceAccessSchemas.connection_drafts>,
): Promise<any> {
  check(
    context.allowWrite && context.allowExecute,
    "PERMISSION",
    "Schema discovery requires receipt writes and explicit execution authority",
  );
  const def = sourceAccessDefinition(context, args);
  check(
    !def.unsupported && def.fingerprint,
    "CAPABILITY",
    "Select a portable source",
  );
  const selected = [...args.tables].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  check(
    new Set(selected.map((t) => t.name)).size === selected.length &&
      new Set(selected.map((t) => canonical(t.source))).size ===
        selected.length,
    "SELECT",
    "Choose each source object and output name only once across all batches",
  );
  const batches: { receipt: string; tables: { id: string; name: string }[] }[] =
    [];
  const objectIds = new Set<string>();
  for (let offset = 0; offset < selected.length; offset += 100) {
    const scope = selected.slice(offset, offset + 100);
    const metadata = await performSourceAccess(context, "connection_metadata", {
      ...args,
      tables: scope.map((t) => t.source),
    });
    check(
      metadata &&
        metadata.status === "succeeded" &&
        metadata.fingerprint === def.fingerprint,
      "STALE",
      "Source metadata changed during selection discovery",
    );
    const found = new Map<string, any>();
    for (const table of metadata.tables) {
      const key = canonical(table.source);
      check(
        !found.has(key) && !objectIds.has(table.id),
        "DISCOVERY",
        "Metadata returned duplicate source objects or unstable object identities",
      );
      found.set(key, table);
      objectIds.add(table.id);
    }
    check(
      found.size === scope.length,
      "DISCOVERY",
      "Metadata must describe exactly the selected objects",
    );
    batches.push({
      receipt: metadata.receipt,
      tables: scope.map((t) => {
        const table = found.get(canonical(t.source));
        check(
          table?.columns?.length,
          "DISCOVERY",
          "Selected object is missing supported metadata",
        );
        return { id: table.id, name: t.name };
      }),
    });
  }
  const folders = new Set<string>();
  const tables: any[] = [];
  try {
    for (const batch of batches) {
      const drafts = await performSourceAccess(
        context,
        "connection_contracts",
        {
          connection: args.connection,
          ...(args.executor ? { executor: args.executor } : {}),
          ...batch,
          acceptKeys: args.acceptKeys,
        },
      );
      check(
        drafts?.fingerprint === def.fingerprint,
        "STALE",
        "Source changed while drafting contracts",
      );
      for (const table of drafts.tables) {
        folders.add(dirname(table.file));
        tables.push({ ...table, receipt: batch.receipt });
      }
    }
    check(
      sourceAccessDefinition(context, args).fingerprint === def.fingerprint,
      "STALE",
      "Source changed before the complete selection was saved",
    );
    const result = {
      apiVersion: "ingestron.source-contract-drafts/v1",
      status: "succeeded",
      connection: args.connection,
      fingerprint: def.fingerprint,
      receipt: batches[0].receipt,
      receipts: batches.map((b) => b.receipt),
      tables,
      applied: false,
      evidence:
        "Isolated contract drafts only. Review grouped flow bindings before preparing or publishing.",
    };
    const root = resolve(context.root),
      id = randomUUID();
    const file = fence(root, `.ingestron/source-access/${id}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        apiVersion: "ingestron.source-access-receipt/v1",
        id,
        action: "drafts",
        connection: args.connection,
        project: def.project.id,
        environment: def.environment,
        fingerprint: def.fingerprint,
        status: "succeeded",
        result,
      }),
      { mode: 0o600, flag: "wx" },
    );
    return result;
  } catch (error) {
    for (const folder of folders)
      rmSync(fence(context.root, folder), { recursive: true, force: true });
    throw error;
  }
}
