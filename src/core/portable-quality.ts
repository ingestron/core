/** Portable quality authoring. No source access, target binding or evaluation. */
import { z } from "zod";
import {
  ingestionDefinitionSchema,
  type IngestionDefinition,
} from "./ingestion-definition-schema.js";
import {
  portableQualityRuleSchema,
  qualityBindingSchema,
  type PortableQualityRule,
} from "./portable-quality-schema.js";
import { canonical, check } from "./errors.js";
import { auditSecrets } from "./planner.js";
type ObjectDefinition = IngestionDefinition["objects"][number];
export type QualityIssue = { object: string; rule?: string; message: string };
export type EffectiveRule = {
  rule: Record<string, unknown>;
  origin: string;
  locked: boolean;
  active: boolean;
};
const portable = (r: Record<string, unknown>) =>
  r.apiVersion === "ingestron.quality-rule/v1";
export function logicalColumns(o: ObjectDefinition) {
  return new Map([
    ...o.mapping.map(
      (m) =>
        [
          m.output,
          m.logicalType ??
            o.fields.find((f) => f.path === m.source)?.logicalType ??
            "unknown",
        ] as const,
    ),
    ...o.metadata.map((m) => [m.name, m.logicalType] as const),
  ]);
}
export function effectiveQuality(
  d: IngestionDefinition,
  o: ObjectDefinition,
): EffectiveRule[] {
  const enabled = o.qualityEnabled ?? d.qualityDefaults?.enabled ?? true;
  const effective = new Map<string, EffectiveRule>();
  const add = (r: Record<string, unknown>, origin: string) => {
    const key = String(r.id ?? `${origin}:${effective.size}`);
    effective.set(key, {
      rule: r,
      origin,
      locked: !!r.required,
      active: enabled && r.enabled !== false,
    });
  };
  for (const r of d.qualityDefaults?.rules ?? []) add(r, "Ingestion default");
  for (const b of o.qualitySets ?? []) {
    const set = d.qualityRuleSets?.find(
      (s) => s.id === b.id && s.version === b.version,
    );
    for (const r of set?.rules ?? [])
      add(
        {
          ...r,
          id: `${b.id}:${r.id}`,
          fields: r.fields.map((f) => b.fields[f] ?? f),
        },
        `${set!.name} v${b.version}`,
      );
  }
  for (const r of o.quality) add(r, "Object override");
  return [...effective.values()];
}
function ruleIssues(
  r: PortableQualityRule,
  columns: Map<string, string> | undefined,
  d: IngestionDefinition,
  template = false,
): string[] {
  const errors: string[] = [],
    c = r.condition;
  if (new Set(r.fields).size !== r.fields.length)
    errors.push("Choose each logical field only once.");
  if (c.kind === "row-count" ? r.fields.length !== 0 : !r.fields.length)
    errors.push(
      c.kind === "row-count"
        ? "Row count applies to the whole object; remove field selections."
        : "Choose at least one logical output field.",
    );
  if (
    !["uniqueness", "relationship", "not-null", "row-count"].includes(c.kind) &&
    r.fields.length !== 1
  )
    errors.push("This condition requires exactly one logical output field.");
  for (const f of r.fields) {
    if (!columns) continue;
    const t = columns.get(f);
    if (!t) {
      errors.push(`Logical output '${f}' does not exist.`);
      continue;
    }
    const supported =
      c.kind === "range"
        ? ["integer", "number", "decimal"]
        : ["pattern", "length"].includes(c.kind)
          ? ["string"]
          : c.kind === "freshness"
            ? ["date", "timestamp"]
            : ["uniqueness", "relationship", "allowed-values"].includes(c.kind)
              ? [
                  "integer",
                  "number",
                  "decimal",
                  "string",
                  "boolean",
                  "date",
                  "timestamp",
                ]
              : undefined;
    if (supported && !supported.includes(t))
      errors.push(`'${f}' has incompatible type '${t}' for ${c.kind}.`);
    if (
      c.kind === "allowed-values" &&
      c.values.some(
        (v) =>
          typeof v !==
            (["integer", "number", "decimal"].includes(t)
              ? "number"
              : t === "boolean"
                ? "boolean"
                : "string") ||
          (t === "integer" && !Number.isInteger(v)),
      )
    )
      errors.push(`Allowed values must match the logical type of '${f}'.`);
  }
  if ("min" in c && c.min > c.max)
    errors.push("Minimum must not exceed maximum.");
  // Deliberately small, bounded ASCII regex dialect. Never execute user expressions here.
  if (c.kind === "pattern") {
    if (
      /[^\x20-\x7e]/.test(c.expression) ||
      /[()|]/.test(c.expression) ||
      /\\[1-9pPkK]/.test(c.expression) ||
      /(?:[+*?]|\{[\d,]+\})\s*(?:[+*?]|\{)/.test(c.expression)
    )
      errors.push(
        "Use the portable ASCII pattern dialect: no groups, alternation, backreferences or stacked quantifiers.",
      );
    try {
      new RegExp(c.expression);
    } catch {
      errors.push("Pattern is not a valid portable expression.");
    }
  }
  if (c.kind === "not-null" && r.nullHandling !== "fail")
    errors.push("Not-null rules must fail null values.");
  if (
    c.kind === "row-count" &&
    !["report-only", "reject-object"].includes(r.failureIntent)
  )
    errors.push(
      "Aggregate row-count failures can only report or reject the object.",
    );
  if (r.required && !r.enabled)
    errors.push(`Required by ${r.required.policy}: ${r.required.reason}`);
  if (
    c.kind === "relationship" &&
    (c.fields.length !== r.fields.length ||
      new Set(c.fields).size !== c.fields.length)
  )
    errors.push("Relationship keys must have matching, distinct components.");
  if (c.kind === "relationship" && !template) {
    const target = d.objects.find((o) => o.id === c.object);
    if (!target)
      errors.push("Referenced object is not selected in this ingestion.");
    else {
      const targetFields = logicalColumns(target);
      c.fields.forEach((f, i) => {
        if (
          !targetFields.has(f) ||
          targetFields.get(f) !== columns?.get(r.fields[i]!)
        )
          errors.push(
            `Relationship field '${f}' is missing or has a different logical type.`,
          );
      });
    }
  }
  return errors;
}
export function validatePortableQuality(
  d: IngestionDefinition,
  onlyObject?: string,
) {
  const issues: QualityIssue[] = [],
    warnings: QualityIssue[] = [];
  const issue = (object: string, message: string, rule?: string) =>
    issues.push({ object, ...(rule ? { rule } : {}), message });
  const sets = d.qualityRuleSets ?? [],
    keys = new Set<string>();
  for (const s of sets) {
    const key = `${s.id}@${s.version}`;
    if (keys.has(key)) issue("Rule sets", `Duplicate rule-set version ${key}.`);
    keys.add(key);
    if (new Set(s.fields.map((f) => f.name)).size !== s.fields.length)
      issue("Rule sets", `Duplicate field slots in ${key}.`);
    const ids = new Set<string>();
    for (const r of s.rules) {
      if (ids.has(r.id))
        issue("Rule sets", `Duplicate rule identity in ${key}.`, r.id);
      ids.add(r.id);
      for (const message of ruleIssues(
        r,
        new Map(s.fields.map((f) => [f.name, f.logicalType])),
        d,
        true,
      ))
        issue("Rule sets", `${key}: ${message}`, r.id);
    }
  }
  const ruleSetsValid = issues.length === 0;
  const defaultIds = new Set<string>();
  for (const r of d.qualityDefaults?.rules ?? []) {
    if (defaultIds.has(r.id))
      issue("Defaults", "Duplicate default rule identity.", r.id);
    defaultIds.add(r.id);
    // Check condition semantics even before object selection or when every object overrides a default.
    for (const message of ruleIssues(r, undefined, d, true))
      issue("Defaults", message, r.id);
    if (r.required && (!r.enabled || d.qualityDefaults?.enabled === false))
      issue("Defaults", "Required quality cannot be disabled.", r.id);
  }
  for (const o of d.objects.filter((o) => !onlyObject || o.id === onlyObject)) {
    const columns = logicalColumns(o),
      ids = new Set<string>();
    for (const r of o.quality) {
      if (r.id && ids.has(String(r.id)))
        issue(o.id, "Duplicate rule identity.", String(r.id));
      ids.add(String(r.id));
      if (typeof r.id === "string" && r.id.includes(":"))
        issue(o.id, "Local rule IDs cannot shadow a rule-set binding.", r.id);
      const inherited = d.qualityDefaults?.rules.find((v) => v.id === r.id);
      if (inherited?.required && canonical(r) !== canonical(inherited))
        issue(
          o.id,
          "A mandatory inherited rule cannot be overridden.",
          String(r.id),
        );
    }
    const bindings = new Set<string>();
    for (const b of o.qualitySets ?? []) {
      if (bindings.has(b.id))
        issue(o.id, `Choose only one pinned version of ${b.id}.`);
      bindings.add(b.id);
      const s = sets.find((s) => s.id === b.id && s.version === b.version);
      if (!s) {
        issue(o.id, `Missing pinned rule set ${b.id} v${b.version}.`);
        continue;
      }
      if (
        Object.keys(b.fields).some(
          (f) => !s.fields.some((slot) => slot.name === f),
        )
      )
        issue(o.id, `Unknown field slot for ${b.id}.`);
      for (const f of s.fields)
        if (
          !b.fields[f.name] ||
          columns.get(b.fields[f.name]!) !== f.logicalType
        )
          issue(
            o.id,
            `Map ${b.id}.${f.name} to an existing ${f.logicalType} output.`,
          );
    }
    for (const e of effectiveQuality(d, o)) {
      if (e.locked && !e.active)
        issue(o.id, "Required quality cannot be disabled.", String(e.rule.id));
      if (!portable(e.rule)) {
        warnings.push({
          object: o.id,
          rule: String(e.rule.id ?? "Custom rule"),
          message:
            "Unsupported/custom rule retained unchanged; its semantics and target support are not validated.",
        });
        continue;
      }
      const parsed = portableQualityRuleSchema.safeParse({
        ...e.rule,
        id: String(e.rule.id).split(":").at(-1),
      });
      if (!parsed.success) {
        issue(
          o.id,
          parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
          String(e.rule.id),
        );
        continue;
      }
      for (const message of ruleIssues(parsed.data, columns, d))
        issue(o.id, message, String(e.rule.id));
    }
  }
  return {
    valid: issues.length === 0,
    ruleSetsValid,
    issues,
    warnings,
    scope: "portable-definition-only",
    evaluation: "not-run",
    platformSupport: "not-checked",
  };
}
/** Prevent alternate API clients and bulk edits from weakening persisted locks or changing pinned versions. */
export function protectQuality(
  previous: IngestionDefinition | undefined,
  next: IngestionDefinition,
) {
  if (!previous) return;
  for (const s of previous.qualityRuleSets ?? []) {
    const n = next.qualityRuleSets?.find(
      (n) => n.id === s.id && n.version === s.version,
    );
    check(
      n && canonical(n) === canonical(s),
      "QUALITY",
      "Saved rule-set versions are immutable. Create a new version.",
    );
  }
  for (const r of previous.qualityDefaults?.rules ?? [])
    if (r.required)
      check(
        next.qualityDefaults?.enabled !== false &&
          next.qualityDefaults?.rules.some(
            (n) => canonical(n) === canonical(r),
          ),
        "QUALITY",
        "Mandatory ingestion defaults cannot be removed or changed.",
      );
  for (const o of previous.objects) {
    const n = next.objects.find((n) => n.id === o.id);
    if (!n) continue; // Removing an object is an explicit ingestion scope change.
    const rules = effectiveQuality(next, n);
    for (const r of effectiveQuality(previous, o).filter((r) => r.locked))
      check(
        rules.some(
          (n) =>
            n.active && n.locked && canonical(n.rule) === canonical(r.rule),
        ),
        "QUALITY",
        "Mandatory object rules cannot be removed, disabled or changed.",
      );
  }
}
const selection = z.array(z.string().min(1).max(1024)).min(1).max(10000);
export const ingestionQualityPreviewSchema = z
  .object({
    definition: ingestionDefinitionSchema,
    object: z.string().min(1).max(1024).optional(),
    bulk: z
      .object({
        objects: selection,
        mode: z.enum(["preserve", "replace"]),
        setting: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("quality-enabled"),
              enabled: z.boolean(),
            })
            .strict(),
          z
            .object({
              kind: z.literal("rule-set"),
              binding: qualityBindingSchema,
            })
            .strict(),
          z
            .object({
              kind: z.literal("governance"),
              field: z.enum(["owner", "classification"]),
              value: z.string().min(1).max(1024),
            })
            .strict(),
          z
            .object({
              kind: z.literal("metadata"),
              column: ingestionDefinitionSchema.shape.objects
                .unwrap()
                .element.shape.metadata.unwrap().element,
            })
            .strict(),
          z
            .object({
              kind: z.literal("masking"),
              field: z.string().min(1).max(1024),
              policy: z.string().min(1).max(1024),
              enabled: z.boolean(),
            })
            .strict(),
        ]),
      })
      .strict()
      .optional(),
  })
  .strict();
