import { z } from "zod";
import { programmeSchema } from "./programme-schema.js";
import {
  platformTargetSchema,
  platformConfigurationSchema,
} from "./platform-schema.js";
const platformIdentity = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/);
const reference = z.object({ $resolve: z.string().min(1).max(300) }).strict();
const platformReference = z
  .object({ id: platformIdentity, definition: z.string().min(1).max(300) })
  .strict();
export const programmeManifestSchema = z
  .object({
    ...programmeSchema.shape,
    apiVersion: z.literal("ingestron.programme/v2"),
    requirements: reference,
    platforms: z.array(platformReference).max(100).optional(),
  })
  .strict();
const targetSchema = z
  .object({
    ...platformTargetSchema.shape,
    environments: z.array(reference).max(20),
  })
  .strict();
export const platformDefinitionSchema = z
  .object({
    apiVersion: z.literal("ingestron.platform/v1"),
    id: platformIdentity,
    name: z.string().trim().min(1).max(200),
    configuration: z
      .object({
        environments: platformConfigurationSchema.shape.environments,
        targets: z.array(targetSchema).max(3),
      })
      .strict()
      .optional(),
  })
  .strict();
export const platformEnvironmentSchema =
  platformTargetSchema.shape.environments.element
    .extend({
      apiVersion: z.literal("ingestron.platform-environment/v1"),
      provider: platformTargetSchema.shape.provider,
    })
    .strict();
export const requirementsDefinitionSchema = z
  .object({
    apiVersion: z.literal("ingestron.requirements/v1"),
    requirements: programmeSchema.shape.requirements,
  })
  .strict();
