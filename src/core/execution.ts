/** Explicit execution boundary. Compilation never calls this module's launcher. */
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { parseEnv } from "node:util";
import { z } from "zod";
import { check, digest, canonical, Problem } from "./errors.js";
import {
  fence,
  resolvePackage,
  packageYaml,
  providerPackageSchema,
} from "./packages.js";
import { prepareBuildExecution } from "./build-access.js";
import { ExecutionUncertainFailure } from "./execution-outcome.js";
import {
  checkpointFailureCodes,
  validateOperationAcknowledgement,
} from "./execution-acknowledgement.js";
import { executionResources } from "./execution-resources.js";
import {
  compilerIdentity,
  buildCompilerIdentity,
  buildCompilerCurrent,
} from "./compiler-identity.js";
import { validateOutput } from "./generate.js";
import {
  checkpointMigrationBoundary,
  checkpointMigrationEvidence,
} from "./checkpoint-migration.js";
import { checkProviderCompatibility } from "../plugins/compatibility.js";
import type { Context } from "./operations.js";
import {
  ExecutionQualityFailure,
  qualityFailureEvidence,
} from "./execution-quality.js";
import { performDiscovery } from "./discovery.js";
import { inspectProject } from "./planner.js";
import { enforceProjectPolicy } from "./project-governance.js";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const selection = {
  from: z.string().optional(),
  profile: id.optional(),
  provider: id.optional(),
  flow: id.optional(),
};
export const executionSchemas = {
  execution_features: z.object({}).strict(),
  execution_evidence: z.object({ ...selection, id: id.optional() }).strict(),
  execution_resources: z.object(selection).strict(),
  runtime_prepare: z
    .object({
      ...selection,
      python: z.string().optional(),
      runId: id.optional(),
    })
    .strict(),
  run: z
    .object({
      ...selection,
      action: z
        .enum(["catalogue", "discover", "review", "approve", "run"])
        .default("run"),
      runId: id.optional(),
      retry: id.optional(),
      envFile: z.string().optional(),
    })
    .strict(),
  checkpoint_preview: z
    .object({
      from: z.string().optional(),
      profile: id.optional(),
      flow: id,
      previous: z.string(),
      runId: id.optional(),
    })
    .strict(),
  checkpoint_apply: z
    .object({
      from: z.string().optional(),
      profile: id.optional(),
      flow: id,
      previous: z.string(),
      expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
      runId: id.optional(),
    })
    .strict(),
  run_status: z.object({ id }).strict(),
  execution_recover: z.object({ id }).strict(),
  // Discovery per route (PB-064 phase 6): draft contracts from the source.
  discover: z
    .object({
      flow: id,
      from: z.string().optional(),
      out: z.string().default("contracts"),
      local: id.optional(),
      acceptKeys: z.boolean().default(false),
      python: z.string().optional(),
      envFile: z.string().optional(),
    })
    .strict(),
};
const now = () => new Date().toISOString();
/** Host API support only; provider recovery is declared by its installed manifest. */
export function executionFeatures() {
  return {
    apiVersion: "ingestron.execution-features/v1",
    runtimePrepareRunId: true,
    compilerIdentity: true,
    executionEvidence: true,
    checkpointMigration: true,
    buildRetention: true,
    buildRetentionInspect: true,
  };
}
function store(file: string, value: any) {
  const temp = file + "." + randomUUID() + ".tmp";
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temp, file);
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function receipt(root: string, runId: string) {
  const file = fence(root, `.ingestron/runs/${runId}.json`);
  check(existsSync(file), "RUN", "Unknown run identity");
  const value = JSON.parse(readFileSync(file, "utf8"));
  check(value.apiVersion === "ingestron.run/v1", "RUN", "Invalid run receipt");
  if (value.status === "running" && !alive(value.pid)) {
    value.status = "indeterminate";
    value.outcome = "uncertain";
    value.recoveryRequired = true;
  }
  return value;
}
export async function launch(
  python: string,
  entry: string,
  request: any,
  cwd: string,
  env: NodeJS.ProcessEnv,
  onChild?: (pid: number) => void,
) {
  return await new Promise<any>((done, reject) => {
    const child = spawn(python, [entry], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "",
      bytes = 0,
      stopped = false,
      sent = false;
    const signal = (s: NodeJS.Signals) => {
      try {
        process.platform === "win32"
          ? child.kill(s)
          : process.kill(-child.pid!, s);
      } catch {}
    };
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      signal("SIGINT");
      killTimer = setTimeout(() => signal("SIGKILL"), 10000);
    };
    const timer = setTimeout(stop, 30 * 60 * 1000);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    };
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 10_000_000) stop();
      else output += chunk;
    });
    child.stderr.on("data", () => {}); // Source errors may contain credentials.
    child.stdin.on("error", () => {});
    child.on("error", () => {
      cleanup();
      reject(
        new Problem(
          "RUNTIME",
          "Python could not start; install python3 for the local execution adapter",
        ),
      );
    });
    child.on("close", (code) => {
      cleanup();
      if (stopped) {
        reject(new ExecutionUncertainFailure("INTERRUPTED"));
        return;
      }
      let result: any;
      try {
        result = JSON.parse(output);
      } catch {
        reject(
          sent
            ? new ExecutionUncertainFailure()
            : new Problem("RUNTIME", "Execution request was not dispatched"),
        );
        return;
      }
      if (
        !result ||
        result.apiVersion !== "ingestron.execution-result/v1" ||
        !["succeeded", "failed", "interrupted"].includes(result.status) ||
        code === null ||
        (code === 0 && result.status !== "succeeded") ||
        (code !== 0 && result.status === "succeeded")
      ) {
        reject(new ExecutionUncertainFailure());
        return;
      }
      if (result.status === "interrupted") {
        reject(new ExecutionUncertainFailure("INTERRUPTED"));
        return;
      }
      if (result.status === "failed") {
        reject(
          result.errorCode === "QUALITY_FAILED"
            ? new ExecutionQualityFailure(
                qualityFailureEvidence(result.quality),
              )
            : result.errorCode === "SOURCE_METADATA_LIMIT" ||
                result.errorCode === "SOURCE_METADATA_COLLECTION_LIMIT"
              ? new Problem(
                  result.errorCode,
                  result.errorCode === "SOURCE_METADATA_COLLECTION_LIMIT"
                    ? "This flow exceeds the 7 MB metadata collection limit. Split tables into smaller flows or select fewer fields, then prepare again"
                    : "This flow exceeds the 2 MB metadata limit. Split tables into smaller flows or select fewer fields, then prepare again",
                )
              : checkpointFailureCodes.includes(result.errorCode)
                ? new Problem(
                    result.errorCode,
                    result.errorCode === "CHECKPOINT_MIGRATION_STALE"
                      ? "The committed checkpoint head changed after review; preview the current migration before applying"
                      : result.errorCode === "OUTPUT_BUSY"
                        ? "Another operation owns this output namespace; wait for its original outcome"
                        : "Checkpoint history or policy requires review before continuing",
                  )
                : new Problem(
                    "RUNTIME",
                    typeof result.message === "string"
                      ? result.message
                      : "Provider execution failed",
                  ),
        );
        return;
      }
      done(result);
    });
    try {
      check(!!child.pid, "RUNTIME", "Python execution process did not start");
      onChild?.(child.pid!);
      // Persist the process group before sending any executable request.
      child.stdin.end(JSON.stringify(request));
      sent = true;
    } catch (error) {
      signal("SIGKILL");
      cleanup();
      reject(error);
    }
  });
}
/** Read-only preflight shared by direct execution and durable dispatch. */
export function executionBoundary(
  context: Context,
  args: any,
  operation: keyof typeof executionSchemas = "run",
  previous?: any,
) {
  const root = resolve(context.root),
    environment = context.environment ?? "dev";
  const from = previous?.from ?? args.from ?? "build/generated";
  const directory = fence(root, from);
  check(
    existsSync(resolve(directory, "ingestron-project.json")),
    "BUILD",
    "Build the project first; supply from to select a different output directory",
  );
  const checked = validateOutput(directory);
  check(
    checked.ownership === "managed",
    "OWNERSHIP",
    "Execution requires an unchanged managed build",
  );
  check(
    !!previous ||
      ["execution_evidence", "execution_resources"].includes(operation) ||
      !readdirSync(directory).includes(".ingestron-retained-build.json"),
    "OWNER",
    "Retained baselines cannot execute fresh work; select the working build directory",
  );
  const build = JSON.parse(
    readFileSync(resolve(directory, "ingestron-project.json"), "utf8"),
  );
  check(
    build.apiVersion === "ingestron.project-build/v1" &&
      build.environment === environment,
    "BUILD",
    "Build environment differs; rebuild for this environment",
  );
  if (
    !previous &&
    !["execution_evidence", "execution_resources"].includes(operation)
  )
    check(
      buildCompilerCurrent(build),
      "STALE",
      "Compiler changed since generation; prepare and review a current build before fresh execution",
    );
  check(
    (args.profile ?? previous?.profile ?? "") ===
      (build.selection?.profile ?? ""),
    "PROFILE",
    "Build execution profile differs; select the matching profile and build directory",
  );
  for (const [file, hash] of Object.entries(build.sourceFiles ?? {}))
    check(
      existsSync(fence(root, file)) &&
        digest(readFileSync(fence(root, file))) === hash,
      "STALE",
      `Project input changed: ${file}; rebuild before execution`,
    );
  check(
    build.packageLockSha256 ===
      digest(readFileSync(fence(root, "packages.lock.yaml"))),
    "STALE",
    "Package lock changed; rebuild before execution",
  );
  const candidates = build.packages.filter((p: any) =>
    previous
      ? p.configuration === previous.configuration
      : args.provider
        ? p.configuration === args.provider
        : args.flow
          ? p.scope.flows.includes(args.flow)
          : true,
  );
  check(
    candidates.length === 1,
    "SELECT",
    "Select one execution target with provider or flow",
  );
  const pkg = candidates[0];
  const installed = resolvePackage(root, pkg.reference);
  check(
    installed.entry.commit === pkg.commit,
    "STALE",
    "Execution provider changed; rebuild",
  );
  const manifest = providerPackageSchema.parse(packageYaml(installed.file));
  check(
    ["execution_evidence", "execution_resources"].includes(operation) ||
      manifest.platform === "local" ||
      !build.deferredDestinations?.length,
    "DEFERRED",
    "Supply deployment settings for deferred destinations and regenerate before execution",
  );

  checkProviderCompatibility(manifest);
  const capability = manifest.execution;
  check(
    capability,
    "NOT_IMPLEMENTED",
    `${pkg.configuration}: run and runtime preparation are not implemented by this provider; build remains available. Cloud deployment requires separate review`,
  );
  check(
    capability.transport === "local-python/v1",
    "NOT_IMPLEMENTED",
    "This execution transport is not implemented by this host",
  );
  const action =
    operation === "runtime_prepare"
      ? "prepare"
      : operation === "execution_resources"
        ? "run"
        : operation === "execution_recover"
          ? previous?.action
          : operation === "execution_evidence"
            ? (previous?.action ?? "run")
            : operation === "checkpoint_preview" ||
                operation === "checkpoint_apply"
              ? operation
              : args.action;
  check(
    operation === "execution_resources" || capability.actions.includes(action),
    "NOT_IMPLEMENTED",
    "Provider does not support this execution action",
  );
  if (operation === "execution_recover")
    check(
      capability.acknowledgement === "provider-journal/v1" &&
        previous?.provider === pkg.reference &&
        previous?.providerCommit === pkg.commit,
      "NOT_IMPLEMENTED",
      "The original provider must support durable operation acknowledgement; its build ownership is retained",
    );
  const flows = previous?.flows ?? (args.flow ? [args.flow] : pkg.scope.flows);
  if (previous && args.flow)
    check(
      flows.length === 1 && flows[0] === args.flow,
      "SELECT",
      "Original operation belongs to a different flow selection",
    );
  if (operation === "run" && args.action === "run")
    enforceProjectPolicy(inspectProject(root, environment, { draft: true }), {
      flowIds: flows,
    });
  const target = fence(
    directory,
    pkg.directory === "."
      ? capability.entryPoint
      : pkg.directory.replace(/\/$/, "") + "/" + capability.entryPoint,
  );
  const packageRoot =
    pkg.directory === "."
      ? directory
      : fence(directory, pkg.directory.replace(/\/$/, ""));
  const declared = executionResources(
    root,
    environment,
    pkg,
    capability,
    packageRoot,
    flows,
  );
  const migration = ["checkpoint_preview", "checkpoint_apply"].includes(action)
    ? checkpointMigrationBoundary(
        root,
        { directory, build, pkg, flows },
        args,
        previous,
      )
    : undefined;
  const fingerprint = digest(
    canonical({
      plan: checked.planDigest,
      configuration: pkg.configuration,
      flows,
      ...(migration ? { checkpointMigration: migration.request } : {}),
    }),
  );
  if (previous)
    check(
      previous.fingerprint === fingerprint,
      "STALE",
      "Retry requires the same build and flow selection",
    );
  return {
    migration,
    resources: declared.resources,
    resourceDeclaration: declared,
    directory,
    build,
    pkg,
    manifest,
    capability,
    action,
    flows,
    fingerprint,
    target,
    packageRoot,
  };
}

