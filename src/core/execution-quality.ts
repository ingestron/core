import { Problem } from "./errors.js";

const metrics = new Set([
  "nullValues",
  "missingValues",
  "invalidValues",
  "duplicateValues",
  "rowCount",
]);
/** Provider failures may carry rule identities and counts, never arbitrary source output. */
export function qualityFailureEvidence(value: unknown) {
  return (Array.isArray(value) ? value.slice(0, 20) : [])
    .filter(
      (r: any) =>
        r &&
        typeof r === "object" &&
        [r.id, r.stream].every(
          (v) => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(v),
        ) &&
        metrics.has(r.metric) &&
        typeof r.value === "number" &&
        Number.isFinite(r.value) &&
        r.value >= 0,
    )
    .map((r: any) => ({
      id: r.id as string,
      stream: r.stream as string,
      metric: r.metric as string,
      value: r.value as number,
      passed: false,
      outcome: "fail",
    }));
}
export class ExecutionQualityFailure extends Problem {
  constructor(public quality: ReturnType<typeof qualityFailureEvidence>) {
    super(
      "QUALITY_FAILED",
      "Contract quality rules failed; no output was committed. Inspect measured rule counts and correct the data or reviewed rules",
    );
  }
}
