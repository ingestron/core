import { z } from "zod";
import { canonical, check, digest } from "./errors.js";
import { readProgramme, saveProgramme } from "./programme.js";
import { programmeSourceSchema } from "./platform-binding.js";
import { compilerProjectId } from "./programme-schema.js";
import { platformProvider } from "./platform-schema.js";
import { Configuration } from "./config.js";
import { projectSchema } from "./schema.js";
export const targetSetupSchema = z
  .object({
    programme: programmeSourceSchema,
    project: z.string().min(1).max(160),
    target: platformProvider,
    sharedEnvironment: compilerProjectId,
    responsibilities: z
      .array(
        z.enum([
          "ingestion",
          "transformation",
          "presentation",
          "orchestration",
        ]),
      )
      .min(1)
      .max(4),
    authentication: z.enum([
      "azure-cli",
      "databricks-cli",
      "service-principal",
      "oauth-m2m",
      "managed-identity",
    ]),
  })
  .strict();
export const targetSetupApplySchema = z
  .object({
    input: targetSetupSchema,
    review: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export function reviewTargetSetup(
  root: string,
  input: z.infer<typeof targetSetupSchema>,
) {
  input = targetSetupSchema.parse(input);
  check(
    new Set(input.responsibilities).size === input.responsibilities.length,
    "INPUT",
    "Use distinct target responsibilities",
  );
  const reader = new Configuration(root, {}),
    project = reader.parse(projectSchema, reader.load());
  const saved = readProgramme(input.programme.root, input.programme.id);
  check(saved.document, "PROGRAMME", "Save the programme first");
  const document = structuredClone(saved.document),
    selected = document.projects.find((p) => p.id === input.project);
  check(
    selected?.compilerId === project.id,
    "PROJECT",
    "Project registration does not match the selected project",
  );
  const platform = document.platforms?.find(
      (p) => p.id === selected.platformId,
    ),
    target = platform?.configuration?.targets.find(
      (t) => t.provider === input.target,
    );
  check(target, "PLATFORM", "Select a target in the project's shared platform");
  const environment = (platform!.configuration!.environments ?? []).find(
    (e) => e.name === input.sharedEnvironment,
  );
  check(environment, "ENVIRONMENT", "Select a declared shared environment");
  const current = selected.targets?.find((t) => t.provider === input.target);
  // Add explicitly selected responsibilities; never remove another author's assignments.
  selected.targets = [
    ...(selected.targets ?? []).filter((t) => t.provider !== input.target),
    {
      ...current,
      provider: input.target,
      responsibilities: [
        ...new Set([
          ...(current?.responsibilities ?? []),
          ...input.responsibilities,
        ]),
      ],
    },
  ];
  const profile = target.environments.find((e) => e.name === environment.name);
  if (!profile)
    target.environments.push({
      ...environment,
      authentication: input.authentication,
      configuration: {},
      secrets: [],
    });
  // Validate target authentication and all programme invariants before presenting review.
  const { programmeSchema } = schema;
  programmeSchema.parse(document);
  const review = digest(
    canonical({ input, source: saved.digest, document, project: project.id }),
  );
  return {
    input,
    review,
    sourceDigest: saved.digest,
    document,
    summary: {
      target: input.target,
      responsibilities: selected.targets.find(
        (t) => t.provider === input.target,
      )!.responsibilities,
      sharedEnvironment: environment.name,
      profile: profile ? "preserved" : "created",
      authentication: profile?.authentication ?? input.authentication,
      resourceChanges: false,
    },
  };
}
import * as schema from "./programme-schema.js";
export function applyTargetSetup(
  root: string,
  request: z.infer<typeof targetSetupApplySchema>,
) {
  request = targetSetupApplySchema.parse(request);
  const next = reviewTargetSetup(root, request.input);
  check(
    next.review === request.review,
    "STALE",
    "Shared settings changed; review target setup again",
  );
  saveProgramme(
    request.input.programme.root,
    request.input.programme.id,
    next.sourceDigest,
    next.document,
  );
  return { applied: true };
}
