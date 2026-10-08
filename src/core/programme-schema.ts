import { z } from "zod";
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/);
const short = z.string().trim().max(200);
const text = z.string().trim().max(4000);
export const programmeSchema = z
  .object({
    apiVersion: z.literal("ingestron.programme/v1"),
    id,
    name: short.min(1),
    objective: text,
    sponsor: short,
    stakeholders: z
      .array(z.object({ name: short.min(1), role: short }).strict())
      .max(50),
    projects: z.array(z.object({ id, name: short.min(1) }).strict()).max(100),
    platforms: z
      .array(z.object({ id, name: short.min(1) }).strict())
      .max(100)
      .optional(),
    requirements: z
      .array(
        z
          .object({
            id,
            title: short.min(1),
            kind: z
              .enum(["epic", "requirement", "task", "milestone"])
              .optional(),
            parentId: id.optional(),
            milestoneId: id.optional(),
            due: z.iso.date().optional(),
            area: z
              .object({
                kind: z.enum(["programme", "platform", "project"]),
                id,
              })
              .strict()
              .optional(),
            externalRefs: z
              .array(
                z
                  .object({
                    system: z.enum(["jira", "azure-devops"]),
                    container: short.min(1),
                    id: short.min(1),
                    revision: short.optional(),
                  })
                  .strict(),
              )
              .max(10)
              .optional(),
            description: text,
            owner: short,
            priority: z.enum(["must", "should", "could"]),
            disposition: z.enum([
              "draft",
              "ready",
              "active",
              "done",
              "deferred",
            ]),
            acceptance: z.array(text.min(1)).max(20),
            projectIds: z.array(id).max(100),
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const fail = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });
    for (const key of ["projects", "requirements"] as const) {
      const seen = new Set<string>();
      doc[key].forEach((item, i) => {
        if (seen.has(item.id)) fail("Duplicate ID", [key, i, "id"]);
        seen.add(item.id);
      });
    }
    const projects = new Set(doc.projects.map((p) => p.id));
    const platforms = new Set((doc.platforms ?? []).map((p) => p.id));
    if (platforms.size !== (doc.platforms ?? []).length)
      fail("Duplicate platform ID", ["platforms"]);
    const items = new Map(doc.requirements.map((r) => [r.id, r]));
    const external = new Set<string>();
    doc.requirements.forEach((r, i) => {
      if (
        new Set(r.projectIds).size !== r.projectIds.length ||
        r.projectIds.some((p) => !projects.has(p))
      )
        fail("Choose distinct projects registered in this programme", [
          "requirements",
          i,
          "projectIds",
        ]);
      const kind = r.kind ?? "requirement";
      const parent = r.parentId ? items.get(r.parentId) : undefined;
      if (
        r.parentId &&
        (!parent ||
          r.parentId === r.id ||
          kind === "epic" ||
          kind === "milestone" ||
          !(
            (kind === "requirement" && parent.kind === "epic") ||
            (kind === "task" &&
              ["epic", "requirement"].includes(parent.kind ?? "requirement"))
          ))
      )
        fail(
          "Choose an epic parent for requirements, or an epic/requirement parent for tasks",
          ["requirements", i, "parentId"],
        );
      if (
        r.milestoneId &&
        (r.milestoneId === r.id ||
          items.get(r.milestoneId)?.kind !== "milestone" ||
          kind === "milestone")
      )
        fail("Choose a milestone from this programme", [
          "requirements",
          i,
          "milestoneId",
        ]);
      if (
        r.area &&
        !(r.area.kind === "programme"
          ? r.area.id === doc.id
          : r.area.kind === "platform"
            ? platforms.has(r.area.id)
            : projects.has(r.area.id))
      )
        fail("Choose a registered programme, platform or project area", [
          "requirements",
          i,
          "area",
        ]);
      for (const ref of r.externalRefs ?? []) {
        const key = JSON.stringify([ref.system, ref.container, ref.id]);
        if (external.has(key))
          fail("External work item is already linked", [
            "requirements",
            i,
            "externalRefs",
          ]);
        external.add(key);
      }
      if (
        ["ready", "active", "done"].includes(r.disposition) &&
        kind === "requirement" &&
        (!r.owner || !r.description || !r.acceptance.length)
      )
        fail(
          "Ready for review requires an owner, description and acceptance criteria",
          ["requirements", i],
        );
    });
  });
export type Programme = z.infer<typeof programmeSchema>;
export const programmeReadSchema = z.object({ id }).strict();
export const programmeSaveSchema = z
  .object({
    id,
    expectedDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    document: programmeSchema,
  })
  .strict();