export function previewPortableQuality(
  input: z.infer<typeof ingestionQualityPreviewSchema>,
) {
  check(
    Buffer.byteLength(JSON.stringify(input)) <= 8 * 1024 * 1024,
    "LIMIT",
    "Quality authoring input exceeds 8 MiB",
  );
  auditSecrets(input.definition, "definition");
  const d = structuredClone(input.definition),
    outcomes: {
      object: string;
      status: "applied" | "preserved" | "skipped";
      reason: string;
    }[] = [];
  const bulk = input.bulk;
  if (bulk) {
    check(
      new Set(bulk.objects).size === bulk.objects.length,
      "DUPLICATE",
      "Bulk selection contains duplicate identities",
    );
    const selected = new Set(bulk.objects);
    check(
      bulk.objects.every((id) => d.objects.some((o) => o.id === id)),
      "REFERENCE",
      "Bulk selection includes an unknown object",
    );
    for (let index = 0; index < d.objects.length; index++) {
      const o = d.objects[index]!;
      if (!selected.has(o.id)) continue;
      const n = structuredClone(o),
        s = bulk.setting;
      let override = false;
      if (s.kind === "quality-enabled") {
        override = o.qualityEnabled !== undefined;
        n.qualityEnabled = s.enabled;
      }
      if (s.kind === "rule-set") {
        override = !!o.qualitySets?.some((b) => b.id === s.binding.id);
        n.qualitySets = [
          ...(o.qualitySets ?? []).filter((b) => b.id !== s.binding.id),
          s.binding,
        ];
      }
      if (s.kind === "governance") {
        override = !!o.governance?.[s.field];
        n.governance = {
          ...o.governance,
          masking: o.governance?.masking ?? [],
          [s.field]: s.value,
        };
      }
      if (s.kind === "metadata") {
        override = o.metadata.some((m) => m.name === s.column.name);
        n.metadata = [
          ...o.metadata.filter((m) => m.name !== s.column.name),
          s.column,
        ];
      }
      if (s.kind === "masking") {
        override = !!o.governance?.masking.some((m) => m.field === s.field);
        n.governance = {
          ...o.governance,
          masking: [
            ...(o.governance?.masking ?? []).filter((m) => m.field !== s.field),
            { field: s.field, policy: s.policy, enabled: s.enabled },
          ],
        };
      }
      if (override && bulk.mode === "preserve") {
        outcomes.push({
          object: o.id,
          status: "preserved",
          reason: "Existing object override retained.",
        });
        continue;
      }
      const candidate = {
        ...d,
        objects: [n, ...d.objects.filter((o) => o.id !== n.id)],
      };
      let reason = "";
      try {
        protectQuality({ ...d, objects: [o] }, candidate);
        const oldMasks = o.governance?.masking.filter((m) => m.required) ?? [];
        check(
          oldMasks.every((m) =>
            n.governance?.masking.some((v) => canonical(v) === canonical(m)),
          ),
          "QUALITY",
          "Required masking cannot be changed.",
        );
        check(
          n.metadata.every(
            (m) =>
              m.logicalType ===
              (m.value.kind === "observed-at" ? "timestamp" : "string"),
          ),
          "REFERENCE",
          "Metadata type does not match value.",
        );
        const outputs = [
          ...n.mapping.map((m) => m.output),
          ...n.metadata.map((m) => m.name),
        ];
        check(
          new Set(outputs).size === outputs.length,
          "REFERENCE",
          "Output name already exists.",
        );
        check(
          !n.metadata.some(
            (m) => m.value.kind === "source-path" && n.kind !== "file-group",
          ),
          "REFERENCE",
          "Source-path metadata requires a file group.",
        );
        check(
          (n.governance?.masking ?? []).every((m) =>
            n.fields.some((f) => f.path === m.field),
          ),
          "REFERENCE",
          "Masked source field does not exist.",
        );
        reason = validatePortableQuality(candidate, o.id)
          .issues.filter((i) => i.object === o.id || i.object === "Rule sets")
          .map((i) => i.message)
          .join(" ");
      } catch (e) {
        reason = (e as Error).message;
      }
      if (reason) outcomes.push({ object: o.id, status: "skipped", reason });
      else {
        d.objects[index] = n;
        outcomes.push({
          object: o.id,
          status: canonical(o) === canonical(n) ? "preserved" : "applied",
          reason:
            canonical(o) === canonical(n)
              ? "Already configured."
              : "Compatible; staged only after confirmation.",
        });
      }
    }
  }
  const report = validatePortableQuality(d);
  return {
    apiVersion: "ingestron.quality-preview/v1",
    ...report,
    ...(bulk ? { definition: d, outcomes } : {}),
    ...(input.object
      ? {
          effective: effectiveQuality(
            d,
            d.objects.find((o) => o.id === input.object) ?? {
              id: input.object,
              kind: "unknown",
              fields: [],
              mapping: [],
              metadata: [],
              quality: [],
            },
          ),
        }
      : {}),
  };
}
