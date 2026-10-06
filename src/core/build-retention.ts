/** Retain opaque managed-build bytes; providers and sources own their meaning. */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { z } from "zod";
import { check, canonical, digest } from "./errors.js";
import { fence } from "./packages.js";
import { validateOutput } from "./generate.js";
import { assertBuildIdle, withBuildGuard } from "./build-access.js";
import type { Context } from "./operations.js";

const receiptName = ".ingestron-retained-build.json";
const maximumFiles = 10000,
  maximumBytes = 256 * 1024 * 1024;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(2048);
export const buildRetainSchema = z
  .object({
    from: path.default("build/generated"),
    to: path,
    profile: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/)
      .optional(),
  })
  .strict();
export const buildRetainedSchema = z.object({ directory: path }).strict();
const receiptSchema = z
  .object({
    apiVersion: z.literal("ingestron.retained-build/v1"),
    project: z.string().min(1).max(100),
    environment: z.string().min(1).max(100),
    source: path,
    planDigest: sha,
    contentDigest: sha,
    directories: z.array(path).max(maximumFiles),
    files: z.record(
      path,
      z
        .object({
          sha256: sha,
          bytes: z.number().int().min(0).max(maximumBytes),
        })
        .strict(),
    ),
    bytes: z.number().int().min(0).max(maximumBytes),
  })
  .strict();
