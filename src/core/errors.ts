import { createHash } from "node:crypto";
export class Problem extends Error {
  constructor(
    public code: string,
    message: string,
    public file?: string,
    public pointer?: string,
    public hint?: string,
  ) {
    super(message);
    this.name = "Problem";
  }
}
export function check(
  condition: unknown,
  code: string,
  message: string,
  file?: string,
): asserts condition {
  if (!condition) throw new Problem(code, message, file);
}
export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const canonical = (value: any): string => JSON.stringify(sort(value));
function sort(value: any): any {
  return Array.isArray(value)
    ? value.map(sort)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, sort(value[k])]),
        )
      : value;
}
export const isMap = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function merge(a: any, b: any): any {
  if (!isMap(a) || !isMap(b)) return structuredClone(b);
  const result = structuredClone(a);
  for (const [key, value] of Object.entries(b)) {
    check(
      !["__proto__", "prototype", "constructor"].includes(key),
      "KEY",
      "Unsafe mapping key",
    );
    result[key] = Object.hasOwn(result, key)
      ? merge(result[key], value)
      : structuredClone(value);
  }
  return result;
}
