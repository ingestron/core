import { existsSync } from "node:fs";
import type { Configuration } from "./config.js";
import { fence } from "./packages.js";
import { canonical, check, digest } from "./errors.js";
import { contractGovernance } from "./governance.js";
import { contractRules } from "./quality.js";
import { deliveryPlanSchema } from "./delivery-plan-schema.js";
import { deliveryPlanDiff } from "./delivery-plan.js";
import type { Project, Flow } from "./schema.js";

/** Definition checks only: no source access, provider execution or identity claims. */
export function projectGovernance(
  state: { reader: Configuration; project: Project; flows: Flow[] },
  selection: { flow?: string; flowIds?: string[]; provider?: string } = {},
) {
  const { reader, project, flows } = state;
  const selected =
    selection.flowIds ??
    (selection.flow
      ? [selection.flow]
      : flows
          .filter(
            (f) =>
              !selection.provider ||
              (f.provider ?? project.defaults.provider) === selection.provider,
          )
          .map((f) => f.id));
  selected.forEach((id) =>
    check(
      flows.some((f) => f.id === id),
      "FLOW",
      `Unknown flow ${id}`,
    ),
  );
  const policy = project.policy;
  const issues: {
    code: string;
    severity: "error" | "warning";
    subject: string;
    message: string;
  }[] = [];
  const add = (
    code: string,
    required: boolean,
    subject: string,
    message: string,
  ) =>
    issues.push({
      code,
      severity: required ? "error" : "warning",
      subject,
      message,
    });
  const allContracts = new Set<string>();
  const products = new Map<
    string,
    ReturnType<typeof contractGovernance> & {
      flows: string[];
      requiredQualityRules: number;
      definitionDigest: string;
    }
  >();
  for (const flow of flows)
    for (const table of Object.values({ ...flow.tables, ...flow.publishes })) {
      const contract = table?.contract;
      if (!contract || typeof contract !== "object") continue;
      const product = contractGovernance(contract);
      allContracts.add(product.contract);
      if (!selected.includes(flow.id)) continue;
      const key = `${product.contract}@${product.version ?? ""}`;
      const definitionDigest = digest(canonical(contract));
      const existing = products.get(key);
      if (existing) {
        if (existing.definitionDigest !== definitionDigest)
          add(
            "CONTRACT_CONFLICT",
            true,
            key,
            "The same contract identity has different definitions",
          );
        if (!existing.flows.includes(flow.id)) existing.flows.push(flow.id);
        continue;
      }
      const requiredQualityRules = new Set(
        contractRules(contract)
          .filter((r) => r.outcome === "fail")
          .map((r) => r.id),
      ).size;
      products.set(key, {
        ...product,
        flows: [flow.id],
        requiredQualityRules,
        definitionDigest,
      });
      if (!product.owners.length)
        add(
          "CONTRACT_OWNER",
          product.status === "active" ||
            policy?.rules.contractOwner === "required",
          key,
          "Contract has no current owner",
        );
      if (!product.stewards.length)
        add(
          "CONTRACT_STEWARD",
          policy?.rules.contractSteward === "required",
          key,
          "Contract has no current steward",
        );
      if (
        policy &&
        requiredQualityRules < policy.rules.minimumRequiredQualityRules
      )
        add(
          "QUALITY_MINIMUM",
          true,
          key,
          "Contract has fewer required quality rules than the project policy",
        );
      if (
        policy?.rules.allowedContractStatuses &&
        !policy.rules.allowedContractStatuses.includes(product.status ?? "")
      )
        add(
          "CONTRACT_STATUS",
          true,
          key,
          "Contract status is outside the project policy",
        );
    }
  const planPath = "delivery-plan.yaml",
    baselinePath = "delivery-plan.baseline.yaml";
  const plan = existsSync(fence(reader.root, planPath))
    ? deliveryPlanSchema.parse(reader.load(planPath))
    : undefined;
  const baseline = existsSync(fence(reader.root, baselinePath))
    ? deliveryPlanSchema.parse(reader.load(baselinePath))
    : undefined;
  if (plan)
    check(
      plan.project === project.id,
      "PROJECT",
      "Delivery plan belongs to another project",
      planPath,
    );
  if (baseline)
    check(
      baseline.project === project.id,
      "PROJECT",
      "Delivery baseline belongs to another project",
      baselinePath,
    );
  const targetExists = (target: { kind: string; id: string }) =>
    target.kind === "source"
      ? Object.hasOwn(project.connections, target.id)
      : target.kind === "runtime"
        ? Object.hasOwn(project.providers.configurations, target.id)
        : target.kind === "flow"
          ? flows.some((f) => f.id === target.id)
          : allContracts.has(target.id);
  const work = (plan?.work ?? []).map((item) => ({
    id: item.id,
    owner: item.owner,
    missingTargets: item.targets.filter((t) => !targetExists(t)),
    targets: item.targets.length,
  }));
  for (const item of work) {
    if (!item.owner)
      add(
        "WORK_OWNER",
        !!policy?.rules.workOwnersRequired,
        item.id,
        "Work has no assigned owner",
      );
    if (!item.targets || item.missingTargets.length)
      add(
        "WORK_TARGET",
        !!policy?.rules.definitionTargetsRequired,
        item.id,
        "Work needs targets that exist in the project",
      );
  }
  const assigned = new Set(plan?.work.flatMap((w) => w.requirements));
  const unassigned = (plan?.requirements ?? [])
    .filter((r) => r.disposition === "accepted" && !assigned.has(r.id))
    .map((r) => r.id);
  unassigned.forEach((id) =>
    add(
      "REQUIREMENT_UNASSIGNED",
      !!policy?.rules.acceptedRequirementsAssigned,
      id,
      "Accepted requirement has no assigned work",
    ),
  );
  const needsPlan =
    policy &&
    (policy.rules.workOwnersRequired ||
      policy.rules.acceptedRequirementsAssigned ||
      policy.rules.definitionTargetsRequired ||
      policy.rules.reviewedBaselineRequired);
  if (!plan && needsPlan)
    add(
      "DELIVERY_PLAN",
      true,
      project.id,
      "Project policy requires a delivery plan",
    );
  const baselineCurrent =
    !!plan &&
    !!baseline &&
    !deliveryPlanDiff(baseline, plan).contentChanged &&
    baseline.revision === plan.revision;
  if (policy?.rules.reviewedBaselineRequired && !baselineCurrent)
    add(
      "DELIVERY_BASELINE",
      true,
      project.id,
      "Review the current delivery plan and save its baseline",
    );
  const report = {
    apiVersion: "ingestron.governance-check/v1",
    project: project.id,
    evaluatedOn: new Date().toISOString().slice(0, 10),
    selection: selected.sort(),
    policy: policy
      ? {
          id: policy.id,
          version: policy.version,
          owner: policy.owner,
          digest: digest(canonical(policy)),
        }
      : null,
    policyReady: policy ? !issues.some((i) => i.severity === "error") : null,
    products: [...products.values()]
      .map((p) => ({ ...p, flows: p.flows.sort() }))
      .sort((a, b) =>
        `${a.contract}@${a.version}`.localeCompare(
          `${b.contract}@${b.version}`,
        ),
      ),
    delivery: {
      defined: !!plan,
      baselineCurrent,
      work,
      unassignedRequirements: unassigned,
    },
    issues,
    inputDigests: { ...reader.files },
    evidence:
      "Current project definitions and saved planning baseline; no authenticated approval, runtime quality result or deployment proof",
  };
  return { ...report, digest: digest(canonical(report)) };
}

export function enforceProjectPolicy(
  state: Parameters<typeof projectGovernance>[0],
  selection: Parameters<typeof projectGovernance>[1],
) {
  if (!state.project.policy || selection?.flowIds?.length === 0) return;
  const report = projectGovernance(state, selection);
  check(
    report.policyReady,
    "POLICY",
    report.issues
      .filter((i) => i.severity === "error")
      .map((i) => `${i.subject}: ${i.message}`)
      .join("; "),
  );
}
