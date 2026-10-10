/** Compare explicit shared intent with concrete, core-owned flow proposals. */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { apply, editableProject, type Proposal } from "./authoring.js";
import { Configuration } from "./config.js";
import { canonical, check, digest } from "./errors.js";
import {
  createFlowEditor,
  flowEditorCreateSchema,
  flowEditorReviewSchema,
  reviewFlowEditor,
} from "./flow-editor.js";
import { configuredPackageReference } from "./packages.js";
import { generationCatalogue } from "./platform-generation.js";
import { programmeSourceSchema } from "./platform-binding.js";
import { readProgramme } from "./programme.js";
import { withProgrammeWrite } from "./programme-transaction.js";
import { projectPackages } from "./project-packages.js";
import { flowSchema, projectSchema } from "./schema.js";
import { providerReference } from "../plugins/authoring.js";

export const programmeFlowReviewSchema = z
  .object({
    programme: programmeSourceSchema,
    project: z.string().min(1).max(160),
    change: z.discriminatedUnion("action", [
      z
        .object({
          action: z.literal("create"),
          definition: flowEditorCreateSchema,
        })
        .strict(),
      z
        .object({
          action: z.literal("edit"),
          definition: flowEditorReviewSchema,
        })
        .strict(),
    ]),
  })
  .strict();
export const programmeFlowApplySchema = z
  .object({
    programme: programmeSourceSchema,
    review: z.unknown(),
  })
  .strict();
