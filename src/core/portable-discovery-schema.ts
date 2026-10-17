import { z } from "zod";
import { discoverySnapshotSchema } from "./ingestion-definition-schema.js";
const id = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const discoverySampleSchema = z
  .object({
    object: z.string().min(1).max(1024),
    columns: z.array(z.string().min(1).max(1024)).min(1).max(100),
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
  .strict();
export const discoveryBundleSchema = z
  .object({
    apiVersion: z.literal("ingestron.discovery-bundle/v1"),
    snapshot: discoverySnapshotSchema,
    samples: z.array(discoverySampleSchema).max(10).optional(),
  })
  .strict();
export const discoveryReadSchema = z
  .object({ connection: id, snapshot: id.optional() })
  .strict();
export const discoveryReviewSchema = z
  .object({
    connection: id,
    revision: hash,
    document: z
      .string()
      .min(1)
      .max(2 * 1024 * 1024)
      .optional(),
    allowSamples: z.boolean().default(false),
    receipts: z.array(z.string().uuid()).min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (v) => !!v.document !== !!v.receipts,
    "Choose an upload or metadata receipts",
  );
export const discoverySaveSchema = z
  .object({ connection: id, revision: hash, snapshot: discoverySnapshotSchema })
  .strict();
export const discoveryApplySchema = z
  .object({ input: discoverySaveSchema, proposalId: hash })
  .strict();
