import { z } from "zod";

/** Saved project policy. Authored ownership is not an authenticated approval. */
export const policySchema = z
  .object({
    apiVersion: z.literal("ingestron.policy/v1"),
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/),
    version: z.string().trim().min(1).max(100),
    owner: z.string().trim().min(1).max(200),
    rules: z
      .object({
        contractOwner: z
          .enum(["active-only", "required"])
          .default("active-only"),
        contractSteward: z.enum(["optional", "required"]).default("optional"),
        minimumRequiredQualityRules: z
          .number()
          .int()
          .min(0)
          .max(100)
          .default(0),
        allowedContractStatuses: z
          .array(z.string().trim().min(1).max(100))
          .min(1)
          .max(30)
          .optional(),
        workOwnersRequired: z.boolean().default(false),
        acceptedRequirementsAssigned: z.boolean().default(false),
        definitionTargetsRequired: z.boolean().default(false),
        reviewedBaselineRequired: z.boolean().default(false),
      })
      .strict(),
  })
  .strict();
export type ProjectPolicy = z.infer<typeof policySchema>;
