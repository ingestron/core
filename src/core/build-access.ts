/** Serialize build mutation/preflight and retain exact execution ownership across caller death. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  readdirSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { check, Problem } from "./errors.js";
import { fence } from "./packages.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const leaseSchema = z
  .object({
    apiVersion: z.literal("ingestron.build-access/v1"),
    id,
    token: z.string().uuid(),
    pid: z.number().int().positive(),
    childPid: z.number().int().positive().nullable(),
    phase: z.enum(["active", "uncertain"]),
    recoveryPending: z.boolean().optional(),
    ownerFinished: z.boolean().optional(),
    flows: z.array(id).min(1).max(100),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    resources: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .min(1)
      .max(500)
      .optional(),
  })
  .strict();
type Lease = z.infer<typeof leaseSchema>;
const guardSchema = z
  .object({
    apiVersion: z.literal("ingestron.build-guard/v1"),
    token: z.string().uuid(),
    pid: z.number().int().positive(),
    kind: z.enum(["generation", "execution"]),
    id: id.optional(),
  })
  .strict();
function alive(pid: number, group = false) {
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (error: any) {
    return error.code !== "ESRCH";
  }
}
function readBounded(file: string) {
  check(
    !lstatSync(file).isSymbolicLink() &&
      lstatSync(file).isFile() &&
      lstatSync(file).size <= 65536,
    "EXECUTION_STATE",
    "Invalid managed-build access state",
  );
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Problem("EXECUTION_STATE", "Invalid managed-build access state");
  }
}
function save(file: string, value: unknown) {
  const temporary = file + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}
export function withBuildGuard<T>(
  directory: string,
  fn: () => T,
  recovery?: string,
): T {
  if (recovery)
    check(
      existsSync(directory),
      "BUILD",
      "Build the project first; supply from to select a different output directory",
    );
  mkdirSync(directory, { recursive: true });
  directory = realpathSync(directory);
  const file = fence(directory, ".ingestron-generate.lock"),
    owner = {
      apiVersion: "ingestron.build-guard/v1",
      token: randomUUID(),
      pid: process.pid,
      kind: recovery ? "execution" : "generation",
      ...(recovery ? { id: recovery } : {}),
    };
  const acquire = () =>
    writeFileSync(file, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
  try {
    acquire();
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    // A dead execution preflight has not launched its child. Never recover a generator's partial writes here.
    let old: z.infer<typeof guardSchema> | undefined;
    try {
      old = guardSchema.parse(readBounded(file));
    } catch {}
    if (
      recovery &&
      old?.kind === "execution" &&
      old.id === recovery &&
      !alive(old.pid)
    ) {
      rmSync(file);
      try {
        acquire();
      } catch {
        throw new Problem(
          "BUILD_BUSY",
          "Another operation owns this managed build; retry after it finishes",
        );
      }
    } else
      throw new Problem(
        "BUILD_BUSY",
        "Another operation owns this managed build; retry after it finishes",
      );
  }
  try {
    const value = fn();
    check(
      !(value && typeof value === "object" && "then" in value),
      "BUILD_GUARD",
      "Managed-build critical sections cannot await execution",
    );
    return value;
  } finally {
    if (existsSync(file)) {
      const current = guardSchema.parse(readBounded(file));
      if (current.token === owner.token) rmSync(file);
    }
  }
}
function leases(directory: string) {
  const folder = fence(directory, ".ingestron-execution");
  if (!existsSync(folder)) return [];
  check(
    lstatSync(folder).isDirectory(),
    "EXECUTION_STATE",
    "Invalid managed-build access directory",
  );
  const names = readdirSync(folder);
  check(
    names.length <= 1000,
    "EXECUTION_LIMIT",
    "Review managed-build execution state before starting more runs",
  );
  return names.flatMap((name) => {
    const file = fence(folder, name);
    check(
      lstatSync(file).isFile(),
      "EXECUTION_STATE",
      "Invalid managed-build access entry",
    );
    if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\.json\.[a-f0-9-]{36}\.tmp$/.test(name))
      return [];
    check(
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\.json$/.test(name),
      "EXECUTION_STATE",
      "Invalid managed-build access entry",
    );
    let value: Lease;
    try {
      value = leaseSchema.parse(readBounded(file));
    } catch {
      throw new Problem(
        "EXECUTION_STATE",
        "Invalid managed-build execution claim",
      );
    }
    check(
      name === value.id + ".json" &&
        new Set(value.flows).size === value.flows.length,
      "EXECUTION_STATE",
      "Invalid managed-build execution identity",
    );
    return [{ file, value }];
  });
}
export function assertBuildIdle(directory: string) {
  const active = leases(directory);
  check(
    !active.length,
    "EXECUTION_ACTIVE",
    `Run ${active[0]?.value.id} still owns this managed build; inspect run_status and recover that run before rebuilding`,
  );
}
export function prepareBuildExecution<
  T extends { flows: string[]; fingerprint: string; resources?: string[] },
>(
  directory: string,
  runId: string,
  recovery: "none" | "indeterminate" | "finished",
  review: () => T,
) {
  return withBuildGuard(
    directory,
    () => {
      const boundary = review(),
        selected = new Set(boundary.flows),
        resources = new Set(boundary.resources ?? []),
        rows = leases(directory),
        own = rows.find((r) => r.value.id === runId);
      if (own) {
        check(
          recovery !== "none" &&
            own.value.fingerprint === boundary.fingerprint &&
            JSON.stringify([...own.value.flows].sort()) ===
              JSON.stringify([...selected].sort()) &&
            JSON.stringify(own.value.resources ?? []) ===
              JSON.stringify([...resources].sort()),
          "EXECUTION_ACTIVE",
          "Recover the original run and unchanged build before starting this work",
        );
        check(
          (recovery === "finished" ||
            own.value.ownerFinished === true ||
            !alive(own.value.pid)) &&
            (!own.value.childPid || !alive(own.value.childPid, true)),
          "EXECUTION_ACTIVE",
          "The original execution process group is still active; its build ownership was not released",
        );
      }
      const conflicting = rows.find(
        (r) =>
          r !== own &&
          (r.value.flows.some((flow) => selected.has(flow)) ||
            (r.value.resources ?? []).some((resource) =>
              resources.has(resource),
            )),
      );
      check(
        !conflicting,
        "EXECUTION_ACTIVE",
        `Run ${conflicting?.value.id} owns a selected flow or resource in this managed build; inspect and recover that run first`,
      );
      check(
        rows.length < 500 || !!own,
        "EXECUTION_LIMIT",
        "Review managed-build execution state before starting more runs",
      );
      const folder = fence(directory, ".ingestron-execution");
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const file = fence(folder, id.parse(runId) + ".json"),
        lease = leaseSchema.parse({
          apiVersion: "ingestron.build-access/v1",
          id: runId,
          token: randomUUID(),
          pid: process.pid,
          childPid: null,
          phase: "active",
          ...(own ? { recoveryPending: true } : {}),
          flows: [...selected],
          fingerprint: boundary.fingerprint,
          ...(resources.size ? { resources: [...resources].sort() } : {}),
        });
      save(file, lease);
      const owned = () => {
        const value = leaseSchema.parse(readBounded(file));
        check(
          value.token === lease.token,
          "EXECUTION_OWNER",
          "This operation no longer owns its managed-build claim",
        );
        return value;
      };
      return {
        boundary,
        access: {
          inheritedUncertainty: !!own,
          attachChild(pid: number) {
            withBuildGuard(
              directory,
              () => {
                const value = owned();
                value.childPid = pid;
                save(file, leaseSchema.parse(value));
              },
              runId,
            );
          },
          async finish(success = true, uncertain = false) {
            for (let attempt = 0; ; attempt++) {
              try {
                withBuildGuard(
                  directory,
                  () => {
                    if (!existsSync(file)) return;
                    const value = leaseSchema.parse(readBounded(file));
                    if (value.token !== lease.token) return;
                    if (uncertain) value.recoveryPending = true;
                    if (
                      (value.childPid && alive(value.childPid, true)) ||
                      (value.recoveryPending && !success)
                    ) {
                      value.phase = "uncertain";
                      value.ownerFinished = true;
                      save(file, value);
                    } else rmSync(file);
                  },
                  runId,
                );
                return;
              } catch (error) {
                if (
                  !(error instanceof Problem) ||
                  error.code !== "BUILD_BUSY" ||
                  attempt >= 39
                )
                  throw error;
                await new Promise<void>((done) => setTimeout(done, 50));
              }
            }
          },
        },
      };
    },
    runId,
  );
}
