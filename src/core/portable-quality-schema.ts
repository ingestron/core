import { z } from "zod";
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/);
const field = z.string().min(1).max(1024);
const finite = z.number().finite();
const scalar = z.union([z.string().max(1024), finite, z.boolean()]);
export const portableQualityRuleSchema = z
  .object({
    apiVersion: z.literal("ingestron.quality-rule/v1"),
    id: name,
    name: z.string().trim().min(1).max(160),
    description: z.string().max(4000).default(""),
    enabled: z.boolean(),
    fields: z.array(field).max(100),
    condition: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("not-null") }).strict(),
      z.object({ kind: z.literal("uniqueness") }).strict(),
      z.object({ kind: z.literal("range"), min: finite, max: finite }).strict(),
      z
        .object({
          kind: z.literal("allowed-values"),
          values: z.array(scalar).min(1).max(1000),
        })
        .strict(),
      z
        .object({
          kind: z.literal("pattern"),
          expression: z.string().min(1).max(512),
          dialect: z.literal("portable-ascii"),
        })
        .strict(),
      z
        .object({
          kind: z.literal("length"),
          min: finite.int().nonnegative(),
          max: finite.int().nonnegative(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("freshness"),
          maxAgeSeconds: finite.positive(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("row-count"),
          min: finite.int().nonnegative(),
          max: finite.int().nonnegative(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("relationship"),
          object: field,
          fields: z.array(field).min(1).max(100),
          dependency: z.literal("same-ingestion"),
        })
        .strict(),
    ]),
    nullHandling: z.enum(["fail", "ignore", "pass"]),
    threshold: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("pass-rate"), value: finite.min(0).max(100) })
        .strict(),
      z
        .object({
          kind: z.literal("failure-count"),
          value: finite.int().nonnegative(),
        })
        .strict(),
    ]),
    severity: z.enum(["warning", "error"]),
    failureIntent: z.enum([
      "report-only",
      "reject-row",
      "quarantine-row",
      "reject-object",
    ]),
    required: z
      .object({ policy: name, reason: z.string().min(1).max(1024) })
      .strict()
      .optional(),
  })
  .passthrough(); // Preserve custom engine attributes without interpreting or executing them.
export const qualityRuleSetSchema = z
  .object({
    id: name,
    version: z.number().int().min(1).max(1000000),
    name: z.string().trim().min(1).max(160),
    description: z.string().max(4000).default(""),
    fields: z
      .array(
        z
          .object({
            name,
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
          })
          .strict(),
      )
      .max(100),
    rules: z.array(portableQualityRuleSchema).min(1).max(100),
  })
  .strict();
export const qualityBindingSchema = z
  .object({
    id: name,
    version: z.number().int().min(1),
    fields: z.record(name, field),
  })
  .strict();
export const qualityDefaultsSchema = z
  .object({
    enabled: z.boolean(),
    rules: z.array(portableQualityRuleSchema).max(100),
  })
  .strict();
export type PortableQualityRule = z.infer<typeof portableQualityRuleSchema>;
export type QualityRuleSet = z.infer<typeof qualityRuleSetSchema>;
