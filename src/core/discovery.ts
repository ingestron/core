/** Discovery per route (PB-064 phase 6).
 *
 * `discover` lists every field a flow's tables offer and writes draft ODCS
 * contracts for review, before any contract exists. A flow whose connection
 * names a portable package is read through that connector on a local
 * configuration (even when the flow itself runs natively); otherwise the
 * catalogue comes from a file: a source catalogue, or metadata rows exported
 * by a provider's discovery pipeline or job. Drafts are never written over
 * existing files and never change project.yaml.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { stringify } from "yaml";
import { check, isMap } from "./errors.js";
import { fence } from "./packages.js";
import { contractColumns } from "./contracts.js";
import { inspectProject } from "./planner.js";
import { buildProject, configurationManifest } from "./project-build.js";
import type { Context } from "./operations.js";
import { nativeConnectionFlow } from "./native-connections.js";
import { runProviderCommand } from "./provider-commands.js";

type Kind = "integer" | "decimal" | "number" | "boolean" | "string";
export interface CatalogueColumn {
  name: string;
  type: Kind;
  nullable: boolean;
  key?: boolean;
  supported?: boolean;
  sourceType?: string;
  precision?: number;
  scale?: number;
}
const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const kinds = new Set(["integer", "decimal", "number", "boolean", "string"]);

/** Draft ODCS contract for one table, and the columns left out with reasons. */
export function draftContract(
  table: string,
  columns: CatalogueColumn[],
  acceptKeys: boolean,
) {
  const skipped: { name: string; reason: string }[] = [];
  const properties: Record<string, unknown>[] = [];
  for (const c of columns) {
    if (c.supported === false) {
      skipped.push({
        name: c.name,
        reason: `unsupported source type ${c.sourceType ?? ""}`.trim(),
      });
      continue;
    }
    if (!identifier.test(c.name)) {
      skipped.push({
        name: c.name,
        reason:
          "not a valid field name; rename at the source or map it in review",
      });
      continue;
    }
    const kind = kinds.has(c.type) ? c.type : "string";
    const physical =
      kind === "integer"
        ? "BIGINT"
        : kind === "decimal"
          ? `DECIMAL(${c.precision ?? 38},${c.scale ?? 9})`
          : kind === "number"
            ? "DOUBLE"
            : kind === "boolean"
              ? "BOOLEAN"
              : "STRING";
    properties.push({
      name: c.name,
      logicalType: kind === "decimal" ? "number" : kind,
      physicalType: physical,
      ...(c.nullable === false ? { required: true } : {}),
      ...(acceptKeys && c.key ? { primaryKey: true } : {}),
    });
  }
  check(
    properties.length > 0 && properties.length <= 500,
    "DISCOVERY",
    `${table}: discovery found no usable fields (or more than 500)`,
  );
  const contract = {
    apiVersion: "v3.1.0",
    kind: "DataContract",
    id: table,
    name: table,
    version: "0.1.0",
    status: "draft",
    description: {
      purpose:
        "Drafted by ingestron discover; review names, types, required fields and keys before use.",
    },
    schema: [
      { name: table, logicalType: "object", physicalType: "table", properties },
    ],
  };
  contractColumns(contract);
  return { contract, skipped };
}

