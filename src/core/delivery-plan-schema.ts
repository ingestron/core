import { z } from "zod";

const identity = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/);
const text = z.string().trim().min(1).max(2000);
/** Reviewed intent only. Completion and runtime evidence are separate contracts. */
export const deliveryPlanSchema = z
  .object({
    apiVersion: z.literal("ingestron.delivery-plan/v1"),
    project: identity,
    revision: z.number().int().positive(),
    requirements: z
      .array(
        z
          .object({
            id: identity,
            title: z.string().trim().min(1).max(200),
            description: text,
            disposition: z.enum(["draft", "accepted", "deferred"]),
            acceptance: z.array(text).min(1).max(20),
            owner: z.string().trim().min(1).max(200).optional(),
          })
          .strict(),
      )
      .max(500),
    work: z
      .array(
        z
          .object({
            id: identity,
            title: z.string().trim().min(1).max(200),
            stage: z.enum([
              "discovery",
              "contracts",
              "development",
              "preparation",
              "verification",
              "delivery",
            ]),
            requirements: z.array(identity).min(1).max(500),
            dependsOn: z.array(identity).max(1000).default([]),
            owner: z.string().trim().min(1).max(200).optional(),
            due: z.iso.date().optional(),
            targets: z
              .array(
                z
                  .object({
                    kind: z.enum(["source", "runtime", "flow", "contract"]),
                    id: identity,
                  })
                  .strict(),
              )
              .max(1000)
              .default([]),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict()
  .superRefine((plan, context) => {
    const fail = (message: string, path: (string | number)[]) =>
      context.addIssue({ code: "custom", message, path });
    const requirements = new Set<string>();
    plan.requirements.forEach((requirement, index) => {
      if (requirements.has(requirement.id))
        fail("Duplicate requirement ID", ["requirements", index, "id"]);
      requirements.add(requirement.id);
    });
    const work = new Map(plan.work.map((item) => [item.id, item]));
    const seen = new Set<string>();
    plan.work.forEach((item, index) => {
      if (seen.has(item.id)) fail("Duplicate work ID", ["work", index, "id"]);
      seen.add(item.id);
      for (const key of ["requirements", "dependsOn"] as const) {
        const refs = new Set<string>();
        item[key].forEach((reference, refIndex) => {
          if (refs.has(reference))
            fail("Duplicate reference", ["work", index, key, refIndex]);
          refs.add(reference);
          if (!(key === "requirements" ? requirements : work).has(reference))
            fail("Unknown reference", ["work", index, key, refIndex]);
          if (key === "dependsOn" && reference === item.id)
            fail("Work cannot depend on itself", [
              "work",
              index,
              key,
              refIndex,
            ]);
        });
      }
    });
    // Iterative traversal stays bounded even for the largest permitted plan.
    const complete = new Set<string>();
    for (const item of plan.work) {
      const active = new Set<string>();
      const stack: { id: string; exit: boolean }[] = [
        { id: item.id, exit: false },
      ];
      while (stack.length) {
        const current = stack.pop()!;
        if (current.exit) {
          active.delete(current.id);
          complete.add(current.id);
          continue;
        }
        if (active.has(current.id)) {
          fail("Work dependencies contain a cycle", ["work"]);
          return;
        }
        if (complete.has(current.id) || !work.has(current.id)) continue;
        active.add(current.id);
        stack.push({ ...current, exit: true });
        for (const dependency of work.get(current.id)!.dependsOn)
          stack.push({ id: dependency, exit: false });
      }
    }
  });

export type DeliveryPlan = z.infer<typeof deliveryPlanSchema>;
