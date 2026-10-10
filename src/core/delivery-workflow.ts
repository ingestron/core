/** Reviewed local execution and bounded evidence; no cloud deployment or background worker. */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { inspectProject } from "./planner.js";
import { projectPackages } from "./project-packages.js";
import {
  configuredPackageReference,
  fence,
  resolvePackage,
  packageYaml,
  providerPackageSchema,
} from "./packages.js";
import { executionBoundary, performExecution } from "./execution.js";
import { connectionSecretNames } from "./connection-settings.js";
import { canonical, check, digest, Problem } from "./errors.js";
import { deliveryMapping, deliveryResults } from "./delivery-evidence.js";
import { buildCompilerCurrent } from "./compiler-identity.js";
import type { Context } from "./operations.js";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const path = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (v) =>
      !/[\\:\x00-\x1f]/.test(v) &&
      v.split("/").every((p) => p && p !== "." && p !== ".."),
  );
const requestSchema = z
  .object({
    action: z.enum([
      "prepare",
      "catalogue",
      "discover",
      "review",
      "approve",
      "run",
      "retry",
      "recover",
    ]),
    flow: id,
    from: path,
    profile: id.optional(),
    original: id.optional(),
    runId: id.optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      ["retry", "recover"].includes(r.action)
        ? !r.original || !!r.runId
        : !!r.original
    )
      ctx.addIssue({
        code: "custom",
        message: "Select an original operation only for retry or recovery",
      });
  });
export const deliverySchemas = {
  delivery_inspect: z
    .object({
      flow: id.optional(),
      profile: id.optional(),
      from: path.optional(),
    })
    .strict(),
  delivery_execution_review: requestSchema,
  delivery_execution_apply: z.object({ review: z.unknown() }).strict(),
};
const code = (error: unknown) =>
  error instanceof Problem ? error.code : "UNAVAILABLE";