/** Metadata rows (ADF or Databricks discovery exports) as catalogue columns per flow table. */
export function fromRows(rows: any[], sources: Record<string, any>) {
  const lower = (r: any, k: string) =>
    r[k] ??
    r[k.toUpperCase()] ??
    r[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
  const tables: Record<string, { columns: CatalogueColumn[] }> = {};
  for (const [table, source] of Object.entries(sources)) {
    // SaaS tables have no source schema: Databricks exports their destination
    // tables, which are named after the flow tables.
    const bySchema = source.schema !== undefined && source.table !== undefined;
    const matching = rows.filter((r) =>
      !bySchema
        ? String(lower(r, "table_name")).toLowerCase() === table.toLowerCase()
        : String(lower(r, "schema_name")).toLowerCase() ===
            String(source.schema ?? "").toLowerCase() &&
          String(lower(r, "table_name")).toLowerCase() ===
            String(source.table ?? "").toLowerCase(),
    );
    check(
      matching.length,
      "DISCOVERY",
      `${table}: no metadata rows for ${bySchema ? `${source.schema}.${source.table}` : table}`,
    );
    tables[table] = {
      columns: matching
        .sort(
          (a, b) =>
            Number(lower(a, "ordinal_position")) -
            Number(lower(b, "ordinal_position")),
        )
        .map((r) => sqlColumn(r, lower)),
    };
  }
  return tables;
}

/** SQL catalogue types across SQL Server, PostgreSQL, MySQL and Oracle. */
function sqlColumn(r: any, lower: (r: any, k: string) => any): CatalogueColumn {
  const type = String(lower(r, "data_type")).toLowerCase().replace(/\(.*$/, "");
  const precision = Number(
    lower(r, "precision") ?? lower(r, "numeric_precision"),
  );
  const scale = Number(lower(r, "scale") ?? lower(r, "numeric_scale"));
  const nullable = [true, 1, "1", "YES", "Y", "true"].includes(
    lower(r, "nullable") ?? lower(r, "is_nullable"),
  );
  const key = [true, 1, "1", "true"].includes(lower(r, "primary_key"));
  // Includes Databricks (Unity Catalog) type names from information_schema.
  const integer = [
    "long",
    "short",
    "byte",
    "tinyint",
    "smallint",
    "int",
    "integer",
    "bigint",
    "int2",
    "int4",
    "int8",
    "mediumint",
  ];
  const decimal = ["decimal", "numeric", "money", "smallmoney", "number"];
  const floating = [
    "float",
    "real",
    "double",
    "double precision",
    "float4",
    "float8",
    "binary_float",
    "binary_double",
  ];
  const text = [
    "string",
    "timestamp_ntz",
    "char",
    "varchar",
    "nchar",
    "nvarchar",
    "text",
    "ntext",
    "uniqueidentifier",
    "uuid",
    "bpchar",
    "character",
    "character varying",
    "varchar2",
    "nvarchar2",
    "clob",
    "nclob",
    "enum",
    "set",
    "tinytext",
    "mediumtext",
    "longtext",
    "date",
    "time",
    "datetime",
    "datetime2",
    "smalldatetime",
    "datetimeoffset",
    "timestamp",
    "timestamptz",
    "timestamp without time zone",
    "timestamp with time zone",
    "year",
    "xml",
  ];
  const base = {
    name: String(lower(r, "column_name")),
    nullable,
    ...(key ? { key } : {}),
    sourceType: type,
  };
  if (integer.includes(type)) return { ...base, type: "integer" };
  if (decimal.includes(type))
    return Number.isFinite(scale) && scale === 0 && type === "number"
      ? { ...base, type: "integer" }
      : {
          ...base,
          type: "decimal",
          ...(Number.isFinite(precision) && precision > 0 ? { precision } : {}),
          ...(Number.isFinite(scale) ? { scale } : {}),
        };
  if (floating.includes(type)) return { ...base, type: "number" };
  if (["bit", "bool", "boolean"].includes(type))
    return { ...base, type: "boolean" };
  if (text.includes(type)) return { ...base, type: "string" };
  return { ...base, type: "string", supported: false };
}

function readCatalogue(file: string, sources: Record<string, any>) {
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (isMap(value) && value.apiVersion === "ingestron.source-catalogue/v1") {
    check(isMap(value.tables), "DISCOVERY", "Catalogue has no tables");
    return value.tables as Record<string, { columns: CatalogueColumn[] }>;
  }
  const rows = Array.isArray(value)
    ? value
    : isMap(value) && Array.isArray(value.rows)
      ? value.rows
      : undefined;
  check(
    rows,
    "DISCOVERY",
    "Supply a source catalogue or exported metadata rows",
  );
  return fromRows(rows, sources);
}

function localConfiguration(
  root: string,
  inspected: any,
  flow: any,
  connection: any,
  requested?: string,
) {
  const { project, reader } = inspected;
  if (requested) return requested;
  if (connection.route !== "native" && connection.route !== "bridge")
    return flow.provider ?? project.defaults.provider;
  const local = Object.keys(project.providers.configurations).find(
    (c) =>
      configurationManifest(root, reader, project, c).manifest.platform ===
      "local",
  );
  check(
    local,
    "PROVIDER",
    "Configure the local provider to discover a native connection through its portable connector",
  );
  return local;
}

export async function performDiscovery(
  context: Context,
  args: {
    flow: string;
    from?: string;
    out: string;
    local?: string;
    acceptKeys: boolean;
    python?: string;
    envFile?: string;
  },
  run: (operation: "runtime_prepare" | "run", request: any) => Promise<any>,
) {
  const root = context.root;
  const environment = context.environment ?? "dev";
  check(
    context.allowWrite,
    "PERMISSION",
    "Discovery writes draft contracts; allow writes",
  );
  const inspected = inspectProject(root, environment, { draft: true });
  const flow: any = inspected.flows.find((f: any) => f.id === args.flow);
  check(
    flow?.kind === "ingestion" && flow.tables,
    "SELECT",
    `Unknown ingestion flow ${args.flow}`,
  );
  // A bridged flow reads published deliveries; its authored table sources and
  // connection live on its landing leg.
  const authored: any = flow.bridge
    ? inspected.flows.find((f: any) => f.id === flow.bridge.legs[0])
    : flow;
  const sources = Object.fromEntries(
    Object.entries(authored.tables).map(([t, v]: [string, any]) => [
      t,
      { ...authored.defaults.source, ...v.source },
    ]),
  );
  const name = String(authored.ingestion?.connection ?? "");
  const connection = inspected.project.connections[name];
  let catalogue: Record<string, { columns: CatalogueColumn[] }>;
  let route: string;
  if (
    !args.from &&
    !connection?.package &&
    (connection?.route === "native" || connection?.route === "bridge")
  )
    return providerDiscovery(
      root,
      environment,
      inspected,
      flow,
      name,
      connection,
      sources,
    );
  if (args.from) {
    catalogue = readCatalogue(fence(root, args.from), sources);
    route = "file";
  } else {
    check(
      connection?.package,
      "DISCOVERY",
      `${flow.id}: name a portable package and settings on connection ${name || "(none)"} to discover from here, or run the provider's discovery and pass its export with --from`,
    );
    const local = localConfiguration(
      root,
      inspected,
      flow,
      connection,
      args.local,
    );
    buildProject(root, environment, {
      flow: flow.id,
      catalogue: local,
      out: "build/discovery",
      ownership: "managed",
    });
    await run("runtime_prepare", {
      from: "build/discovery",
      flow: flow.id,
      ...(args.python ? { python: args.python } : {}),
    });
    await run("run", {
      from: "build/discovery",
      flow: flow.id,
      action: "catalogue",
      ...(args.envFile ? { envFile: args.envFile } : {}),
    });
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (
          entry.name === "catalogue.json" &&
          dirname(path).endsWith(`/flows/${flow.id}`)
        )
          found.push(path);
      }
    };
    walk(fence(root, "build/discovery"));
    check(
      found.length === 1,
      "DISCOVERY",
      "The runtime did not write one catalogue for this flow",
    );
    const value = JSON.parse(readFileSync(found[0], "utf8"));
    check(
      value.apiVersion === "ingestron.source-catalogue/v1" &&
        isMap(value.tables),
      "DISCOVERY",
      "Invalid runtime catalogue",
    );
    catalogue = value.tables;
    route =
      connection.route === "native" || connection.route === "bridge"
        ? `${connection.route} (via portable ${connection.package})`
        : "portable";
  }
  const tables = Object.keys(flow.tables).map((table) => {
    const entry = catalogue[table];
    check(
      entry && Array.isArray(entry.columns),
      "DISCOVERY",
      `${table}: the catalogue has no columns for this table`,
    );
    const { contract, skipped } = draftContract(
      table,
      entry.columns,
      args.acceptKeys,
    );
    const file = fence(root, `${args.out}/${flow.id}/${table}.odcs.yaml`);
    check(
      !existsSync(file),
      "OWNER",
      `${relative(root, file)} exists; review or move it before discovering again`,
    );
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, stringify(contract), { flag: "wx" });
    return {
      table,
      file: relative(root, file),
      fields: contract.schema[0].properties.length,
      keys: entry.columns.filter((c) => c.key).map((c) => c.name),
      skipped,
    };
  });
  return {
    flow: flow.id,
    route,
    tables,
    next: "Review each draft, then set the table's contract to { $resolve: <file> } and run ingestron check.",
  };
}

