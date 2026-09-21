import { z } from "zod";
/** Producer/consumer boundary; not an assertion that an upstream delivery exists. */
export const deliveryIndexSchema = z
  .object({
    apiVersion: z.literal("ingestron.delivery-index/v1"),
    dataset: z
      .string()
      .regex(/^[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*$/),
    deliveries: z
      .array(
        z
          .object({
            id: z.string().min(1),
            version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
            capturedAt: z.iso.datetime({ offset: true }),
            contractVersion: z.string().min(1),
            complete: z.literal(true),
            scope: z.literal("full-table"),
            rowCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
            path: z.string().regex(/^(abfss:\/\/|\/Volumes\/).+/),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
