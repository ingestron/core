import { z } from "zod";
const id = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_-]{0,70}$/)
  .refine((v) => !["__proto__", "constructor", "prototype"].includes(v));
/** Project-owned setup choices are explicit drafts until resources are configured. */
export const destinationSetupSchema = z
  .object({
    target: z.enum(["adf", "databricks", "fabric"]),
    responsibilities: z
      .array(z.enum(["ingestion", "transformation", "orchestration"]))
      .min(1)
      .max(3)
      .refine((v) => new Set(v).size === v.length),
    method: z.string().max(100),
    deferred: z.boolean(),
    reference: z.string().max(500).optional(),
    resources: z.record(z.string().max(80), z.string().max(300)).default({}),
  })
  .strict();
export const destinationReviewSchema = z
  .object({
    configuration: id,
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    setup: destinationSetupSchema,
  })
  .strict();
