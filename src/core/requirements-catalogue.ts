import { z } from "zod";
import { programmeSchema, type Programme } from "./programme-schema.js";
import { platformCatalogue } from "./platform-catalogue.js";
import { withWorkItemKeys } from "./programme-keys.js";
import { check } from "./errors.js";
type Area = { kind: "programme" | "platform" | "project"; id: string };
type Item = Programme["requirements"][number];
type Starter = {
  id: string;
  kind: "requirement" | "policy" | "standard";
  title: string;
  description: string;
  acceptance: string[];
  component: Item["component"];
  reason: string;
  recommended: boolean;
  targetProvider?: "fabric" | "databricks" | "adf";
};
export const requirementsTemplateSchema = z
  .object({
    id: z.string(),
    document: programmeSchema,
    area: z
      .object({
        kind: z.enum(["programme", "platform", "project"]),
        id: z.string(),
      })
      .strict(),
    owner: z.string().trim().min(1).max(200),
    selected: z.array(z.string()).max(100).default([]),
  })
  .strict();
/** Suggestions derive from the selected scope and recorded target settings, never tenant claims. */
export function requirementStarters(doc: Programme, area: Area): Starter[] {
  check(
    area.kind === "programme"
      ? area.id === doc.id
      : (area.kind === "platform" ? doc.platforms : doc.projects)?.some(
          (p) => p.id === area.id,
        ),
    "PROGRAMME",
    "Choose an existing requirements scope",
  );
  const result: Starter[] = [];
  const add = (
    id: string,
    kind: Starter["kind"],
    title: string,
    description: string,
    acceptance: string,
    component: Item["component"],
    reason = "Suggested starting point",
    recommended = true,
  ) =>
    result.push({
      id,
      kind,
      title,
      description,
      acceptance: [acceptance],
      component,
      reason,
      recommended,
    });
  if (area.kind === "programme") {
    add(
      "outcomes",
      "requirement",
      "Agree business outcomes and acceptance",
      "Define the outcomes, consumers and acceptance owners for the programme.",
      "Each outcome has an owner and measurable acceptance criteria.",
      "requirements",
    );
    add(
      "ownership",
      "policy",
      "Assign accountable delivery owners",
      "Keep programme, shared platform and project responsibilities explicit.",
      "Each delivery area has an accountable owner and reviewer.",
      "policy",
    );
    add(
      "promotion",
      "policy",
      "Review changes before promotion",
      "Agree the evidence required to approve each delivery milestone.",
      "Milestone approval records the reviewer and acceptance evidence.",
      "milestones",
    );
  } else if (area.kind === "platform") {
    add(
      "environments",
      "standard",
      "Separate environment bindings",
      "Use common environment names with distinct resource and credential bindings per target.",
      "Every target has reviewed bindings for its intended environments.",
      "environments",
    );
    add(
      "credentials",
      "policy",
      "Keep credentials out of shared definitions",
      "Use approved secret references; local development values remain local.",
      "Shared definitions and generated assets contain no credential values.",
      "policy",
    );
    add(
      "naming",
      "standard",
      "Use agreed asset naming",
      "Record asset naming patterns in each target profile.",
      "Generated asset names conform to the selected target's approved patterns.",
      "standards",
    );
  } else {
    add(
      "source-scope",
      "requirement",
      "Confirm source scope and access",
      "Identify the authorised datasets, owners and permitted discovery context.",
      "Each source has an owner, agreed scope and verified access path.",
      "sources",
    );
    add(
      "reconciliation",
      "requirement",
      "Reconcile delivered data",
      "Define source-to-output reconciliation and quality criteria across the data layers.",
      "Acceptance evidence reconciles agreed totals, keys and data quality checks.",
      "quality",
    );
    add(
      "consumption",
      "requirement",
      "Define the published data contract",
      "Agree the output schema, grain, consumers and refresh expectations.",
      "The consumer accepts the published schema and refresh expectations.",
      "presentation",
    );
  }
  const project = doc.projects.find((p) => p.id === area.id);
  const platform = doc.platforms?.find(
    (p) => p.id === (area.kind === "platform" ? area.id : project?.platformId),
  );
  const targets =
    area.kind === "programme"
      ? []
      : (platform?.configuration?.targets ?? []).filter(
          (t) =>
            area.kind === "platform" ||
            project?.targets?.some((a) => a.provider === t.provider),
        );
  for (const target of targets) {
    const firstTargetItem = result.length;
    const catalogue = platformCatalogue.find((c) => c.id === target.provider)!;
    for (const policy of catalogue.policies)
      if (area.kind === "platform" && target.policies[policy.id] === "enabled")
        add(
          `${target.provider}-policy-${policy.id}`,
          "policy",
          `${catalogue.name}: ${policy.label}`,
          policy.description,
          `Record evidence that ${policy.label.toLowerCase()} is satisfied for the selected ${catalogue.name} assets.`,
          "policy",
          `Required in ${catalogue.name} target profile`,
        );
    for (const field of catalogue.generation ?? []) {
      const choice = field.options.find(
        (o) => o.id === target.generation?.[field.id],
      );
      if (!choice || field.group === "Generation policies") continue;
      add(
        `${target.provider}-${area.kind === "project" ? "application" : "generation"}-${field.id}`,
        area.kind === "project" ? "requirement" : "standard",
        `${catalogue.name}: ${area.kind === "project" ? "apply " : ""}${choice.label}`,
        `Review ${choice.label} eligibility and apply the agreed ${field.label.toLowerCase()} choice.`,
        `Record eligibility and implementation evidence for ${choice.label}.`,
        "standards",
        `${catalogue.name} profile · ${field.label}${choice.support === "planned" ? " · implementation planned" : ""}`,
        choice.support !== "planned",
      );
    }
    for (const capability of catalogue.capabilities)
      if (target.capabilities[capability.id] === "enabled")
        add(
          `${target.provider}-capability-${capability.id}`,
          "requirement",
          `${catalogue.name}: verify ${capability.label}`,
          capability.description,
          `Confirm availability, access and suitability of ${capability.label} before use.`,
          "requirements",
          `Allowed in ${catalogue.name} profile; availability not verified`,
          false,
        );
    for (const starter of result.slice(firstTargetItem))
      starter.targetProvider = target.provider;
  }
  return result;
}
export function requirementsTemplate(
  input: z.infer<typeof requirementsTemplateSchema>,
) {
  check(
    input.id === input.document.id,
    "PROGRAMME",
    "Programme identity does not match",
  );
  const doc = structuredClone(input.document);
  const catalogue = requirementStarters(doc, input.area);
  check(
    new Set(input.selected).size === input.selected.length &&
      input.selected.every((id) => catalogue.some((c) => c.id === id)),
    "PROGRAMME",
    "Choose distinct available requirement starters",
  );
  for (const id of input.selected) {
    const starter = catalogue.find((c) => c.id === id)!;
    const templateKey = `requirements/v1:${id}`;
    if (
      doc.requirements.some(
        (r) =>
          r.templateKey === templateKey &&
          r.area?.kind === input.area.kind &&
          r.area.id === input.area.id,
      )
    )
      continue;
    const prefix = { requirement: "REQ", policy: "POL", standard: "STD" }[
      starter.kind
    ];
    let n = 1;
    while (
      doc.requirements.some(
        (r) => r.id === `${prefix}-${n}` || r.key === `${prefix}-${n}`,
      )
    )
      n++;
    doc.requirements.push({
      id: `${prefix}-${n}`,
      kind: starter.kind,
      title: starter.title,
      ...(starter.targetProvider
        ? { targetProvider: starter.targetProvider }
        : {}),
      description: starter.description,
      acceptance: starter.acceptance,
      component: starter.component,
      owner: input.owner,
      priority: "must",
      disposition: "draft",
      projectIds: input.area.kind === "project" ? [input.area.id] : [],
      ...(input.area.kind === "project"
        ? {
            applications: [
              {
                projectId: input.area.id,
                status: "planned" as const,
                evidence: "",
              },
            ],
          }
        : {}),
      area: input.area,
      templateKey,
    });
  }
  return {
    document: withWorkItemKeys(programmeSchema.parse(doc)),
    digest: null,
    requirementStarters: catalogue,
  };
}