function occupied(file: string) {
  try {
    lstatSync(file);
    return true;
  } catch (error: any) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function inventory(directory: string) {
  const files: Record<string, { sha256: string; bytes: number }> = {};
  const directories: string[] = [];
  let bytes = 0,
    entries = 0;
  function walk(folder: string, depth: number) {
    check(
      depth <= 20,
      "LIMIT",
      "Build retention exceeds directory depth limits",
    );
    for (const name of readdirSync(folder).sort()) {
      const location = relative(directory, resolve(folder, name));
      // Coordination records are host state, never part of a retained build.
      if (
        location === receiptName ||
        location === ".ingestron-generate.lock" ||
        location === ".ingestron-execution"
      )
        continue;
      check(
        ++entries <= maximumFiles,
        "LIMIT",
        "Build retention exceeds 10000 entries",
      );
      const file = fence(directory, location),
        stat = lstatSync(file);
      check(
        !stat.isSymbolicLink(),
        "PATH",
        "Retained builds cannot contain symlinks",
      );
      if (stat.isDirectory()) {
        directories.push(location);
        walk(file, depth + 1);
      } else {
        check(stat.isFile(), "PATH", "Retained builds require regular files");
        bytes += stat.size;
        check(
          bytes <= maximumBytes,
          "LIMIT",
          "Build retention exceeds 256 MiB; review the output before retaining it",
        );
        const content = readFileSync(file);
        check(
          content.length === stat.size,
          "STALE",
          "Build changed during retention",
        );
        files[location] = { sha256: digest(content), bytes: stat.size };
      }
    }
  }
  walk(directory, 0);
  return { directories: directories.sort(), files, bytes };
}
/** Legacy manually retained builds remain supported; sealed baselines fail closed. */
export function validateRetainedBuild(directory: string): string | undefined {
  const file = fence(directory, receiptName);
  if (!occupied(file)) return undefined;
  check(
    lstatSync(file).isFile() && lstatSync(file).size <= 2_000_000,
    "LIMIT",
    "Retained build receipt exceeds limits",
  );
  const receipt = receiptSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const { contentDigest, ...body } = receipt;
  check(
    digest(canonical(body)) === contentDigest,
    "STALE",
    "Retained build receipt changed",
  );
  const current = inventory(directory);
  check(
    canonical(current) ===
      canonical({
        directories: receipt.directories,
        files: receipt.files,
        bytes: receipt.bytes,
      }),
    "STALE",
    "Retained build content changed; preserve the original baseline",
  );
  return contentDigest;
}
export function retainBuild(
  context: Context,
  args: z.infer<typeof buildRetainSchema>,
) {
  const root = resolve(context.root),
    source = fence(root, args.from),
    target = fence(root, args.to);
  const nested = (a: string, b: string) => {
    const name = relative(a, b);
    return name === "" || (!name.startsWith("..") && !name.startsWith("/"));
  };
  check(
    !nested(source, target) && !nested(target, source),
    "SELECT",
    "Retain the build in a separate, non-nested directory",
  );
  check(
    existsSync(source) && lstatSync(source).isDirectory(),
    "BUILD",
    "Select an existing managed build to retain",
  );
  check(
    !occupied(fence(source, receiptName)),
    "SELECT",
    "Select the working build, rather than an existing retained baseline",
  );
  return withBuildGuard(source, () => {
    assertBuildIdle(source);
    const managed = validateOutput(source);
    check(
      managed.ownership === "managed",
      "OWNERSHIP",
      "Retention requires an unchanged managed build",
    );
    const metadata = fence(source, "ingestron-project.json");
    check(
      lstatSync(metadata).isFile() && lstatSync(metadata).size <= 2_000_000,
      "LIMIT",
      "Build metadata exceeds retention limits",
    );
    const build = JSON.parse(readFileSync(metadata, "utf8"));
    check(
      build.apiVersion === "ingestron.project-build/v1" &&
        build.environment === (context.environment ?? "dev") &&
        typeof build.project === "string",
      "BUILD",
      "Build environment differs from the selected project environment",
    );
    check(
      (build.selection?.profile ?? "") === (args.profile ?? ""),
      "PROFILE",
      "Select the original build profile before retaining it",
    );
    check(
      build.sourceFiles &&
        typeof build.sourceFiles === "object" &&
        !Array.isArray(build.sourceFiles),
      "BUILD",
      "Build input provenance is missing",
    );
    for (const [name, expected] of Object.entries(build.sourceFiles))
      check(
        digest(readFileSync(fence(root, name))) === expected,
        "STALE",
        "Project inputs changed; retain the build before editing or upgrading the project",
      );
    check(
      digest(readFileSync(fence(root, "packages.lock.yaml"))) ===
        build.packageLockSha256,
      "STALE",
      "Package lock changed; retain the build before upgrading packages",
    );
    const original = inventory(source);
    const body = {
      apiVersion: "ingestron.retained-build/v1" as const,
      project: build.project,
      environment: build.environment,
      source: relative(root, source),
      planDigest: managed.planDigest,
      ...original,
    };
    const receipt = receiptSchema.parse({
      ...body,
      contentDigest: digest(canonical(body)),
    });
    const receiptText = JSON.stringify(receipt, null, 2) + "\n";
    check(
      Buffer.byteLength(receiptText) <= 2_000_000,
      "LIMIT",
      "Retained build receipt exceeds 2 MB; review the output before retaining it",
    );
    const parent = dirname(target);
    return withBuildGuard(parent, () => {
      check(
        !occupied(fence(root, args.to)),
        "OWNER",
        "Retained build destination already exists; choose a new directory",
      );
      const stage = mkdtempSync(resolve(parent, ".retain-"));
      try {
        chmodSync(stage, 0o700);
        for (const name of original.directories)
          mkdirSync(fence(stage, name), { recursive: true, mode: 0o700 });
        for (const name of Object.keys(original.files)) {
          const input = fence(source, name),
            output = fence(stage, name);
          mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
          copyFileSync(input, output);
          chmodSync(output, 0o600 | (lstatSync(input).mode & 0o111));
        }
        check(
          canonical(inventory(stage)) === canonical(original) &&
            canonical(inventory(source)) === canonical(original),
          "STALE",
          "Build changed during retention; no baseline was published",
        );
        writeFileSync(fence(stage, receiptName), receiptText, {
          mode: 0o600,
          flag: "wx",
        });
        check(
          !occupied(fence(root, args.to)),
          "OWNER",
          "Retained build destination appeared during retention",
        );
        renameSync(stage, target);
      } finally {
        if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
      }
      return {
        apiVersion: receipt.apiVersion,
        source: relative(root, source),
        directory: relative(root, target),
        planDigest: receipt.planDigest,
        contentDigest: receipt.contentDigest,
        files: Object.keys(original.files).length,
        bytes: original.bytes,
      };
    });
  });
}

/** Inspect a sealed historical baseline without requiring current project inputs. */
export function inspectRetainedBuild(
  context: Context,
  args: z.infer<typeof buildRetainedSchema>,
) {
  const directory = fence(resolve(context.root), args.directory);
  const contentDigest = validateRetainedBuild(directory);
  check(
    contentDigest,
    "BUILD",
    "Select a sealed retained build created by build_retain",
  );
  const receipt = receiptSchema.parse(
    JSON.parse(readFileSync(fence(directory, receiptName), "utf8")),
  );
  const managed = validateOutput(directory);
  check(
    managed.ownership === "managed" &&
      managed.planDigest === receipt.planDigest,
    "OWNERSHIP",
    "Retained baseline no longer matches its managed build",
  );
  const file = fence(directory, "ingestron-project.json");
  check(
    lstatSync(file).isFile() && lstatSync(file).size <= 2_000_000,
    "LIMIT",
    "Retained metadata exceeds inspection limits",
  );
  const build = JSON.parse(readFileSync(file, "utf8"));
  check(
    build.apiVersion === "ingestron.project-build/v1" &&
      build.project === receipt.project &&
      build.environment === receipt.environment &&
      receipt.environment === (context.environment ?? "dev"),
    "BUILD",
    "Retained build belongs to another environment or project",
  );
  return {
    apiVersion: receipt.apiVersion,
    project: receipt.project,
    environment: receipt.environment,
    profile: build.selection?.profile ?? "",
    source: receipt.source,
    directory: args.directory,
    planDigest: receipt.planDigest,
    contentDigest,
    files: Object.keys(receipt.files).length,
    bytes: receipt.bytes,
  };
}
