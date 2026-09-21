/** Data-only report pack: native expressions are text, never compiler-side code. */
import { z } from "zod";
export const reportPackSchema = z
  .object({
    apiVersion: z.literal("ingestron.extension-pack/v3"),
    kind: z.literal("report"),
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1),
    platform: z.string().regex(/^[a-z][a-z0-9-]*$/),
    model: z.string().regex(/^[A-Za-z0-9_./-]+@\d+\.\d+\.\d+$/),
    contractVersion: z.literal("1.0.0"),
    report: z.record(z.string(), z.unknown()),
  })
  .strict();
