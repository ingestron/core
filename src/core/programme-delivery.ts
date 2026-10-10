/** Materialise explicitly selected programme work without creating a second planning editor. */
import { existsSync } from "node:fs";
import { z } from "zod";
import { stringify } from "yaml";
import { Configuration } from "./config.js";
import { canonical, check, digest } from "./errors.js";
import { readProgramme } from "./programme.js";
import { withProgrammeWrite } from "./programme-transaction.js";
import { programmeSourceSchema } from "./platform-binding.js";
import { deliveryPlanSchema } from "./delivery-plan-schema.js";
import { deliveryPlanDiff, proposeDeliveryBaseline } from "./delivery-plan.js";
import { preview, apply } from "./authoring.js";
import { fence } from "./packages.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/);
const workSchema = deliveryPlanSchema.shape.work.element;
const selectionSchema = z
  .object({
    requirements: z
      .array(
        z
          .object({
            id: identity,
            disposition: z.enum(["draft", "accepted", "deferred"]),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    work: z
      .array(
        workSchema.pick({
          id: true,
          stage: true,
          requirements: true,
          targets: true,
        }),
      )
      .max(200),
  })
  .strict();
export const programmeDeliveryReadSchema = z
  .object({
    programme: programmeSourceSchema,
    project: z.string().min(1).max(160),
  })
  .strict();
export const programmeDeliveryReviewSchema = programmeDeliveryReadSchema
  .extend({
    revision: sha,
    selection: selectionSchema,
    adoptExisting: z.boolean().default(false),
  })
  .strict();
export const programmeDeliveryBaselineSchema = programmeDeliveryReadSchema
  .extend({ revision: sha })
  .strict();
export const programmeDeliveryApplySchema = z
  .object({
    programme: programmeSourceSchema,
    review: z.unknown(),
  })
  .strict();
const planPath = "delivery-plan.yaml",
  sourcePath = "delivery-plan.source.yaml";
const sourceSchema = z
  .object({
    apiVersion: z.literal("ingestron.programme-delivery-source/v1"),
    programme: identity,
    project: z.string(),
    compiler: z.string(),
    sourceDigest: sha,
    planFileDigest: sha,
    selection: selectionSchema,
  })
  .strict();
function state(
  root: string,
  request: z.infer<typeof programmeDeliveryReadSchema>,
) {
  const reader = new Configuration(root, {}),
    project = reader.load();
  const saved = readProgramme(request.programme.root, request.programme.id);
  check(
    saved.document,
    "PROGRAMME",
    "Save the programme before creating a build plan",
  );
  const document = saved.document;
  const registration = document.projects.find((p) => p.id === request.project);
  check(
    registration && registration.compilerId === project.id,
    "PROJECT",
    "Register this compiler project in the selected programme",
  );
  const eligible = document.requirements.filter((item) => {
    if (
      item.targetProvider &&
      !registration.targets?.some((t) => t.provider === item.targetProvider)
    )
      return false;
    if (
      item.applications?.some(
        (a) => a.projectId === request.project && a.status === "not-applicable",
      )
    )
      return false;
    if (
      item.projectIds.includes(request.project) ||
      item.applications?.some(
        (a) => a.projectId === request.project && a.status !== "not-applicable",
      )
    )
      return true;
    if (item.area?.kind === "project") return item.area.id === request.project;
    if (item.area?.kind === "platform")
      return item.area.id === registration.platformId;
    return item.projectIds.length === 0;
  });
  const plan = existsSync(fence(root, planPath))
    ? deliveryPlanSchema.parse(reader.load(planPath))
    : null;
  check(
    !plan || plan.project === project.id,
    "PROJECT",
    "Existing delivery plan belongs to another project",
  );
  const source = existsSync(fence(root, sourcePath))
    ? sourceSchema.parse(reader.load(sourcePath))
    : null;
  check(
    !source ||
      (source.programme === document.id &&
        source.project === request.project &&
        source.compiler === project.id),
    "OWNER",
    "The saved plan handoff belongs to another programme or project",
  );
  const sourceDigest = digest(canonical(document));
  const baseline = existsSync(fence(root, "delivery-plan.baseline.yaml"))
    ? deliveryPlanSchema.parse(reader.load("delivery-plan.baseline.yaml"))
    : null;
  check(
    !baseline || baseline.project === project.id,
    "PROJECT",
    "Delivery baseline belongs to another project",
  );
  return {
    reader,
    project,
    document,
    eligible,
    plan,
    source,
    sourceDigest,
    baseline,
    revision: digest(canonical({ files: reader.files, sourceDigest })),
  };
}
export function readProgrammeDelivery(
  root: string,
  request: z.infer<typeof programmeDeliveryReadSchema>,
) {
  const s = state(root, request);
  return {
    apiVersion: "ingestron.programme-delivery/v1",
    revision: s.revision,
    sourceDigest: s.sourceDigest,
    project: s.project.id,
    items: s.eligible,
    plan: s.plan,
    selection: s.source?.selection ?? null,
    sourceChanged: !!s.source && s.source.sourceDigest !== s.sourceDigest,
    independentlyEdited:
      !!s.plan &&
      (!s.source || s.source.planFileDigest !== s.reader.files[planPath]),
    baseline: !!s.baseline,
    baselineCurrent:
      !!s.baseline &&
      !!s.plan &&
      !deliveryPlanDiff(s.baseline, s.plan).contentChanged &&
      s.baseline.revision === s.plan.revision,
  };
}
/** A linked compiler build must validate the currently authorised planning source. */
export function verifyProgrammeDelivery(
  root: string,
  programme?: z.infer<typeof programmeSourceSchema>,
) {
  if (!existsSync(fence(root, sourcePath))) return {};
  check(
    programme,
    "BINDING",
    "Supply the authorised programme to verify the reviewed delivery handoff before building",
  );
  const reader = new Configuration(root, {});
  const source = sourceSchema.parse(reader.load(sourcePath));
  const s = state(root, { programme, project: source.project });
  check(
    s.plan &&
      source.sourceDigest === s.sourceDigest &&
      source.planFileDigest === s.reader.files[planPath],
    "STALE",
    "Programme work or its compiler plan changed; review the delivery handoff before building",
  );
  return {
    [sourcePath]: s.reader.files[sourcePath]!,
    [planPath]: s.reader.files[planPath]!,
  };
}
export function reviewProgrammeDelivery(
  root: string,
  request: z.infer<typeof programmeDeliveryReviewSchema>,
) {
  const s = state(root, request);
  check(
    request.revision === s.revision,
    "STALE",
    "Programme or project definitions changed; inspect the planning handoff again",
  );
  check(
    !s.plan ||
      (!!s.source && s.source.planFileDigest === s.reader.files[planPath]) ||
      request.adoptExisting,
    "OWNER",
    "Explicitly adopt the existing delivery plan before replacing independent work",
  );
  const byId = new Map(s.eligible.map((item) => [item.id, item]));
  const required = new Set(request.selection.requirements.map((r) => r.id));
  const selectedWork = new Set(request.selection.work.map((w) => w.id));
  const requirements = request.selection.requirements.map((r) => {
    const item = byId.get(r.id);
    check(
      item &&
        ["requirement", "policy", "standard"].includes(
          item.kind ?? "requirement",
        ),
      "REQUIREMENT",
      "Select an eligible saved requirement, policy or standard",
    );
    return {
      id: item.id,
      title: item.title,
      description: item.description,
      disposition: r.disposition,
      acceptance: item.acceptance,
      ...(item.owner ? { owner: item.owner } : {}),
    };
  });
  const work = request.selection.work.map((w) => {
    const item = byId.get(w.id);
    check(item?.kind === "task", "WORK", "Select an eligible saved task");
    const basis = [...(item.basisIds ?? [])];
    if (
      item.parentId &&
      ["requirement", "policy", "standard"].includes(
        s.document.requirements.find((r) => r.id === item.parentId)?.kind ??
          "requirement",
      )
    )
      basis.push(item.parentId);
    check(
      basis.every((id) => required.has(id) && w.requirements.includes(id)),
      "REQUIREMENT",
      "Include each task's saved requirement basis in the handoff",
    );
    check(
      (item.dependsOn ?? []).every((id) => selectedWork.has(id)),
      "DEPENDENCY",
      "Include every saved task dependency; cross-project or non-task dependencies need resolution before handoff",
    );
    return {
      ...w,
      title: item.title,
      dependsOn: item.dependsOn ?? [],
      ...(item.owner ? { owner: item.owner } : {}),
      ...(item.due ? { due: item.due } : {}),
    };
  });
  const content = { requirements, work };
  const changed =
    !s.plan ||
    canonical(content) !==
      canonical({ requirements: s.plan.requirements, work: s.plan.work });
  const plan = deliveryPlanSchema.parse({
    apiVersion: "ingestron.delivery-plan/v1",
    project: s.project.id,
    revision: (s.plan?.revision ?? 0) + (changed ? 1 : 0),
    ...content,
  });
  const source = sourceSchema.parse({
    apiVersion: "ingestron.programme-delivery-source/v1",
    programme: s.document.id,
    project: request.project,
    compiler: s.project.id,
    sourceDigest: s.sourceDigest,
    planFileDigest: digest(stringify(plan)),
    selection: request.selection,
  });
  return {
    apiVersion: "ingestron.programme-delivery-review/v1",
    request,
    proposal: preview(root, {
      [planPath]: stringify(plan),
      [sourcePath]: stringify(source),
    }),
  };
}
export function reviewProgrammeDeliveryBaseline(
  root: string,
  request: z.infer<typeof programmeDeliveryBaselineSchema>,
) {
  const s = state(root, request);
  check(
    s.revision === request.revision,
    "STALE",
    "Programme or project definitions changed; inspect the baseline again",
  );
  check(
    s.plan &&
      s.source &&
      s.source.sourceDigest === s.sourceDigest &&
      s.source.planFileDigest === s.reader.files[planPath],
    "STALE",
    "Review and save the current programme handoff before recording its baseline",
  );
  return {
    apiVersion: "ingestron.programme-delivery-baseline-review/v1",
    request,
    proposal: proposeDeliveryBaseline(
      root,
      planPath,
      "delivery-plan.baseline.yaml",
    ),
  };
}
export function applyProgrammeDelivery(
  root: string,
  args: z.infer<typeof programmeDeliveryApplySchema>,
) {
  const review = z
    .discriminatedUnion("apiVersion", [
      z
        .object({
          apiVersion: z.literal("ingestron.programme-delivery-review/v1"),
          request: programmeDeliveryReviewSchema,
          proposal: z.unknown(),
        })
        .strict(),
      z
        .object({
          apiVersion: z.literal(
            "ingestron.programme-delivery-baseline-review/v1",
          ),
          request: programmeDeliveryBaselineSchema,
          proposal: z.unknown(),
        })
        .strict(),
    ])
    .parse(args.review);
  check(
    canonical(review.request.programme) === canonical(args.programme),
    "PROPOSAL",
    "Planning review belongs to another programme root",
  );
  return withProgrammeWrite(args.programme.root, () => {
    const fresh =
      review.apiVersion === "ingestron.programme-delivery-review/v1"
        ? reviewProgrammeDelivery(root, review.request)
        : reviewProgrammeDeliveryBaseline(root, review.request);
    check(
      canonical(fresh) === canonical(args.review),
      "STALE",
      "Planning review was altered or inputs changed; review again",
    );
    return apply(root, fresh.proposal);
  });
}