/** Metadata assets from the provider that reads the source natively, for
 * sources this machine cannot reach; their export returns through --from. */
function providerDiscovery(
  root: string,
  environment: string,
  inspected: any,
  flow: any,
  name: string,
  connection: any,
  sources: Record<string, any>,
) {
  const { project, reader, profile } = inspected;
  const configuration =
    connection.route === "bridge"
      ? connection.bridge.provider
      : (flow.provider ?? project.defaults.provider);
  const { manifest, config } = configurationManifest(
    root,
    reader,
    project,
    configuration,
  );
  const declared = manifest.sources?.[connection.kind];
  check(
    declared?.discovery,
    "DISCOVERY",
    `${configuration} has no metadata discovery for ${connection.kind}; name a portable package and settings on connection ${name}, or export metadata yourself and pass it with --from`,
  );
  const rendered = nativeConnectionFlow(
    {
      ...flow,
      provider: configuration,
      ingestion: { connection: name, standard: declared.standards[0] },
    },
    {
      connectionName: name,
      connection,
      binding: connection.binding
        ? profile.bindings[connection.binding]
        : undefined,
      configuration,
      sources: manifest.sources,
    },
  );
  const target =
    connection.route === "bridge"
      ? connection.bridge.landing
      : flow.ingestion?.target;
  const response: any = runProviderCommand(root, environment, {
    configuration,
    command: declared.discovery.command,
    input: {
      flow: flow.id,
      kind: connection.kind,
      source: rendered.defaults.source,
      tables: sources,
      ...(target ? { target } : {}),
      binding: profile.bindings[config.binding],
      ...(connection.binding
        ? { connectionBinding: profile.bindings[connection.binding] }
        : {}),
    },
  });
  const artifacts = response.result?.artifacts;
  check(isMap(artifacts), "PROVIDER", "Invalid provider discovery result");
  const files = Object.entries(artifacts).map(([path, content]) => {
    check(
      typeof content === "string" &&
        /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(path) &&
        !path.split("/").includes(".."),
      "PROVIDER",
      "Unsafe provider discovery artifact",
    );
    const file = fence(root, `build/discovery/${flow.id}/${path}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content as string);
    return relative(root, file);
  });
  return {
    flow: flow.id,
    route: `${connection.route} metadata on ${configuration}`,
    tables: [],
    files,
    review: Array.isArray(response.result?.review)
      ? response.result.review
      : [],
    next:
      (typeof response.result?.next === "string"
        ? response.result.next + " "
        : "") +
      `Then run ingestron discover --flow ${flow.id} --from <exported metadata file>.`,
  };
}
