import { platformReuseSchema } from "./platform-reuse-schema.js";
import {
  platformConfigurationSchema,
  platformProvider,
} from "./platform-schema.js";
import { z } from "zod";
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/);
const projectId = z
  .string()
  .min(1)
  .max(160)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "Invalid project identity",
  );
const short = z.string().trim().max(200);
const text = z.string().trim().max(4000);
export const compilerProjectId = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/)
  .refine(
    (value) => !["__proto__", "constructor", "prototype"].includes(value),
  );
export const programmeSchema = z
  .object({
    apiVersion: z.literal("ingestron.programme/v1"),
    id,
    name: short.min(1),
    objective: text,
    nextWorkItemNumber: z.number().int().positive().optional(),
    sponsor: short,
    people: z.array(short.min(1)).max(200).optional(),
    stakeholders: z
      .array(z.object({ name: short.min(1), role: short }).strict())
      .max(50),
    projects: z
      .array(
        z
          .object({
            id: projectId,
            name: short.min(1),
            compilerId: compilerProjectId.optional(),
            platformId: id.optional(),
            targets: z
              .array(
                z
                  .object({
                    provider: platformProvider,
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
                  })
                  .strict(),
              )
              .max(3)
              .optional(),
            template: z.literal("full-data-product/v1").optional(),
          })
          .strict(),
      )
      .max(100),
    platforms: z
      .array(
        z
          .object({
            id,
            name: short.min(1),
            configuration: platformConfigurationSchema.optional(),
            reuse: platformReuseSchema.optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    requirements: z
      .array(
        z
          .object({
            id,
            title: short.min(1),
            targetProvider: platformProvider.optional(),
            key: z
              .string()
              .regex(/^[A-Za-z][A-Za-z0-9_-]{0,19}$/)
              .optional(),
            kind: z
              .enum([
                "epic",
                "requirement",
                "policy",
                "standard",
                "task",
                "milestone",
              ])
              .optional(),
            applications: z
              .array(
                z
                  .object({
                    projectId,
                    status: z.enum(["planned", "applied", "not-applicable"]),
                    evidence: text,
                  })
                  .strict(),
              )
              .max(100)
              .optional(),
            basisIds: z.array(id).max(200).optional(),
            parentId: id.optional(),
            dependsOn: z.array(id).max(200).optional(),
            component: z
              .enum([
                "requirements",
                "milestones",
                "environments",
                "policy",
                "connections",
                "standards",
                "sources",
                "ingestion",
                "transformations",
                "presentation",
                "quality",
                "build",
                "deployment",
              ])
              .optional(),
            templateKey: short.optional(),
            milestoneId: id.optional(),
            due: z.iso.date().optional(),
            area: z
              .object({
                kind: z.enum(["programme", "platform", "project"]),
                id: projectId,
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
            projectIds: z.array(projectId).max(100),
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
    const keys = doc.requirements.map((r) => r.key).filter(Boolean);
    if (new Set(keys).size !== keys.length)
      fail("Duplicate work item key", ["requirements"]);
    const projects = new Set(doc.projects.map((p) => p.id));
    const compilerIds = doc.projects.flatMap((p) =>
      p.compilerId ? [p.compilerId] : [],
    );
    if (new Set(compilerIds).size !== compilerIds.length)
      fail("Compiler project IDs must be distinct", ["projects"]);
    const platforms = new Set((doc.platforms ?? []).map((p) => p.id));
    if (platforms.size !== (doc.platforms ?? []).length)
      fail("Duplicate platform ID", ["platforms"]);
    doc.projects.forEach((p, i) => {
      if (p.platformId && !platforms.has(p.platformId))
        fail("Choose a registered platform", ["projects", i, "platformId"]);
      const targets = p.targets ?? [];
      const available =
        doc.platforms?.find((v) => v.id === p.platformId)?.configuration
          ?.targets ?? [];
      if (new Set(targets.map((t) => t.provider)).size !== targets.length)
        fail("Choose distinct project targets", ["projects", i, "targets"]);
      for (const t of targets) {
        if (!available.some((v) => v.provider === t.provider))
          fail("Configure the target on the shared platform first", [
            "projects",
            i,
            "targets",
          ]);
        if (new Set(t.responsibilities).size !== t.responsibilities.length)
          fail("Choose distinct target responsibilities", [
            "projects",
            i,
            "targets",
          ]);
      }
    });
    doc.platforms?.forEach((platform, i) => {
      for (const key of ["packages", "connections"] as const)
        for (const [j, definition] of (platform.reuse?.[key] ?? []).entries()) {
          if (
            definition.consumers.some(
              (consumer) =>
                !doc.projects.some(
                  (p) => p.id === consumer && p.platformId === platform.id,
                ),
            )
          )
            fail("Shared consumers must belong to this platform", [
              "platforms",
              i,
              "reuse",
              key,
              j,
              "consumers",
            ]);
        }
    });
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
      if (
        new Set(r.dependsOn ?? []).size !== (r.dependsOn ?? []).length ||
        (r.dependsOn ?? []).some((ref) => ref === r.id || !items.has(ref))
      )
        fail("Choose distinct existing dependencies", [
          "requirements",
          i,
          "dependsOn",
        ]);
      const kind = r.kind ?? "requirement";
      const catalogue = ["requirement", "policy", "standard"].includes(kind);
      const applications = r.applications ?? [];
      if (
        (!catalogue && applications.length) ||
        new Set(applications.map((a) => a.projectId)).size !==
          applications.length ||
        applications.some(
          (a) =>
            !projects.has(a.projectId) ||
            (a.status !== "planned" && !a.evidence.trim()),
        )
      )
        fail(
          "Application records need distinct registered projects and evidence or an exclusion reason",
          ["requirements", i, "applications"],
        );
      if (
        new Set(r.basisIds ?? []).size !== (r.basisIds ?? []).length ||
        (r.basisIds ?? []).some(
          (ref) =>
            ref === r.id ||
            !["requirement", "policy", "standard"].includes(
              items.get(ref)?.kind ?? (items.has(ref) ? "requirement" : ""),
            ),
        )
      )
        fail(
          "Choose existing requirements, policies or standards as the work basis",
          ["requirements", i, "basisIds"],
        );
      const parent = r.parentId ? items.get(r.parentId) : undefined;
      if (
        r.parentId &&
        (!parent ||
          r.parentId === r.id ||
          kind === "epic" ||
          kind === "milestone" ||
          !(
            (["requirement", "policy", "standard"].includes(kind) &&
              parent.kind === "epic") ||
            (kind === "task" &&
              ["epic", "requirement", "policy", "standard"].includes(
                parent.kind ?? "requirement",
              ))
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
        ["requirement", "policy", "standard"].includes(kind) &&
        (!r.owner || !r.description || !r.acceptance.length)
      )
        fail(
          "Ready for review requires an owner, description and acceptance criteria",
          ["requirements", i],
        );
    });
    const complete = new Set<string>();
    const active = new Set<string>();
    const visit = (id: string): boolean => {
      if (active.has(id)) return false;
      if (complete.has(id)) return true;
      active.add(id);
      for (const dependency of items.get(id)?.dependsOn ?? [])
        if (!visit(dependency)) return false;
      active.delete(id);
      complete.add(id);
      return true;
    };
    if ([...items.keys()].some((id) => !visit(id)))
      fail("Work dependencies contain a cycle", ["requirements"]);
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
