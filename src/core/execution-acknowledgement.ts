/** Provider-owned evidence of an original setup operation; never replay work. */
import { z } from "zod";
import { check, canonical } from "./errors.js";
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const action = z.enum([
  "prepare",
  "catalogue",
  "discover",
  "review",
  "approve",
  "checkpoint_preview",
  "checkpoint_apply",
]);
export const checkpointFailureCodes = [
  "CHECKPOINT_MIGRATION",
  "CHECKPOINT_MIGRATION_STALE",
  "CHECKPOINT_POLICY",
  "CHECKPOINT_HISTORY",
  "CHECKPOINT_LIMIT",
  "CHECKPOINT_CURSOR",
  "CHECKPOINT_MISSING",
  "OUTPUT_BUSY",
] as const;
export const executionFailureCodes = [
  ...checkpointFailureCodes,
  "SOURCE_METADATA_LIMIT",
  "SOURCE_METADATA_COLLECTION_LIMIT",
] as const;
const acknowledgement = z
  .object({
    apiVersion: z.literal("ingestron.execution-acknowledgement/v1"),
    id: identity,
    action,
    flows: z.array(identity).min(1).max(100),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    result: z
      .object({
        apiVersion: z.literal("ingestron.execution-result/v1"),
        status: z.enum(["succeeded", "failed"]),
        action,
        flows: z.array(z.record(z.string(), z.unknown())).max(100),
        errorCode: z.enum(executionFailureCodes).optional(),
      })
      .strict(),
  })
  .strict();
export function validateOperationAcknowledgement(
  value: any,
  original: {
    id: string;
    action: string;
    flows: string[];
    fingerprint: string;
  },
) {
  const parsed = acknowledgement.safeParse(value?.acknowledgement);
  check(
    parsed.success,
    "EXECUTION_UNCERTAIN",
    "Provider did not acknowledge the original operation; its build ownership is retained",
  );
  const ack = parsed.data!;
  check(
    (!ack.result.errorCode || ack.result.status === "failed") &&
      ack.id === original.id &&
      ack.action === original.action &&
      ack.result.action === original.action &&
      ack.fingerprint === original.fingerprint &&
      canonical(ack.flows) === canonical(original.flows) &&
      (ack.result.status === "failed" ||
        canonical(ack.result.flows.map((flow) => flow.flow)) ===
          canonical(original.flows)),
    "EXECUTION_UNCERTAIN",
    "Provider acknowledgement differs from the original operation; its build ownership is retained",
  );
  return ack.result;
}
