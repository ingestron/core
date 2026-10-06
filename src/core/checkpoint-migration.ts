import { validateRetainedBuild } from "./build-retention.js";
/** Host scope and bounded evidence only; checkpoint semantics belong to the source. */
import { readFileSync, lstatSync } from "node:fs";
import { relative } from "node:path";
import { z } from "zod";
import { check, canonical } from "./errors.js";
import { fence, resolvePackage } from "./packages.js";
import { validateOutput } from "./generate.js";
import { ExecutionUncertainFailure } from "./execution-outcome.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const cursor = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
export const checkpointMigrationSchema = z
  .object({
    apiVersion: z.literal("ingestron.checkpoint-migration-preview/v1"),
    strategy: z.literal("preserve-cursor-runtime-upgrade"),
    digest: hash,
    applied: z.boolean(),
    namespace: hash,
    fromBinding: hash,
    toBinding: hash,
    policyDigest: hash,
    head: z
      .object({
        sequence: z.number().int().min(1).max(10000),
        receiptSha256: hash,
        bookmarks: z
          .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,100}$/), cursor)
          .refine(
            (value) =>
              Object.keys(value).length >= 1 &&
              Object.keys(value).length <= 100,
          ),
      })
      .strict(),
  })
  .strict();

function metadata(file: string) {
  check(
    lstatSync(file).isFile() && lstatSync(file).size <= 2_000_000,
    "LIMIT",
    "Build metadata exceeds checkpoint review limits",
  );
  return JSON.parse(readFileSync(file, "utf8"));
}
export function checkpointMigrationBoundary(
  root: string,
  current: any,
  args: any,
  original?: any,
) {
  const requested = original?.checkpointMigration ?? args;
  check(
    typeof requested.previous === "string",
    "SELECT",
    "Select the retained previous managed build for checkpoint review",
  );
  const directory = fence(root, requested.previous);
  const overlap = (a: string, b: string) =>
    !relative(a, b).startsWith("..") && !relative(a, b).startsWith("/");
  check(
    directory !== current.directory &&
      !overlap(directory, current.directory) &&
      !overlap(current.directory, directory),
    "SELECT",
    "Current and previous build directories must be separate",
  );
  check(
    current.flows.length === 1,
    "SELECT",
    "Checkpoint migration requires exactly one flow",
  );
  const verified = validateOutput(directory);
  check(
    verified.ownership === "managed",
    "OWNERSHIP",
    "Retain an unchanged managed previous build for checkpoint review",
  );
  const retentionDigest = validateRetainedBuild(directory);
  const build = metadata(fence(directory, "ingestron-project.json"));
  check(
    build.apiVersion === "ingestron.project-build/v1" &&
      build.project === current.build.project &&
      build.environment === current.build.environment &&
      canonical(build.selection?.profile ?? "") ===
        canonical(current.build.selection?.profile ?? ""),
    "SELECT",
    "Previous build belongs to another project, environment or profile",
  );
  const packages = build.packages.filter(
    (pkg: any) =>
      pkg.configuration === current.pkg.configuration &&
      pkg.scope.flows.includes(current.flows[0]),
  );
  check(
    packages.length === 1,
    "SELECT",
    "Previous build must contain the same provider configuration and flow",
  );
  const pkg = packages[0];
  check(
    resolvePackage(root, pkg.reference).entry.commit === pkg.commit,
    "STALE",
    "The retained previous provider package changed",
  );
  const packageRoot =
    pkg.directory === "."
      ? directory
      : fence(directory, pkg.directory.replace(/\/$/, ""));
  const request = {
    previous: relative(root, directory),
    baselineDigest: verified.planDigest,
    ...(retentionDigest ? { retentionDigest } : {}),
    ...(requested.expectedDigest
      ? { expectedDigest: requested.expectedDigest }
      : {}),
  };
  check(
    !original ||
      (original.checkpointMigration?.baselineDigest ===
        request.baselineDigest &&
        original.checkpointMigration?.retentionDigest === retentionDigest),
    "STALE",
    "Retained previous build changed after the original checkpoint operation",
  );
  return { directory, packageRoot, request };
}

export function checkpointMigrationEvidence(
  result: any,
  action: string,
  flows: string[],
  expectedDigest?: string,
) {
  const object = (value: any) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (
    !["checkpoint_preview", "checkpoint_apply"].includes(action) ||
    !Array.isArray(flows) ||
    flows.length !== 1 ||
    typeof flows[0] !== "string" ||
    flows[0].length === 0 ||
    !object(result) ||
    Object.keys(result).some(
      (key) => !["apiVersion", "status", "action", "flows"].includes(key),
    ) ||
    result.apiVersion !== "ingestron.execution-result/v1" ||
    result.status !== "succeeded" ||
    result.action !== action ||
    !Array.isArray(result.flows) ||
    result.flows.length !== 1 ||
    !object(result.flows[0]) ||
    result.flows[0].flow !== flows[0] ||
    result.flows[0].status !== "Succeeded" ||
    Object.keys(result.flows[0]).some(
      (key) => !["flow", "status", "migration"].includes(key),
    )
  )
    throw new ExecutionUncertainFailure();
  const parsed = checkpointMigrationSchema.safeParse(result.flows[0].migration);
  if (
    !parsed.success ||
    (action === "checkpoint_apply" && !parsed.data.applied) ||
    parsed.data.fromBinding === parsed.data.toBinding ||
    (expectedDigest && parsed.data.digest !== expectedDigest)
  )
    throw new ExecutionUncertainFailure();
  return {
    apiVersion: "ingestron.execution-result/v1",
    status: "succeeded",
    action,
    flows: [
      {
        flow: flows[0],
        status: result.flows[0].status,
        migration: parsed.data,
      },
    ],
  };
}
