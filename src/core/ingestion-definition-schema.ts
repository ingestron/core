import { z } from "zod";
import {
  qualityRuleSetSchema,
  qualityBindingSchema,
  qualityDefaultsSchema,
} from "./portable-quality-schema.js";
/** Portable document contracts; safe in editor/browser consumers. */
const id = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/);
const text = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const kind = z.enum([
  "table",
  "view",
  "file-group",
  "endpoint",
  "collection",
  "topic",
  "unknown",
]);
const connector = z
  .object({
    id: text,
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/),
  })
  .strict();
export const discoveryFieldSchema = z
  .object({
    path: text,
    logicalType: z.enum([
      "integer",
      "number",
      "decimal",
      "string",
      "boolean",
      "date",
      "timestamp",
      "object",
      "array",
      "unknown",
    ]),
    nativeType: text.optional(),
    precision: z.number().int().optional(),
    scale: z.number().int().optional(),
    nullable: z.boolean().optional(),
    origin: z.enum(["declared", "observed", "inferred", "unknown"]),
  })
  .strict();
const reference = z.object({ id: text, sha256: hash }).strict();
export const discoverySnapshotSchema = z
  .object({
    apiVersion: z.literal("ingestron.discovery-snapshot/v1"),
    id,
    source: id,
    connector,
    collectedAt: z.string().datetime(),
    environment: id.optional(),
    provenance: z
      .object({
        method: z.enum([
          "declared",
          "observed",
          "inferred",
          "mixed",
          "unknown",
        ]),
        producer: text,
        notes: text.optional(),
      })
      .strict()
      .optional(),
    coverage: z
      .object({ scope: text, complete: z.boolean(), reason: text.optional() })
      .strict(),
    objects: z
      .array(
        z
          .object({
            id: text,
            name: text.optional(),
            kind,
            namespace: text.optional(),
            description: text.optional(),
            locator: z
              .record(
                z.string().min(1).max(128),
                z.union([text, z.number().finite(), z.boolean()]),
              )
              .refine((v) => Object.keys(v).length <= 30)
              .optional(),
            metadataComplete: z.boolean().optional(),
            inference: z
              .object({
                method: z.literal("bounded-records"),
                rowCount: z.number().int().min(1).max(50),
                limit: z.number().int().min(1).max(50),
                byteLimit: z.number().int().min(1).max(1048576),
                truncated: z.boolean(),
              })
              .strict()
              .refine((v) => v.rowCount <= v.limit)
              .optional(),
            keys: z.array(text).max(100).optional(),
            partitions: z.array(text).max(100).optional(),
            cursors: z.array(text).max(100).optional(),
            fields: z.array(discoveryFieldSchema).max(5000),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
const metadata = z
  .object({
    name: id,
    logicalType: z.enum(["string", "timestamp"]),
    value: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("literal"), value: z.string().max(1024) })
        .strict(),
      z
        .object({
          kind: z.enum([
            "source-object",
            "source-path",
            "observed-at",
            "discovery-id",
          ]),
        })
        .strict(),
    ]),
  })
  .strict();
export const ingestionDefinitionSchema = z
  .object({
    apiVersion: z.literal("ingestron.ingestion-definition/v1"),
    id,
    name: z.string().trim().min(1).max(160),
    description: z.string().max(4000).default(""),
    // Reviewed means portable static checks passed, never target qualification.
    status: z.enum(["draft", "reviewed"]),
    archived: z.boolean().optional(),
    source: z.object({ id, connector }).strict().optional(),
    discovery: reference.optional(),
    qualityDefaults: qualityDefaultsSchema.optional(),
    qualityRuleSets: z.array(qualityRuleSetSchema).max(200).optional(),
    objects: z
      .array(
        z
          .object({
            id: text,
            kind,
            discovery: reference.optional(),
            qualityEnabled: z.boolean().optional(),
            qualitySets: z.array(qualityBindingSchema).max(20).optional(),
            fields: z.array(discoveryFieldSchema).max(5000),
            mapping: z
              .array(
                z
                  .object({
                    source: text,
                    output: id,
                    logicalType:
                      discoveryFieldSchema.shape.logicalType.optional(),
                  })
                  .strict(),
              )
              .max(5000)
              .default([]),
            // Unsupported/custom records survive unchanged; portable rules receive semantic validation.
            quality: z
              .array(z.record(z.string(), z.unknown()))
              .max(100)
              .default([]),
            governance: z
              .object({
                owner: text.optional(),
                classification: text.optional(),
                masking: z
                  .array(
                    z
                      .object({
                        field: text,
                        policy: text,
                        enabled: z.boolean().optional(),
                        required: z.boolean().optional(),
                      })
                      .strict(),
                  )
                  .max(5000)
                  .default([]),
              })
              .strict()
              .optional(),
            metadata: z.array(metadata).max(100).default([]),
          })
          .strict(),
      )
      .max(10000)
      .default([]),
  })
  .strict();
export const ingestionDraftSchema = z
  .object({
    apiVersion: z.literal("ingestron.ingestion-draft/v1"),
    project: id,
    baseRevision: hash,
    definition: ingestionDefinitionSchema,
    context: z
      .object({
        object: text.optional(),
        section: z
          .enum([
            "schema",
            "mapping",
            "quality",
            "governance",
            "metadata",
            "sample",
          ])
          .optional(),
      })
      .strict(),
  })
  .strict();
export const ingestionHandoffSchema = z
  .object({
    apiVersion: z.literal("ingestron.ingestion-handoff/v1"),
    project: id,
    definition: z.object({ id, sha256: hash }).strict(),
    contracts: z.array(reference).max(10000),
    requiredCapabilities: z.array(text).max(100),
  })
  .strict();
export const ingestionContractSchema = z
  .object({
    value: z.union([
      ingestionDefinitionSchema,
      discoverySnapshotSchema,
      ingestionDraftSchema,
      ingestionHandoffSchema,
    ]),
  })
  .strict();
export const ingestionReadSchema = z.object({ id: id.optional() }).strict();
export const ingestionReviewSchema = z
  .object({
    revision: hash,
    definition: ingestionDefinitionSchema,
    workingExpected: hash.nullable().optional(),
    create: z.boolean().optional(),
    duplicateFrom: id.optional(),
    saveWithFindings: z.boolean().optional(),
    adoptDiscovery: reference.optional(),
  })
  .strict();
export const ingestionApplySchema = z
  .object({ input: ingestionReviewSchema, proposalId: hash })
  .strict();
export type IngestionDefinition = z.infer<typeof ingestionDefinitionSchema>;

export const ingestionEditorReadSchema = z
  .object({
    id: id.optional(),
    connection: id.optional(),
    snapshot: id.optional(),
  })
  .strict();
export const ingestionAdoptSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(160),
    description: z.string().max(4000),
    connection: id,
    snapshot: id,
    sha256: hash,
    objects: z.array(text).min(1).max(10000),
  })
  .strict();
export const ingestionDraftWriteSchema = z
  .object({
    id,
    expected: hash.nullable(),
    draft: ingestionDraftSchema.nullable(),
  })
  .strict();

export const ingestionDiscoveryUpdateSchema = z
  .object({
    revision: hash,
    definition: ingestionDefinitionSchema,
    snapshot: id,
    sha256: hash,
  })
  .strict();
