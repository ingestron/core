import { z } from "zod";
import { canonical, check, digest } from "./errors.js";
import {
  compilerProjectId,
  programmeReadSchema,
  programmeSchema,
} from "./programme-schema.js";
import { readProgramme } from "./programme.js";

export const programmeRegistrationSchema = programmeReadSchema
  .extend({
    project: z.string().min(1).max(160),
    compilerId: compilerProjectId,
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** Logical identities and shared intent only; no project paths or credentials are resolved. */
export function inspectProgrammeDefinition(root: string, id: string) {
  const saved = readProgramme(root, id);
  check(
    saved.document,
    "PROGRAMME",
    "Save the programme before inspecting its definition",
  );
  const document = saved.document;
  return {
    apiVersion: "ingestron.programme-definition/v1",
    programmeId: document.id,
    sourceDigest: saved.digest,
    definitionDigest: digest(canonical(document)),
    projects: document.projects.map((project) => ({
      planId: project.id,
      compilerId: project.compilerId ?? null,
      name: project.name,
      platformId: project.platformId ?? null,
      targets: project.targets ?? [],
    })),
    platforms: (document.platforms ?? []).map((platform) => ({
      id: platform.id,
      name: platform.name,
      definitionDigest: digest(canonical(platform)),
      configuration: platform.configuration ?? null,
    })),
    workItemCount: document.requirements.length,
    executionEnabled: false,
  };
}

/** Read-only review; apply its document with programme_save and the same expectedDigest. */
export function proposeProgrammeRegistration(
  root: string,
  input: z.infer<typeof programmeRegistrationSchema>,
) {
  const args = programmeRegistrationSchema.parse(input);
  const saved = readProgramme(root, args.id);
  check(
    saved.document,
    "PROGRAMME",
    "Save the programme before registering a compiler identity",
  );
  check(
    saved.digest === args.expectedDigest,
    "CONFLICT",
    "Programme changed before registration review",
  );
  const selected = saved.document.projects.find((p) => p.id === args.project);
  check(selected, "PROGRAMME", "Select an existing programme project");
  check(
    !selected.compilerId || selected.compilerId === args.compilerId,
    "CONFLICT",
    "An existing compiler identity cannot be reassigned",
  );
  const document = programmeSchema.parse({
    ...saved.document,
    projects: saved.document.projects.map((p) =>
      p.id === args.project ? { ...p, compilerId: args.compilerId } : p,
    ),
  });
  return {
    apiVersion: "ingestron.programme-registration/v1",
    id: args.id,
    expectedDigest: saved.digest,
    document,
    review: {
      planId: selected.id,
      compilerId: args.compilerId,
      platformId: selected.platformId ?? null,
    },
    executionEnabled: false,
  };
}
