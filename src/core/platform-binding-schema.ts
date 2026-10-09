import { z } from "zod";
import { programmeSchema, compilerProjectId } from "./programme-schema.js";
import { platformProvider } from "./platform-schema.js";
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const platformBindingSchema = z
  .object({
    apiVersion: z.literal("ingestron.platform-binding/v1"),
    programmeId: z.string(),
    planProjectId: z.string(),
    projectId: compilerProjectId,
    platformId: z.string(),
    projectEnvironment: compilerProjectId,
    sharedEnvironment: compilerProjectId,
    target: platformProvider,
    configuration: compilerProjectId,
    package: z
      .object({
        reference: z.string(),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        digest: sha,
      })
      .strict(),
    source: z
      .object({ definitionDigest: sha, document: programmeSchema })
      .strict(),
    materialised: z
      .object({
        packageAlias: compilerProjectId,
        bindingName: compilerProjectId,
        binding: z.record(z.string(), z.unknown()),
        options: z.record(z.string(), z.unknown()),
      })
      .strict(),
    ownership: z.string().max(2000),
    pendingIntent: z.array(z.string().max(2000)).max(20),
  })
  .strict();
export type PlatformBinding = z.infer<typeof platformBindingSchema>;
