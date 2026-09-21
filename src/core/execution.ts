/** Explicit execution boundary. Compilation never calls this module's launcher. */
import {
  existsSync,
  readFileSync,
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
import { validateOutput } from "./generate.js";
import { checkProviderCompatibility } from "../plugins/compatibility.js";
import type { Context } from "./operations.js";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const selection = {
  from: z.string().optional(),
  provider: id.optional(),
  flow: id.optional(),
};
export const executionSchemas = {
  runtime_prepare: z
    .object({ ...selection, python: z.string().optional() })
    .strict(),
  run: z
    .object({
      ...selection,
      action: z.enum(["discover", "review", "approve", "run"]).default("run"),
      runId: id.optional(),
      retry: id.optional(),
      envFile: z.string().optional(),
    })
    .strict(),
  run_status: z.object({ id }).strict(),
};
const now = () => new Date().toISOString();
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
  if (value.status === "running" && !alive(value.pid))
    value.status = "indeterminate";
  return value;
}
async function launch(
  python: string,
  entry: string,
  request: any,
  cwd: string,
  env: NodeJS.ProcessEnv,
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
      stopped = false;
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
        reject(
          new Problem(
            "INTERRUPTED",
            "Execution interrupted or timed out; inspect its receipt before retrying",
          ),
        );
        return;
      }
      try {
        const result = JSON.parse(output);
        check(
          result.apiVersion === "ingestron.execution-result/v1",
          "RUNTIME",
          "Invalid provider execution result",
        );
        check(
          code === 0 && result.status === "succeeded",
          "RUNTIME",
          result.message ?? "Provider execution failed",
        );
        done(result);
      } catch (error) {
        reject(
          error instanceof Problem
            ? error
            : new Problem(
                "RUNTIME",
                "Provider execution failed; upstream output withheld",
              ),
        );
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
export async function performExecution(
  context: Context,
  operation: keyof typeof executionSchemas,
  args: any,
) {
  const root = resolve(context.root),
    environment = context.environment ?? "dev";
  if (operation === "run_status") return receipt(root, args.id);
  check(
    context.allowExecute && context.allowWrite,
    "PERMISSION",
    "Execution requires explicit execution and local-write access; MCP needs --allow-execute --allow-write",
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
  check(!(args.flow && args.provider), "SELECT", "Choose --flow or --provider");
  check(
    !(
      args.retry &&
      (args.flow || args.provider || args.runId || args.action !== "run")
    ),
    "SELECT",
    "Retry uses the recorded run selection and identity",
  );
  const previous = args.retry ? receipt(root, args.retry) : undefined;
  if (previous) {
    check(
      previous.action === "run" && previous.environment === environment,
      "RUN",
      "Retry requires a data run in the selected environment",
    );
    check(previous.status !== "running", "RUN", "Run is still active");
  }
  check(
    !previous || !args.from || args.from === previous.from,
    "SELECT",
    "Retry uses its recorded build directory",
  );
  const from = previous?.from ?? args.from ?? "build/generated";
  const directory = fence(root, from);
  check(
    existsSync(resolve(directory, "ingestron-project.json")),
    "BUILD",
    "Build first with ingestron build; use --from for a different output directory",
  );
  const checked = validateOutput(directory);
  check(
    checked.ownership === "managed",
    "OWNERSHIP",
    "Execution requires an unchanged managed build",
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
    "Select one execution target with --provider or --flow",
  );
  const pkg = candidates[0];
  const installed = resolvePackage(root, pkg.reference);
  check(
    installed.entry.commit === pkg.commit,
    "STALE",
    "Execution provider changed; rebuild",
  );
  const manifest = providerPackageSchema.parse(packageYaml(installed.file));
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
    "This execution transport is not implemented by this CLI",
  );
  const action = operation === "runtime_prepare" ? "prepare" : args.action;
  check(
    capability.actions.includes(action),
    "NOT_IMPLEMENTED",
    "Provider does not support this execution action",
  );
  const flows = previous?.flows ?? (args.flow ? [args.flow] : pkg.scope.flows);
  const fingerprint = digest(
    canonical({
      plan: checked.planDigest,
      configuration: pkg.configuration,
      flows,
    }),
  );
  if (previous)
    check(
      previous.fingerprint === fingerprint,
      "STALE",
      "Retry requires the same build and flow selection",
    );
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
  const cache = fence(root, ".ingestron/runtimes");
  mkdirSync(cache, { recursive: true });
  const runs = fence(root, ".ingestron/runs");
  mkdirSync(runs, { recursive: true });
  const runId = previous?.id ?? args.runId ?? randomUUID();
  const file = fence(runs, runId + ".json");
  check(
    previous || !existsSync(file),
    "RUN",
    "Run identity already exists; use --retry to repeat it",
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
    project: build.project,
    provider: pkg.reference,
    providerCommit: pkg.commit,
    from: relative(root, directory),
    configuration: pkg.configuration,
    flows,
    fingerprint,
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
    for (const flow of flows) {
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
        action,
        flows,
        runId,
        cache,
        python: args.python,
      },
      packageRoot,
      env,
    );
    const complete = {
      ...record,
      status: "succeeded",
      finishedAt: now(),
      result,
    };
    store(file, complete);
    return complete;
  } catch (error) {
    store(file, {
      ...record,
      status:
        error instanceof Problem && error.code === "INTERRUPTED"
          ? "interrupted"
          : "failed",
      finishedAt: now(),
      error: "Execution failed; source details withheld",
    });
    throw new Problem(
      error instanceof Problem ? error.code : "RUNTIME",
      `${error instanceof Problem ? error.message : "Execution failed"}. Run ${runId}; use ingestron run status ${runId}`,
    );
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}
