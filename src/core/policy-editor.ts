/** The policy editor reuses project governance and the existing reviewed policy writer. */
import { z } from "zod";
import { Configuration } from "./config.js";
import { canonical, check, digest } from "./errors.js";
import { projectSchema } from "./schema.js";
import { policySchema } from "./policy-schema.js";
import { configurePolicy } from "./authoring.js";
export const policyEditorReviewSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    policy: policySchema,
  })
  .strict();
export function readPolicyEditor(root: string) {
  const reader = new Configuration(root, {}),
    project = projectSchema.parse(reader.load());
  return {
    apiVersion: "ingestron.policy-editor/v1",
    project: project.id,
    policy: project.policy ?? null,
    policyDigest: project.policy ? digest(canonical(project.policy)) : null,
    revision: digest(canonical(reader.files)),
  };
}
export function reviewPolicyEditor(
  root: string,
  input: z.infer<typeof policyEditorReviewSchema>,
) {
  check(
    readPolicyEditor(root).revision === input.revision,
    "STALE",
    "Project policy or definitions changed after inspection",
  );
  return configurePolicy(root, input.policy);
}
