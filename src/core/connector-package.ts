/** Source definitions are data-only; execution remains with a selected provider. */
import { z } from "zod";
const schema = z.record(z.string(), z.unknown());
export const connectorPackageSchema = z
  .object({
    apiVersion: z.literal("ingestron.connector/v1"),
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1),
    connector: z
      .string()
      .regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*@\d+\.\d+\.\d+$/),
    documentation: z.string().url(),
    upstream: z
      .object({
        ecosystem: z.string().regex(/^[a-z][a-z0-9-]*$/),
        variant: z.string().min(1),
        package: z.string().min(1),
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
        repository: z.string().url(),
        licence: z.string().min(1),
        licenceFile: z.string().min(1),
        licenceStatus: z.enum(["evidenced", "unknown", "conflict"]),
      })
      .strict(),
    runtime: z
      .object({
        contract: z.string().min(1),
        path: z.string().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    definition: z
      .object({ settingsSchema: schema, selectionSchema: schema })
      .strict(),
    execution: z.record(
      z.string(),
      z
        .object({
          modes: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1),
          evidence: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