export async function performExecution(
  context: Context,
  operation: keyof typeof executionSchemas,
  args: any,
): Promise<any> {
  const root = resolve(context.root),
    environment = context.environment ?? "dev";
  if (operation === "execution_features") return executionFeatures();
  if (operation === "run_status") return receipt(root, args.id);
  if (operation === "execution_evidence") {
    const original = args.id ? receipt(root, args.id) : undefined;
    if (original) {
      check(
        original.environment === environment &&
          (original.profile ?? "") === (args.profile ?? "") &&
          (!args.from || args.from === original.from) &&
          (!args.provider || args.provider === original.configuration),
        "SELECT",
        "Original operation belongs to a different execution scope",
      );
    }
    const boundary = executionBoundary(context, args, operation, original);
    const compiler = compilerIdentity();
    return {
      apiVersion: "ingestron.execution-evidence/v1",
      compiler,
      build: {
        digest:
          boundary.build.planDigest ??
          validateOutput(boundary.directory).planDigest,
        compiler: buildCompilerIdentity(boundary.build),
        current: buildCompilerCurrent(boundary.build),
      },
      environment,
      profile: boundary.build.selection?.profile ?? "",
      flows: boundary.flows,
      provider: {
        reference: boundary.pkg.reference,
        commit: boundary.pkg.commit,
      },
      ...(original
        ? {
            original: {
              id: original.id,
              action: original.action,
              status: original.status,
            },
          }
        : {}),
    };
  }
  if (operation === "execution_resources") {
    check(!(args.flow && args.provider), "SELECT", "Choose flow or provider");
    const boundary = executionBoundary(context, args, operation);
    return {
      apiVersion: "ingestron.execution-resource-inspection/v1",
      ...boundary.resourceDeclaration,
    };
  }
  if (operation === "discover")
    return performDiscovery(
      { ...context, root },
      args,
      (op, request): Promise<any> =>
        performExecution(context, op, executionSchemas[op].parse(request)),
    );
  check(
    context.allowExecute && context.allowWrite,
    "PERMISSION",
    "Execution requires allowExecute and allowWrite in the operation context",
  );
  check(
    process.platform !== "win32",
    "CAPABILITY",
    "Local connector execution currently requires POSIX; use a supported Linux environment",
  );
  if (operation === "runtime_prepare")
    check(
      context.allowNetwork,
      "PERMISSION",
      "Runtime preparation requires dependency-network access",
    );
  check(!(args.flow && args.provider), "SELECT", "Choose flow or provider");
  check(
    !(
      args.retry &&
      (args.flow || args.provider || args.runId || args.action !== "run")
    ),
    "SELECT",
    "Retry uses the recorded run selection and identity",
  );
  const acknowledging = operation === "execution_recover";
  const previous = acknowledging
    ? receipt(root, args.id)
    : args.retry
      ? receipt(root, args.retry)
      : undefined;
  if (previous) {
    check(
      (acknowledging
        ? previous.id === args.id &&
          [
            "prepare",
            "catalogue",
            "discover",
            "review",
            "approve",
            "checkpoint_preview",
            "checkpoint_apply",
          ].includes(previous.action)
        : previous.action === "run") && previous.environment === environment,
      "RUN",
      acknowledging
        ? "Recover a recorded setup operation in the selected environment; data runs use their original retry"
        : "Retry requires a data run in the selected environment",
    );
    check(previous.status !== "running", "RUN", "Run is still active");
  }
  check(
    !previous || !args.from || args.from === previous.from,
    "SELECT",
    "Retry uses its recorded build directory",
  );
  const runId = previous?.id ?? args.runId ?? randomUUID();
  const file = fence(root, `.ingestron/runs/${runId}.json`);
  check(
    previous || !existsSync(file),
    "RUN",
    "Run identity already exists; supply retry to repeat it",
  );
  const selectedDirectory = fence(
    root,
    previous?.from ?? args.from ?? "build/generated",
  );
  const held = prepareBuildExecution(
    selectedDirectory,
    runId,
    previous
      ? previous.status === "indeterminate"
        ? "indeterminate"
        : "finished"
      : "none",
    () => executionBoundary(context, args, operation, previous),
  );
  let settled = false,
    uncertain = false;
  let baselineHeld: ReturnType<typeof prepareBuildExecution<any>> | undefined;
  try {
    const {
      directory,
      build,
      pkg,
      action,
      flows,
      fingerprint,
      target,
      packageRoot,
      capability,
      migration,
    } = held.boundary;
    if (migration)
      baselineHeld = prepareBuildExecution(
        migration.directory,
        runId,
        previous
          ? previous.status === "indeterminate"
            ? "indeterminate"
            : "finished"
          : "none",
        () => {
          const checked = checkpointMigrationBoundary(
            root,
            held.boundary,
            args,
            previous,
          );
          check(
            canonical(checked.request) === canonical(migration.request),
            "STALE",
            "Retained baseline changed before checkpoint dispatch",
          );
          return { flows, fingerprint, resources: held.boundary.resources };
        },
      );
    if (acknowledging)
      check(
        capability.acknowledgement === "provider-journal/v1" &&
          previous.provider === pkg.reference &&
          previous.providerCommit === pkg.commit,
        "NOT_IMPLEMENTED",
        "The original provider must support durable operation acknowledgement; its build ownership is retained",
      );
    const cache = fence(root, ".ingestron/runtimes");
    mkdirSync(cache, { recursive: true });
    const runs = fence(root, ".ingestron/runs");
    mkdirSync(runs, { recursive: true });
    check(
      previous || !existsSync(file),
      "RUN",
      "Run identity already exists; supply retry to repeat it",
    );
    const guard = fence(runs, runId + ".lock");
    if (previous?.status === "indeterminate" && existsSync(guard))
      rmSync(guard, { recursive: true });
    try {
      mkdirSync(guard);
    } catch {
      throw new Problem("RUN", "Run is already active");
    }
    const record = {
      apiVersion: "ingestron.run/v1",
      id: runId,
      action,
      status: "running",
      pid: process.pid,
      environment,
      profile: args.profile ?? previous?.profile,
      project: build.project,
      provider: pkg.reference,
      providerCommit: pkg.commit,
      from: relative(root, directory),
      configuration: pkg.configuration,
      flows,
      fingerprint,
      compiler: buildCompilerIdentity(build),
      ...(migration ? { checkpointMigration: migration.request } : {}),
      attempt: (previous?.attempt ?? 0) + 1,
      startedAt: now(),
    };
    try {
      store(file, record);
      const env: NodeJS.ProcessEnv = {};
      for (const key of [
        "PATH",
        "HOME",
        "TMPDIR",
        "LANG",
        "SSL_CERT_FILE",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
      ])
        if (process.env[key]) env[key] = process.env[key];
      const provided = args.envFile
        ? parseEnv(readFileSync(fence(root, args.envFile), "utf8"))
        : {};
      const allow = new Set<string>();
      const secrets = (value: any) => {
        if (!value || typeof value !== "object") return;
        if (value.$secret?.env) allow.add(value.$secret.env);
        for (const v of Object.values(value)) secrets(v);
      };
      for (const flow of migration ? [] : flows) {
        const config = JSON.parse(
          readFileSync(
            fence(packageRoot, `flows/${flow}/connector.json`),
            "utf8",
          ),
        );
        secrets(config.sourceSettings);
        if (config.configEnv) allow.add(config.configEnv);
      }
      for (const name of allow) {
        check(
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
          "SECRET",
          "Invalid environment reference",
        );
        check(
          !/^(PYTHON|PIP|LD_|DYLD_)/.test(name) &&
            !["PATH", "HOME", "TMPDIR"].includes(name),
          "SECRET",
          "Secret names cannot override execution environment controls",
        );
        const value = provided[name] ?? process.env[name];
        if (value !== undefined) env[name] = value;
      }
      env.PYTHONNOUSERSITE = "1";
      env.PYTHONDONTWRITEBYTECODE = "1";
      const result = await launch(
        "python3",
        target,
        {
          apiVersion: "ingestron.execution-request/v1",
          action: acknowledging ? "acknowledge" : action,
          ...(capability.acknowledgement ? { fingerprint } : {}),
          ...(acknowledging ? { originalAction: action } : {}),
          flows,
          runId,
          cache,
          python: args.python,
          ...(migration
            ? {
                previousRoot: migration.packageRoot,
                projectRoot: root,
                expectedDigest: migration.request.expectedDigest,
              }
            : {}),
        },
        packageRoot,
        env,
        (pid) => {
          held.access.attachChild(pid);
          baselineHeld?.access.attachChild(pid);
        },
      );
      const acknowledged = acknowledging
        ? validateOperationAcknowledgement(result, {
            id: runId,
            action,
            flows,
            fingerprint,
          })
        : undefined;
      const finalStatus = acknowledged?.status ?? "succeeded";
      const verifiedResult =
        migration && finalStatus === "succeeded"
          ? checkpointMigrationEvidence(
              acknowledged ?? result,
              action,
              flows,
              migration.request.expectedDigest,
            )
          : (acknowledged ?? result);
      const complete = {
        ...record,
        status: finalStatus,
        outcome: finalStatus,
        recoveryRequired: false,
        finishedAt: now(),
        result: verifiedResult,
        ...(acknowledging ? { acknowledgedOriginalOperation: true } : {}),
      };
      store(file, complete);
      settled = true;
      return complete;
    } catch (error) {
      uncertain =
        error instanceof ExecutionUncertainFailure ||
        held.access.inheritedUncertainty ||
        !!baselineHeld?.access.inheritedUncertainty;
      store(file, {
        ...record,
        status: uncertain
          ? "indeterminate"
          : error instanceof Problem && error.code === "INTERRUPTED"
            ? "interrupted"
            : "failed",
        outcome: uncertain ? "uncertain" : "failed",
        recoveryRequired: uncertain,
        finishedAt: now(),
        error: "Execution failed; source details withheld",
        ...(error instanceof ExecutionQualityFailure
          ? { quality: error.quality }
          : {}),
      });
      throw new Problem(
        error instanceof Problem ? error.code : "RUNTIME",
        `${error instanceof Problem ? error.message : "Execution failed"}. Run ${runId}; inspect run_status for this run identity`,
      );
    } finally {
      rmSync(guard, { recursive: true, force: true });
    }
  } finally {
    try {
      await baselineHeld?.access.finish(settled, uncertain);
    } finally {
      await held.access.finish(settled, uncertain);
    }
  }
}
