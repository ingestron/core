import { withWorkItemKeys } from "./programme-keys.js";
import { z } from "zod";
import { programmeSchema, type Programme } from "./programme-schema.js";
import { digest, check } from "./errors.js";
const reference = z
  .object({
    id: z.string().min(1).max(160),
    name: z.string().trim().min(1).max(120),
  })
  .strict();
export const programmeProjectTemplateSchema = z
  .object({
    id: z.string(),
    document: programmeSchema,
    newProject: reference,
    platform: reference,
    owner: z.string().trim().min(1).max(200),
    selectedRecordIds: z.array(z.string()).max(200).optional(),
    template: z.literal("full-data-product/v1"),
  })
  .strict();
/** Pure planning proposal. No project files, sources, providers or remote resources are touched. */
export function programmeProjectTemplate(
  input: z.infer<typeof programmeProjectTemplateSchema>,
) {
  const { newProject, platform, owner } = input;
  const doc = structuredClone(input.document);
  check(doc.id === input.id, "PROGRAMME", "Programme identity does not match");
  check(
    !doc.projects.some((p) => p.id === newProject.id),
    "CONFLICT",
    "Project area already exists",
  );
  doc.projects.push({
    ...newProject,
    platformId: platform.id,
    template: input.template,
  });
  doc.platforms ??= [];
  if (!doc.platforms.some((p) => p.id === platform.id))
    doc.platforms.push(platform);
  const key = (scope: string, id: string, step: string) =>
    `WBS-${digest(`${scope}:${id}:${step}`).slice(0, 20)}`;
  const area = (kind: "programme" | "platform" | "project", id: string) => ({
    kind,
    id,
  });
  const programmeArea = area("programme", doc.id),
    platformArea = area("platform", platform.id),
    projectArea = area("project", newProject.id);
  const add = (
    scope: typeof programmeArea,
    step: string,
    title: string,
    parentId?: string,
    dependsOn: string[] = [],
    component?: Programme["requirements"][number]["component"],
  ) => {
    const id = key(scope.kind, scope.id, step);
    if (doc.requirements.some((r) => r.id === id)) return id;
    doc.requirements.push({
      id,
      kind: parentId ? "task" : "epic",
      title,
      description: title,
      owner,
      priority: "must",
      disposition: "draft",
      acceptance: [],
      projectIds: scope.kind === "project" ? [newProject.id] : [],
      area: scope,
      ...(parentId ? { parentId } : {}),
      dependsOn,
      ...(component ? { component } : {}),
      templateKey: `${input.template}:${step}`,
    });
    return id;
  };
  const programme = add(
    programmeArea,
    "governance",
    "Programme delivery governance",
  );
  const requirements = add(
    programmeArea,
    "outcomes",
    "Agree outcomes and acceptance criteria",
    programme,
    [],
    "requirements",
  );
  const dependencyReview = add(
    programmeArea,
    "dependencies",
    "Review cross-project dependencies and milestones",
    programme,
    [requirements],
    "milestones",
  );
  const foundation = add(
    platformArea,
    "foundation",
    `${platform.name} — shared foundation`,
  );
  const environments = add(
    platformArea,
    "environments",
    "Prepare shared environments",
    foundation,
    [],
    "environments",
  );
  const access = add(
    platformArea,
    "access",
    "Review platform access and security controls",
    foundation,
    [environments],
    "policy",
  );
  const connections = add(
    platformArea,
    "connections",
    "Register and verify shared source connections",
    foundation,
    [access],
    "connections",
  );
  const standards = add(
    platformArea,
    "standards",
    "Select shared packages, models and standards",
    foundation,
    [access],
    "standards",
  );
  const selected = input.selectedRecordIds ?? [];
  check(
    new Set(selected).size === selected.length &&
      selected.every((id) =>
        doc.requirements.some(
          (r) =>
            r.id === id &&
            (!r.area ||
              r.area.kind === "programme" ||
              (r.area.kind === "platform" && r.area.id === platform.id)) &&
            ["requirement", "policy", "standard"].includes(
              r.kind ?? "requirement",
            ),
        ),
      ),
    "PROGRAMME",
    "Select programme requirements or requirements owned by this platform",
  );
  const product = add(
    projectArea,
    "product",
    `${newProject.name} — full data product`,
  );
  const scope = add(
    projectArea,
    "scope",
    "Review project requirements and source scope",
    product,
    [requirements, dependencyReview],
    "requirements",
  );
  const basisTasks = selected.map((id) => {
    const record = doc.requirements.find((r) => r.id === id)!;
    record.applications ??= [];
    record.applications.push({
      projectId: newProject.id,
      status: "planned",
      evidence: "",
    });
    const taskId = add(
      projectArea,
      `apply-${id}`,
      `Apply ${record.kind ?? "requirement"}: ${record.title}`,
      product,
      [scope],
      record.component ??
        (record.kind === "policy"
          ? "policy"
          : record.kind === "standard"
            ? "standards"
            : "requirements"),
    );
    const task = doc.requirements.find((r) => r.id === taskId)!;
    task.basisIds = [id];
    task.description = record.description;
    task.acceptance = [...record.acceptance];
    return taskId;
  });
  const source = add(
    projectArea,
    "sources",
    "Discover sources and verify project connection access",
    product,
    [scope, connections],
    "sources",
  );
  const ingestion = add(
    projectArea,
    "ingestion",
    "Define ingestion and raw data contracts",
    product,
    [source, standards],
    "ingestion",
  );
  const transform = add(
    projectArea,
    "transformations",
    "Develop transformations and apply data models",
    product,
    [ingestion],
    "transformations",
  );
  const presentation = add(
    projectArea,
    "presentation",
    "Define presentation datasets and consumption contracts",
    product,
    [transform],
    "presentation",
  );
  const quality = add(
    projectArea,
    "quality",
    "Apply and verify data quality across every layer",
    product,
    [ingestion, transform, presentation],
    "quality",
  );
  const build = add(
    projectArea,
    "build",
    "Generate and validate platform-native assets",
    product,
    [quality, environments],
    "build",
  );
  const verify = add(
    projectArea,
    "verification",
    "Reconcile outputs against acceptance criteria",
    product,
    [build, ...basisTasks],
    "quality",
  );
  const acceptance = add(
    programmeArea,
    `accept-${newProject.id}`,
    `Review ${newProject.name} acceptance and milestone evidence`,
    programme,
    [verify],
    "milestones",
  );
  const deployment = add(
    projectArea,
    "deployment",
    "Review and deploy the solution",
    product,
    [acceptance],
    "deployment",
  );
  add(
    projectArea,
    "handover",
    "Verify operations and hand over the data product",
    product,
    [deployment],
    "deployment",
  );
  return {
    document: withWorkItemKeys(programmeSchema.parse(doc)),
    digest: null,
  };
}
