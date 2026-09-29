/** ODCS v3.1.0 quality rules and provider enforcement coverage (PB-063). */
import { check } from "./errors.js";

export const libraryMetrics = [
  "nullValues",
  "missingValues",
  "invalidValues",
  "duplicateValues",
  "rowCount",
] as const;
export const enforcementModes = [
  "at-load",
  "after-load",
  "unsupported",
] as const;
export type EnforcementMode = (typeof enforcementModes)[number];
const operators = [
  "mustBe",
  "mustNotBe",
  "mustBeGreaterThan",
  "mustBeGreaterOrEqualTo",
  "mustBeLessThan",
  "mustBeLessOrEqualTo",
  "mustBeBetween",
  "mustNotBeBetween",
];

export interface QualityRule {
  id: string;
  contract: string;
  table: string;
  column?: string;
  type: "library" | "sql" | "custom" | "text";
  metric?: string;
  engine?: string;
  operator?: string;
  threshold?: unknown;
  arguments?: Record<string, unknown>;
  /** ODCS severity `error` fails the load; anything else warns. */
  outcome: "fail" | "warn";
  source: "contract" | "primary-key";
}

export interface ProviderQuality {
  library: Partial<Record<(typeof libraryMetrics)[number], EnforcementMode>>;
  sql: EnforcementMode;
  engines: string[];
}

function parseRule(
  rule: any,
  base: { contract: string; table: string; column?: string },
  file?: string,
): QualityRule {
  check(
    rule && typeof rule === "object",
    "QUALITY",
    "Invalid quality rule",
    file,
  );
  const type = rule.type ?? "library";
  check(
    ["library", "sql", "custom", "text"].includes(type),
    "QUALITY",
    `Unsupported quality rule type ${type}`,
    file,
  );
  const where = `${base.table}${base.column ? "." + base.column : ""}`;
  const present = operators.filter((o) => rule[o] !== undefined);
  if (type === "library") {
    check(
      libraryMetrics.includes(rule.metric),
      "QUALITY",
      `${where}: unsupported library metric ${rule.metric}; use ${libraryMetrics.join(", ")}`,
      file,
    );
    check(
      rule.metric !== "invalidValues" ||
        Array.isArray(rule.arguments?.validValues) ||
        typeof rule.arguments?.pattern === "string",
      "QUALITY",
      `${where}: invalidValues needs arguments.validValues or arguments.pattern`,
      file,
    );
  }
  if (type === "library" || type === "sql")
    check(
      present.length === 1,
      "QUALITY",
      `${where}: a ${type} rule needs exactly one comparison (${operators.join(", ")})`,
      file,
    );
  if (type === "sql")
    check(
      typeof rule.query === "string" && rule.query.trim().length > 0,
      "QUALITY",
      `${where}: a sql rule needs a query`,
      file,
    );
  if (type === "custom")
    check(
      typeof rule.engine === "string" && rule.engine.length > 0,
      "QUALITY",
      `${where}: a custom rule needs an engine`,
      file,
    );
  const operator = present[0];
  return {
    id: String(rule.id ?? `${where}.${rule.metric ?? rule.engine ?? type}`),
    ...base,
    type,
    ...(rule.metric ? { metric: rule.metric } : {}),
    ...(rule.engine ? { engine: rule.engine } : {}),
    ...(operator ? { operator, threshold: rule[operator] } : {}),
    ...(rule.arguments ? { arguments: rule.arguments } : {}),
    outcome: /^error$/i.test(String(rule.severity ?? "")) ? "fail" : "warn",
    source: "contract",
  };
}