async function runRecord(context: Context, run: string) {
  const file = fence(context.root, `.ingestron/runs/${id.parse(run)}.json`);
  const stat = lstatSync(file);
  check(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024,
    "LIMIT",
    "Run receipt exceeds supported bounds",
  );
  const record = await performExecution(context, "run_status", { id: run });
  check(
    record.id === run &&
      Array.isArray(record.flows) &&
      record.flows.length <= 1000 &&
      record.flows.every((f: unknown) => id.safeParse(f).success),
    "RUN",
    "Invalid run receipt identity",
  );
  return record;
}
const summarySchema = z.object({
  id,
  action: z.enum([
    "prepare",
    "catalogue",
    "discover",
    "review",
    "approve",
    "run",
    "checkpoint_preview",
    "checkpoint_apply",
  ]),
  status: z.enum([
    "running",
    "succeeded",
    "failed",
    "interrupted",
    "indeterminate",
  ]),
  project: id,
  environment: id,
  profile: z.string().max(100),
  configuration: id,
  flows: z.array(id).max(1000),
  attempt: z.number().int().min(1).max(1000000),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  recoveryRequired: z.boolean(),
  qualityFailed: z.boolean(),
});
function summary(record: any) {
  return {
    ...summarySchema.parse({
      id: record.id,
      action: record.action,
      status: record.status,
      project: record.project,
      environment: record.environment,
      profile: record.profile ?? "",
      configuration: record.configuration,
      flows: record.flows,
      attempt: record.attempt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt ?? null,
      recoveryRequired: record.recoveryRequired === true,
      qualityFailed: !!record.quality,
    }),
    fingerprint:
      typeof record.fingerprint === "string" &&
      /^[a-f0-9]{64}$/.test(record.fingerprint)
        ? record.fingerprint
        : null,
    ...deliveryResults(record),
  };
}
async function inventory(
  context: Context,
  input: { flow?: string; profile?: string; from?: string },
) {
  const environment = context.environment ?? "dev",
    state = inspectProject(context.root, environment, { draft: true });
  check(
    state.flows.length <= 1000,
    "LIMIT",
    "Delivery inventory exceeds 1000 flows",
  );
  const packages = projectPackages(state.project),
    issues: { subject: string; code: string }[] = [];
  const providers = Object.entries(state.project.providers.configurations).map(
    ([name, configuration]) => {
      try {
        const pkg = packages[configuration.package];
        check(pkg, "PACKAGE", "Missing configured provider package");
        const locked = resolvePackage(
          context.root,
          configuredPackageReference(pkg),
        );
        const manifest = providerPackageSchema.parse(packageYaml(locked.file));
        const local =
          manifest.platform === "local" &&
          manifest.execution?.transport === "local-python/v1";
        return {
          name,
          platform: manifest.platform,
          reference: locked.reference,
          local,
          actions: local
            ? manifest.execution!.actions.filter(
                (a) => !a.startsWith("checkpoint_"),
              )
            : [],
          recovery:
            local &&
            manifest.execution?.acknowledgement === "provider-journal/v1",
        };
      } catch (error) {
        issues.push({ subject: name, code: code(error) });
        return {
          name,
          platform: "unavailable",
          local: false,
          actions: [],
          recovery: false,
        };
      }
    },
  );
  const runs = [],
    directory = fence(context.root, ".ingestron/runs");
  if (existsSync(directory)) {
    const entries = readdirSync(directory).filter((name) =>
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\.json$/.test(name),
    );
    check(
      entries.length <= 1000,
      "LIMIT",
      "Run history exceeds 1000 receipts; archive older evidence outside the active runs folder",
    );
    let bytes = 0;
    for (const name of entries.sort()) {
      try {
        const file = fence(context.root, `.ingestron/runs/${name}`);
        bytes += lstatSync(file).size;
        check(
          bytes <= 16 * 1024 * 1024,
          "LIMIT",
          "Run inventory exceeds 16 MiB",
        );
        const record = await runRecord(context, name.slice(0, -5));
        if (
          record.environment === environment &&
          record.project === state.project.id
        )
          runs.push(summary(record));
      } catch (error) {
        if (error instanceof Problem && error.code === "LIMIT") throw error;
        issues.push({ subject: name, code: code(error) });
      }
    }
  }
  runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  let evidence: any = null;
  if (input.flow) {
    check(
      state.flows.some((f) => f.id === input.flow),
      "FLOW",
      "Select a saved flow",
    );
    try {
      const boundary = executionBoundary(
        context,
        {
          flow: input.flow,
          profile: input.profile,
          from: input.from ?? `build/${environment}`,
        },
        "execution_evidence",
      );
      check(
        boundary.build.project === state.project.id &&
          boundary.manifest.platform === "local",
        "OWNER",
        "Select this project's local build",
      );
      evidence = {
        flow: input.flow,
        profile: input.profile ?? "",
        fingerprint: boundary.fingerprint,
        current: buildCompilerCurrent(boundary.build),
        mapping: deliveryMapping(boundary.packageRoot, input.flow),
      };
    } catch (error) {
      issues.push({ subject: input.flow, code: code(error) });
    }
  }
  return {
    apiVersion: "ingestron.delivery-workspace/v1",
    project: state.project.id,
    environment,
    providers,
    flows: state.flows.map((f) => ({
      id: f.id,
      kind: f.kind,
      provider: f.provider ?? state.project.defaults.provider ?? "",
      schedule: f.schedule ?? null,
      profiles: Object.entries(f.executionProfiles).map(([name, p]) => ({
        name,
        provider: p.provider,
      })),
    })),
    runs,
    issues,
    deploymentExecuted: false,
    backgroundWorkerStarted: false,
    evidence,
  };
}
async function reviewed(context: Context, input: unknown) {
  const request = requestSchema.parse(input),
    root = realpathSync(context.root),
    environment = context.environment ?? "dev";
  const state = inspectProject(root, environment, { draft: true });
  check(
    state.flows.some((f) => f.id === request.flow),
    "FLOW",
    "Select a saved project flow",
  );
  const previous = request.original
    ? await runRecord(context, request.original)
    : undefined;
  if (previous) {
    check(
      previous.project === state.project.id &&
        previous.environment === environment &&
        previous.from === request.from &&
        (previous.profile ?? "") === (request.profile ?? "") &&
        previous.flows.length === 1 &&
        previous.flows[0] === request.flow,
      "SELECT",
      "Original operation belongs to another project, environment or flow",
    );
    check(
      previous.status !== "running",
      "RUN",
      "Wait for the original operation to finish",
    );
    check(
      request.action === "retry"
        ? previous.action === "run"
        : previous.action !== "run",
      "RUN",
      "Use retry for a data run and recovery for a setup operation",
    );
  } else request.runId ??= randomUUID();
  const operation =
    request.action === "prepare"
      ? "runtime_prepare"
      : request.action === "recover"
        ? "execution_recover"
        : "run";
  const args = {
    from: request.from,
    profile: request.profile,
    flow: request.flow,
    action: request.action === "retry" ? "run" : request.action,
  };
  const boundary = executionBoundary(context, args, operation, previous);
  check(
    boundary.build.project === state.project.id,
    "OWNER",
    "Generated build belongs to another project",
  );
  check(
    boundary.manifest.platform === "local",
    "CAPABILITY",
    "This workflow supports local execution only; use the native deployment handoff for cloud targets",
  );
  const secrets = new Set<string>();
  for (const flow of boundary.flows) {
    const file = fence(boundary.packageRoot, `flows/${flow}/connector.json`);
    check(
      lstatSync(file).isFile() && lstatSync(file).size <= 2 * 1024 * 1024,
      "LIMIT",
      "Connector execution settings exceed supported bounds",
    );
    const config = JSON.parse(readFileSync(file, "utf8"));
    for (const name of connectionSecretNames(config.sourceSettings ?? {}))
      secrets.add(name);
    if (typeof config.configEnv === "string") secrets.add(config.configEnv);
  }
  return {
    apiVersion: "ingestron.delivery-execution-review/v1",
    rootDigest: digest(root),
    environment,
    request,
    originalDigest: previous ? digest(canonical(previous)) : null,
    project: state.project.id,
    provider: boundary.pkg.reference,
    commit: boundary.pkg.commit,
    buildDigest: boundary.build.planDigest,
    fingerprint: boundary.fingerprint,
    resources: boundary.resourceDeclaration.coverage,
    resourceCount: boundary.resources.length,
    secretNames: [...secrets].sort(),
    networkDependencies: request.action === "prepare",
    sourceAccess: request.action !== "prepare",
    mapping: ["approve", "run"].includes(request.action)
      ? deliveryMapping(boundary.packageRoot, request.flow)
      : null,
    deploymentExecuted: false,
  };
}
export async function performDelivery(
  context: Context,
  operation: keyof typeof deliverySchemas,
  input: any,
): Promise<any> {
  if (operation === "delivery_inspect") return inventory(context, input);
  if (operation === "delivery_execution_review")
    return reviewed(context, input);
  check(
    context.allowWrite && context.allowExecute,
    "PERMISSION",
    "Reviewed execution requires explicit write and execute permission",
  );
  const review = input.review;
  check(
    review?.apiVersion === "ingestron.delivery-execution-review/v1",
    "PROPOSAL",
    "Choose a reviewed local execution operation",
  );
  const fresh = await reviewed(context, review.request);
  check(
    canonical(fresh) === canonical(review),
    "STALE",
    "Build, operation or project changed since review; review again",
  );
  const r = fresh.request,
    base = { from: r.from, ...(r.profile ? { profile: r.profile } : {}) };
  const result =
    r.action === "recover"
      ? await performExecution(context, "execution_recover", {
          id: r.original,
          ...base,
        })
      : r.action === "retry"
        ? await performExecution(context, "run", {
            retry: r.original,
            action: "run",
            ...base,
          })
        : await performExecution(
            context,
            r.action === "prepare" ? "runtime_prepare" : "run",
            {
              ...base,
              flow: r.flow,
              runId: r.runId,
              ...(r.action === "prepare" ? {} : { action: r.action }),
            },
          );
  return { executed: true, run: summary(result), deploymentExecuted: false };
}
