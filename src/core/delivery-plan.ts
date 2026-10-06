import { existsSync } from "node:fs";
import { fence } from "./packages.js";
import { stringify } from "yaml";
import { preview } from "./authoring.js";
import { Configuration } from "./config.js";
import { canonical, check, digest } from "./errors.js";
import {
  deliveryPlanSchema,
  type DeliveryPlan,
} from "./delivery-plan-schema.js";

export function deliveryPlanDiff(before: DeliveryPlan, after: DeliveryPlan) {
  check(
    before.project === after.project,
    "PROJECT",
    "Delivery plans belong to different projects",
  );
  const compare = <T extends { id: string }>(left: T[], right: T[]) => {
    const old = new Map(left.map((item) => [item.id, canonical(item)]));
    const current = new Map(right.map((item) => [item.id, canonical(item)]));
    return {
      added: [...current.keys()].filter((id) => !old.has(id)).sort(),
      removed: [...old.keys()].filter((id) => !current.has(id)).sort(),
      changed: [...current.keys()]
        .filter((id) => old.has(id) && old.get(id) !== current.get(id))
        .sort(),
    };
  };
  const requirements = compare(before.requirements, after.requirements);
  const work = compare(before.work, after.work);
  const changedRequirements = new Set([
    ...requirements.changed,
    ...requirements.removed,
  ]);
  const impacted = new Set([...work.changed, ...work.added]);
  after.work.forEach((item) => {
    if (item.requirements.some((id) => changedRequirements.has(id)))
      impacted.add(item.id);
  });
  // A changed upstream work package affects every dependent work package.
  const dependants = new Map<string, string[]>();
  after.work.forEach((item) =>
    item.dependsOn.forEach((id) => {
      const children = dependants.get(id) ?? [];
      children.push(item.id);
      dependants.set(id, children);
    }),
  );
  const queue = [...impacted];
  for (let index = 0; index < queue.length; index++)
    for (const id of dependants.get(queue[index]) ?? [])
      if (!impacted.has(id)) {
        impacted.add(id);
        queue.push(id);
      }
  return {
    requirements,
    work,
    affectedWork: [...impacted].sort(),
    revisionAdvanced: after.revision > before.revision,
    contentChanged:
      canonical({ requirements: before.requirements, work: before.work }) !==
      canonical({ requirements: after.requirements, work: after.work }),
  };
}

/** Offline intent checking; no provider loading, secret resolution or execution. */
export function checkDeliveryPlan(
  root: string,
  path: string,
  baseline?: string,
) {
  const reader = new Configuration(root, {});
  const plan = deliveryPlanSchema.parse(reader.load(path));
  const project = reader.load();
  check(
    plan.project === project.id,
    "PROJECT",
    "Delivery plan belongs to another project",
  );
  const accepted = plan.requirements.filter(
    (item) => item.disposition === "accepted",
  );
  const assigned = new Set(plan.work.flatMap((item) => item.requirements));
  const diff = baseline
    ? deliveryPlanDiff(deliveryPlanSchema.parse(reader.load(baseline)), plan)
    : undefined;
  return {
    apiVersion: "ingestron.delivery-plan-check/v1",
    project: plan.project,
    plan,
    planRevision: plan.revision,
    planDigest: digest(canonical(plan)),
    requirements: {
      total: plan.requirements.length,
      accepted: accepted.length,
      unassigned: accepted
        .filter((item) => !assigned.has(item.id))
        .map((item) => item.id),
    },
    work: {
      total: plan.work.length,
      withoutOwner: plan.work
        .filter((item) => !item.owner)
        .map((item) => item.id),
    },
    ...(diff ? { diff } : {}),
    evidence:
      "Reviewed planning definitions only; no acceptance, progress, schedule or delivery proof",
  };
}

/** Intent authoring uses the same reviewed proposal/apply boundary as project edits. */
export function proposeDeliveryPlan(
  root: string,
  plan: DeliveryPlan,
  path = "delivery-plan.yaml",
) {
  const project = new Configuration(root, {}).load();
  check(
    plan.project === project.id,
    "PROJECT",
    "Delivery plan belongs to another project",
  );
  return preview(root, { [path]: stringify(deliveryPlanSchema.parse(plan)) });
}
export function proposeDeliveryBaseline(
  root: string,
  path = "delivery-plan.yaml",
  baseline = "delivery-plan.baseline.yaml",
) {
  check(
    path !== baseline,
    "PATH",
    "Baseline and current plan must use different files",
  );
  const result = checkDeliveryPlan(
    root,
    path,
    existsSync(fence(root, baseline)) ? baseline : undefined,
  );
  check(
    !result.diff?.contentChanged || result.diff.revisionAdvanced,
    "REVISION",
    "Advance the plan revision before replacing a changed baseline",
  );
  return preview(root, { [baseline]: stringify(result.plan) });
}
