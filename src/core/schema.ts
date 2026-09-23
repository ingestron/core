import { z } from "zod";
const id = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/);
const map = z.record(z.string(), z.unknown());
export const providerSchema = z
  .object({
    package: id,
    binding: id,
    options: map.default({}),
    packs: z.array(id).default([]),
  })
  .strict();
export const environmentSchema = z
  .object({
    apiVersion: z.literal("ingestron.environment/v1"),
    environment: id.optional(),
    values: map.default({}),
    bindings: z.record(id, map).default({}),
  })
  .strict();
export const packageReferenceSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const at = value.lastIndexOf("@");
    return at > 0 && at < value.length - 1
      ? { source: value.slice(0, at), version: value.slice(at + 1) }
      : value;
  },
  z.object({ source: z.string().min(1), version: z.string().min(1) }).strict(),
);
export const projectSchema = z
  .object({
    apiVersion: z.literal("ingestron.project/v1"),
    id,
    description: z.string().optional(),
    packages: z.record(id, packageReferenceSchema).default({}),
    providers: z
      .object({
        packages: z.record(id, packageReferenceSchema).default({}),
        configurations: z.record(id, providerSchema),
        packs: z.record(id, packageReferenceSchema).default({}),
      })
      .strict(),
    defaults: z
      .object({
        provider: id.optional(),
        naming: z
          .object({
            table: z.string().optional(),
            job: z.string().optional(),
          })
          .strict()
          .default({}),
        with: map.default({}),
      })
      .strict()
      .default({ naming: {}, with: {} }),
    environments: z.record(id, environmentSchema),
    modelPacks: z.record(id, packageReferenceSchema).default({}),
    connections: z
      .record(
        id,
        z
          .object({
            package: id,
            connector: z.string().min(1).optional(),
            sourceId: id,
            tenantId: id,
            binding: id.optional(),
            settings: map.default({}),
          })
          .strict(),
      )
      .default({}),
    flows: z.array(z.unknown()),
  })
  .strict();
export const stepSchema = z
  .object({
    id,
    uses: z.string().min(1),
    provider: id.optional(),
    with: map.default({}),
    select: z.array(id).min(1).optional(),
  })
  .strict();
export const tableSchema = z
  .object({
    source: map.default({}),
    contract: map,
    ingestion: map.optional(),
    steps: z
      .record(id, z.object({ with: map.default({}) }).strict())
      .default({}),
  })
  .strict();
export const flowSchema = z
  .object({
    apiVersion: z.literal("ingestron.flow/v1"),
    kind: z.enum(["ingestion", "transformation"]),
    id,
    description: z.string().optional(),
    domain: id.optional(),
    export: id.optional(),
    product: id.optional(),
    provider: id.optional(),
    defaults: z
      .object({ source: map.default({}), with: map.default({}) })
      .strict()
      .default({ source: {}, with: {} }),
    ingestion: map.optional(),
    tables: z.record(id, tableSchema).optional(),
    steps: z.array(stepSchema).min(1).optional(),
    requires: z
      .record(
        id,
        z
          .object({
            dataset: z.string(),
            handover: z.enum(["files", "relation"]).optional(),
            select: z
              .object({
                mode: z.literal("same-run"),
              })
              .strict(),
          })
          .strict(),
      )
      .default({}),
    publishes: z
      .record(
        id,
        z
          .object({ from: z.string(), contract: map, location: map.optional() })
          .strict(),
      )
      .default({}),
  })
  .strict();
export type Project = z.infer<typeof projectSchema>;
export type Flow = z.infer<typeof flowSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Table = z.infer<typeof tableSchema>;
export type Platform = string;
export interface Node {
  id: string;
  flow: string;
  table?: string;
  step: string;
  exportGroup?: string;
  resources?: { scope: string; kind: string; name: string }[];
  uses: string;
  platform: Platform;
  runtime?: {
    implementation: "native";
    configuration?: string;
    capabilities?: {
      delivery: boolean;
      artifactKinds: string[];
      handovers: ("files" | "relation")[];
      packContracts: Record<string, { version: string; activities: string[] }>;
    };
    version?: string;
    options?: Record<string, any>;
    outputSchemas?: Record<string, string>;
    outputSchemasRef?: string;
    lifecycleCode?: string;
    lifecycleRef?: string;
    rendererCode?: string;
    rendererRef?: string;
  };
  binding: string;
  with: Record<string, any>;
  needs: string[];
  source?: Record<string, any>;
  contract?: Record<string, any>;
  output: string;
  interface: { input: string; output: string };
  generation?: {
    kind: string;
    artifactKind?: string;
    entrypoint: string;
    runtime?: string;
    runtimeRef?: string;
    execution?: string;
    persistence?: "capture" | "ephemeral" | "durable";
    code?: string;
    codeRef?: string;
    scope?: "table" | "collection";
    modes?: ("table" | "collection")[];
    groupBy?: string[];
    dependencyOptions?: Record<string, string>;
    requirements?: {
      execution: string;
      features: string[];
      sourceKinds?: string[];
      evidence: "offline";
    };
  };
  implementation?: {
    templates: {
      content: string;
      output: string;
      format: string;
      engine?: "jinja";
    }[];
    dependencies: Record<string, string>;
  };
}
export interface Plan {
  apiVersion: "ingestron.plan/v1";
  delivery?: {
    exportId: string;
    imports: {
      dataset: string;
      producer: string;
      kind: "files" | "relation";
      location: Record<string, unknown>;
      contract: Record<string, unknown>;
    }[];
  };
  compilerVersion: string;
  compilerDigest: string;
  names: { jobs: Record<string, string>; nodes: Record<string, string> };
  inputDigests: Record<string, string>;
  selection: {
    flow?: string;
    table?: string;
    step?: string;
    delivery?: boolean;
    projectBuild?: boolean;
    provider?: string;
  };
  project: string;
  environment: string;
  bindings: Record<string, any>;
  nodes: Node[];
  activitySources: Record<string, string>;
  flows: Flow[];
  files: Record<string, string>;
  datasets: Record<
    string,
    {
      producer: string;
      port?: string;
      contract: Record<string, any>;
      location?: Record<string, any>;
    }
  >;
  recovery: Record<string, any>[];
  pending: ConfigurationPending[];
  digest: string;
}
export interface ConfigurationPending {
  name: string;
  file?: string;
  pointer?: string;
}