type Source = z.infer<typeof programmeSourceSchema>;
type Request = z.infer<typeof programmeFlowReviewSchema>;
type Item = {
  setting: string;
  label: string;
  selection: string;
  actual: string;
  expected: string[];
  status: "matches" | "conflict" | "unapplied";
  reason: string;
};
function context(root: string, programme: Source, planProject?: string) {
  const reader = new Configuration(root, {});
  const project = projectSchema.parse(reader.load());
  const saved = readProgramme(programme.root, programme.id).document;
  check(
    saved,
    "PROGRAMME",
    "Save the registered programme before reviewing shared preferences",
  );
  const selected = saved.projects.filter(
    (p) =>
      p.compilerId === project.id && (!planProject || p.id === planProject),
  );
  check(
    selected.length === 1,
    "PROGRAMME",
    "Select one registered compiler project in the authorised programme",
  );
  const platform = saved.platforms?.find(
    (p) => p.id === selected[0].platformId,
  );
  return {
    project,
    selected: selected[0],
    platform,
    sourceDigest: digest(canonical(saved)),
  };
}
function compare(root: string, state: ReturnType<typeof context>, flow: any) {
  const configuration = flow.provider ?? state.project.defaults.provider;
  if (!state.platform || !state.selected.targets?.length)
    return {
      flow: flow.id,
      target: "unassigned",
      provider: configuration ?? "",
      items: [] as Item[],
      blocked: false,
    };
  const configured =
    state.project.providers.configurations[configuration ?? ""];
  check(
    configured,
    "PROVIDER",
    "Select a configured provider before reviewing shared preferences",
  );
  const reference = configuredPackageReference(
    projectPackages(state.project)[configured.package],
  );
  const installed = providerReference(root, reference);
  const target = state.selected.targets?.some(
    (t) => t.provider === installed.manifest.platform,
  )
    ? state.platform?.configuration?.targets.find(
        (t) => t.provider === installed.manifest.platform,
      )
    : undefined;
  const items: Item[] = [];
  for (const setting of generationCatalogue[target?.provider ?? ""] ?? []) {
    const value = target?.generation?.[setting.id];
    if (!value) continue;
    const choice = setting.options.find((o) => o.id === value)!;
    if (
      flow.kind !== "ingestion" &&
      ["ingestion", "changes", "bronze"].includes(setting.id)
    )
      continue;
    const item: Item = {
      setting: setting.id,
      label: setting.label,
      selection: choice.label,
      actual: "",
      expected: [],
      status: "unapplied",
      reason:
        "No comparison adapter for this preference. Review the concrete definition separately; this review does not apply it.",
    };
    if (setting.id === "qualityFailure") {
      item.actual = state.project.defaults.quality?.unsupported ?? "block";
      item.expected = [value];
      item.status = item.actual === value ? "matches" : "conflict";
      item.reason =
        "Compares project defaults.quality.unsupported only; generation checks support for individual quality rules.";
    } else if (flow.kind === "ingestion" && choice.standards) {
      item.expected = choice.standards.filter((s) =>
        installed.manifest.standards?.some((d) => d.id === s),
      );
      item.actual =
        typeof flow.ingestion?.standard === "string"
          ? flow.ingestion.standard
          : "";
      if (item.expected.length && item.actual) {
        item.status = item.expected.includes(item.actual)
          ? "matches"
          : "conflict";
        item.reason =
          "Compares the concrete ingestion standard with exact standards declared by the installed provider. Source eligibility is checked during generation.";
      } else
        item.reason =
          "The installed provider or referenced definition does not supply an exact standard comparison. This preference remains unapplied.";
    }
    items.push(item);
  }
  for (const [setting, value] of Object.entries(target?.naming ?? {}))
    if (value)
      items.push({
        setting: `naming.${setting}`,
        label: `${setting} naming`,
        selection: value,
        actual: "",
        expected: [],
        status: "unapplied",
        reason:
          "Shared naming patterns are not automatically applied to flow definitions.",
      });
  return {
    flow: flow.id,
    target: installed.manifest.platform,
    provider: configuration,
    package: { reference, commit: installed.entry.commit },
    items,
    blocked: items.some((i) => i.status === "conflict"),
  };
}
export function reviewProgrammeFlow(
  root: string,
  environment: string,
  request: Request,
) {
  const state = context(root, request.programme, request.project);
  const change = request.change;
  const proposal =
    change.action === "create"
      ? createFlowEditor(root, environment, change.definition)
      : reviewFlowEditor(root, change.definition);
  let path: string, prefix: (string | number)[];
  if (change.action === "create") {
    path = `flows/${change.definition.id}/flow.yaml`;
    prefix = [];
  } else {
    const workspace = editableProject(root),
      location = workspace.selectFlow(change.definition.flow);
    path = relative(workspace.reader.root, location.file);
    prefix = location.prefix;
  }
  const file = proposal.changes.find((c) => c.path === path);
  const document = parseDocument(
    file?.after ?? readFileSync(new Configuration(root).path(path), "utf8"),
    { uniqueKeys: true },
  );
  check(
    !document.errors.length && !document.warnings.length,
    "YAML",
    "Invalid reviewed flow definition",
  );
  const raw = document.toJS({ maxAliasCount: 50 });
  const flow = flowSchema.parse(prefix.reduce((v, p) => v?.[p], raw));
  const preferences = compare(root, state, flow);
  return {
    apiVersion: "ingestron.programme-flow-review/v1",
    request,
    environment,
    sourceDigest: state.sourceDigest,
    preferences,
    proposal,
  };
}
export function applyProgrammeFlow(
  root: string,
  environment: string,
  args: z.infer<typeof programmeFlowApplySchema>,
) {
  const review = z
    .object({
      apiVersion: z.literal("ingestron.programme-flow-review/v1"),
      request: programmeFlowReviewSchema,
      environment: z.string(),
      sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .passthrough()
    .parse(args.review);
  check(
    canonical(args.programme) === canonical(review.request.programme) &&
      environment === review.environment,
    "PROPOSAL",
    "Flow review belongs to another programme or environment",
  );
  return withProgrammeWrite(args.programme.root, () => {
    check(
      context(root, args.programme, review.request.project).sourceDigest ===
        review.sourceDigest,
      "STALE",
      "Shared preferences changed after review; review the flow again",
    );
    const fresh = reviewProgrammeFlow(root, environment, review.request);
    check(
      canonical(fresh) === canonical(args.review),
      "STALE",
      "Flow review changed or was altered; review again",
    );
    check(
      !fresh.preferences.blocked,
      "PREFERENCE",
      "Resolve the shared preference conflicts in the flow or shared platform settings before saving",
    );
    return apply(root, fresh.proposal as Proposal);
  });
}
/** Only the authorised programme and actual selected build flows participate. */
export function verifyFlowPreferences(
  root: string,
  programme: Source | undefined,
  flows: any[],
) {
  if (!programme) return undefined;
  const state = context(root, programme);
  const reviews = flows.map((flow) => compare(root, state, flow));
  const conflicts = reviews.flatMap((r) =>
    r.items
      .filter((i) => i.status === "conflict")
      .map(
        (i) =>
          `${r.flow}: ${i.label} expects ${i.expected.join(" or ")}, selected ${i.actual}`,
      ),
  );
  check(
    !conflicts.length,
    "PREFERENCE",
    `Resolve shared preferences before generation: ${conflicts.join("; ")}`,
  );
  return reviews.some((r) => r.items.length)
    ? { sourceDigest: state.sourceDigest, flows: reviews }
    : undefined;
}