/** Explicit contract rules, plus key rules implied by `primaryKey: true`. */
export function contractRules(
  contract: Record<string, any>,
  file?: string,
): QualityRule[] {
  const name = String(contract.id ?? contract.name ?? "unnamed");
  const rules: QualityRule[] = [];
  for (const rule of Array.isArray(contract.quality) ? contract.quality : [])
    rules.push(parseRule(rule, { contract: name, table: "*" }, file));
  for (const object of Array.isArray(contract.schema) ? contract.schema : []) {
    const table = String(object?.name ?? "table");
    for (const rule of Array.isArray(object?.quality) ? object.quality : [])
      rules.push(parseRule(rule, { contract: name, table }, file));
    const keys: string[] = [];
    for (const p of Array.isArray(object?.properties)
      ? object.properties
      : []) {
      const column = String(p?.name);
      for (const rule of Array.isArray(p?.quality) ? p.quality : [])
        rules.push(parseRule(rule, { contract: name, table, column }, file));
      if (p?.primaryKey === true) keys.push(column);
    }
    for (const column of keys)
      if (
        !rules.some(
          (r) =>
            r.table === table &&
            r.column === column &&
            r.metric === "nullValues",
        )
      )
        rules.push({
          id: `${table}.${column}.key-not-null`,
          contract: name,
          table,
          column,
          type: "library",
          metric: "nullValues",
          operator: "mustBe",
          threshold: 0,
          outcome: "fail",
          source: "primary-key",
        });
    if (
      keys.length &&
      !rules.some(
        (r) => r.table === table && !r.column && r.metric === "duplicateValues",
      )
    )
      rules.push({
        id: `${table}.key-unique`,
        contract: name,
        table,
        type: "library",
        metric: "duplicateValues",
        operator: "mustBe",
        threshold: 0,
        arguments: { properties: keys },
        outcome: "fail",
        source: "primary-key",
      });
  }
  return rules;
}

export function enforcementMode(
  rule: QualityRule,
  quality?: ProviderQuality,
): EnforcementMode | "documentation" {
  if (rule.type === "text") return "documentation";
  if (!quality) return "unsupported";
  if (rule.type === "library")
    return (
      quality.library[rule.metric as (typeof libraryMetrics)[number]] ??
      "unsupported"
    );
  if (rule.type === "sql") return quality.sql;
  return quality.engines.includes(rule.engine!) ? "after-load" : "unsupported";
}

export interface CoverageEntry extends QualityRule {
  flow: string;
  configuration: string;
  platform: string;
  mode: EnforcementMode | "documentation";
}

export function flowCoverage(
  flow: { id: string; tables?: Record<string, any> },
  target: {
    configuration: string;
    platform: string;
    quality?: ProviderQuality;
  },
): CoverageEntry[] {
  const seen = new Set<string>();
  const entries: CoverageEntry[] = [];
  for (const table of Object.values(flow.tables ?? {})) {
    const contract = table?.contract;
    if (!contract || typeof contract !== "object") continue;
    for (const rule of contractRules(contract)) {
      const key = `${rule.contract}:${rule.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        ...rule,
        flow: flow.id,
        configuration: target.configuration,
        platform: target.platform,
        mode: enforcementMode(rule, target.quality),
      });
    }
  }
  return entries;
}

/** Explicit error-severity rules must be enforceable unless the project accepts reporting. */
export function checkCoverage(
  entries: CoverageEntry[],
  policy: "block" | "report" = "block",
): void {
  if (policy === "report") return;
  const blocked = entries.filter(
    (e) =>
      e.source === "contract" &&
      e.outcome === "fail" &&
      e.mode === "unsupported",
  );
  check(
    !blocked.length,
    "QUALITY",
    `${blocked.length} error-severity quality rule(s) cannot be enforced: ${blocked
      .slice(0, 5)
      .map((e) => `${e.contract}/${e.id} on ${e.configuration} (${e.platform})`)
      .join(
        "; ",
      )}. Choose a provider that enforces them, lower their severity, or set defaults.quality.unsupported: report`,
  );
}

export function coverageSummary(entries: CoverageEntry[]) {
  const count = (mode: string) => entries.filter((e) => e.mode === mode).length;
  return {
    rules: entries.length,
    atLoad: count("at-load"),
    afterLoad: count("after-load"),
    unsupported: count("unsupported"),
    documentation: count("documentation"),
  };
}
