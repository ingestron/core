/** Reviewed alternative execution bindings retain the original dataset contracts. */
import { relative } from "node:path";
import { visit } from "yaml";
import { z } from "zod";
import { editableProject, preview } from "./authoring.js";
import { canonical, check, digest } from "./errors.js";
import { flowSchema, projectSchema } from "./schema.js";
import { bindExecutionProfile } from "./execution-profiles.js";
const id = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/);
const definition = flowSchema.shape.executionProfiles.unwrap().valueType;
export const executionProfilesReadSchema = z.object({ flow: id }).strict();
export const executionProfilesReviewSchema = z
  .object({
    flow: id,
    name: id,
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    definition: definition.nullable(),
  })
  .strict();
function editor(root: string, flowId: string) {
  const workspace = editableProject(root),
    project = projectSchema.parse(workspace.reader.load()),
    flow = project.flows
      .map((f) => flowSchema.parse(f))
      .find((f) => f.id === flowId);
  check(
    flow && flow.kind === "ingestion" && !flow.steps,
    "PROFILE",
    "Select an ingestion flow without transformation steps",
  );
  const profiles = flow.executionProfiles;
  check(
    Object.keys(profiles).length <= 100,
    "LIMIT",
    "Inspect at most 100 execution profiles per flow",
  );
  return {
    workspace,
    project,
    flow,
    profiles,
    revision: digest(canonical(workspace.reader.files)),
  };
}
export function readExecutionProfiles(
  root: string,
  input: z.infer<typeof executionProfilesReadSchema>,
) {
  const { project, flow, profiles, revision } = editor(root, input.flow);
  return {
    apiVersion: "ingestron.execution-profiles/v1",
    flow: flow.id,
    revision,
    defaultProvider: flow.provider ?? project.defaults.provider,
    profiles,
    providers: Object.entries(project.providers.configurations).map(
      ([id, p]) => ({ id, package: p.package }),
    ),
    connections: Object.keys(project.connections),
  };
}
export function reviewExecutionProfile(
  root: string,
  input: z.infer<typeof executionProfilesReviewSchema>,
) {
  const { workspace, project, flow, profiles, revision } = editor(
    root,
    input.flow,
  );
  check(
    input.revision === revision,
    "STALE",
    "Flow or project changed after profile inspection",
  );
  check(
    input.definition !== null || Object.hasOwn(profiles, input.name),
    "PROFILE",
    "Select an existing profile to remove",
  );
  check(
    input.definition === null ||
      Object.hasOwn(profiles, input.name) ||
      Object.keys(profiles).length < 100,
    "LIMIT",
    "This flow already has 100 profiles",
  );
  if (input.definition) {
    check(
      JSON.stringify(input.definition).length <= 65536,
      "LIMIT",
      "Profile definition exceeds 64 KiB",
    );
    check(
      Object.hasOwn(
        project.providers.configurations,
        input.definition.provider,
      ),
      "PROVIDER",
      "Choose an existing provider configuration",
    );
    if (input.definition.ingestion.connection !== undefined)
      check(
        typeof input.definition.ingestion.connection === "string" &&
          Object.hasOwn(
            project.connections,
            input.definition.ingestion.connection,
          ),
        "CONNECTION",
        "Choose an existing portable connection",
      );
    bindExecutionProfile(
      {
        ...flow,
        executionProfiles: { ...profiles, [input.name]: input.definition },
      },
      input.name,
    );
  }
  const selected = workspace.selectFlow(input.flow),
    container = workspace.location({
      file: selected.file,
      prefix: [...selected.prefix, "executionProfiles"],
    }),
    doc = workspace.document(container.file);
  // A shared YAML alias is not an independently owned profile definition.
  visit(doc, {
    Alias() {
      check(
        false,
        "AUTHORING",
        "Edit a shared YAML alias in its owning definition before changing execution profiles",
      );
    },
  });
  const key = [...container.prefix, input.name];
  if (input.definition === null) doc.deleteIn(key);
  else {
    const target = workspace.location({ file: container.file, prefix: key }),
      targetDoc = workspace.document(target.file);
    visit(targetDoc, {
      Alias() {
        check(
          false,
          "AUTHORING",
          "Edit a shared YAML alias in its owning definition",
        );
      },
    });
    targetDoc.setIn(target.prefix, input.definition);
    if (target.file !== container.file)
      return preview(
        root,
        {
          [relative(workspace.reader.root, target.file)]: targetDoc.toString(),
        },
        workspace.reader.files,
      );
  }
  return preview(
    root,
    { [relative(workspace.reader.root, container.file)]: doc.toString() },
    workspace.reader.files,
  );
}
