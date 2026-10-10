/** Allowlisted metadata and measured counts only, never arbitrary runtime output. */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { fence } from "./packages.js";
import { check, digest } from "./errors.js";
const name = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.:\/-]{0,159}$/);
const metric = z.enum([
  "nullValues",
  "missingValues",
  "invalidValues",
  "duplicateValues",
  "rowCount",
]);
const measurement = z.object({
  id: name,
  stream: name,
  metric,
  value: z.number().finite().nonnegative(),
  passed: z.boolean(),
  outcome: z.enum(["pass", "fail", "warn"]).optional(),
});
export function deliveryResults(record: any) {
  const flows = Array.isArray(record.result?.flows)
    ? record.result.flows.slice(0, 100)
    : [];
  const quality = (
    Array.isArray(record.quality)
      ? record.quality
      : flows.flatMap((f: any) =>
          Array.isArray(f.quality) ? f.quality.slice(0, 20) : [],
        )
  )
    .slice(0, 20)
    .flatMap((r: any) => {
      const p = measurement.safeParse(r);
      return p.success ? [p.data] : [];
    });
  const table = z.object({
    stream: name,
    rows: z.number().int().nonnegative().safe(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  });
  const outputs = flows
    .flatMap((f: any) =>
      (Array.isArray(f.tables) ? f.tables.slice(0, 20) : []).flatMap(
        (r: any) => {
          const p = table.safeParse(r);
          return p.success && name.safeParse(f.flow).success
            ? [{ flow: f.flow as string, ...p.data }]
            : [];
        },
      ),
    )
    .slice(0, 20);
  return { quality, outputs };
}
export function deliveryMapping(root: string, flow: string) {
  const file = fence(root, `flows/${flow}/review.json`);
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  check(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8 * 1024 * 1024,
    "LIMIT",
    "Mapping review exceeds supported bounds",
  );
  const bytes = readFileSync(file),
    raw = JSON.parse(bytes.toString("utf8"));
  const shape = z.object({
    type: z.enum([
      "string",
      "integer",
      "number",
      "boolean",
      "json",
      "date",
      "timestamp",
      "decimal",
    ]),
    nullable: z.boolean(),
    target: name.optional(),
    precision: z.number().int().min(1).max(38).optional(),
    scale: z.number().int().min(0).max(38).optional(),
  });
  check(
    raw.status === "draft" || raw.status === "approved",
    "REVIEW",
    "Unsupported mapping status",
  );
  check(
    raw.selection &&
      typeof raw.selection === "object" &&
      !Array.isArray(raw.selection),
    "REVIEW",
    "Missing mapping selection",
  );
  const entries = Object.entries(raw.selection);
  check(
    entries.length > 0 && entries.length <= 100,
    "LIMIT",
    "Mapping selection exceeds 100 tables",
  );
  let total = 0;
  const tables = entries.map(([source, value]: [string, any]) => {
    name.parse(source);
    const target = name.parse(value?.name);
    check(
      value.fields &&
        typeof value.fields === "object" &&
        !Array.isArray(value.fields),
      "REVIEW",
      "Missing mapping fields",
    );
    const fields = Object.entries(value.fields);
    check(
      fields.length > 0 &&
        fields.length <= 500 &&
        (total += fields.length) <= 10000,
      "LIMIT",
      "Mapping exceeds field limits",
    );
    return {
      source,
      target,
      fields: fields.map(([sourceField, v]) => ({
        source: name.parse(sourceField),
        ...shape.parse(v),
      })),
    };
  });
  return {
    status: raw.status as "draft" | "approved",
    digest: digest(bytes),
    tables,
  };
}
