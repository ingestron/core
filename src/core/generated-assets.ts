/** Read-only saved output inspection. Freshness is derived, never a UI receipt. */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { check, digest, Problem } from "./errors.js";
import { fence } from "./packages.js";
import { programmeSourceSchema } from "./platform-binding.js";
import { inspectProject } from "./planner.js";
import { reviewBuild } from "./build-review.js";

const relativeFile = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (path) =>
      !/[\\:\u0000-\u001f\u007f]/.test(path) &&
      path.split("/").every((part) => part && part !== "." && part !== ".."),
  );
export const buildStatusSchema = z
  .object({
    programme: programmeSourceSchema.optional(),
    flow: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/)
      .optional(),
    profile: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/)
      .optional(),
    out: relativeFile.default("build/generated"),
  })
  .strict();
export const buildFileSchema = z
  .object({
    out: relativeFile.default("build/generated"),
    path: relativeFile,
  })
  .strict();
const manifestSchema = z.object({
  apiVersion: z.literal("ingestron.output/v1"),
  project: z.string(),
  environment: z.string(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  ownership: z.enum(["managed", "team"]).optional(),
  files: z.record(relativeFile, z.string().regex(/^[a-f0-9]{64}$/)),
});
function inventory(root: string, environment: string, out: string) {
  const directory = fence(root, out);
  check(
    directory !== realpathSync(root),
    "PATH",
    "Use a dedicated output folder",
  );
  const manifestPath = fence(root, join(out, "ingestron-manifest.json"));
  if (!existsSync(manifestPath))
    return { directory, manifest: undefined, files: [] };
  check(
    lstatSync(manifestPath).isFile() &&
      lstatSync(manifestPath).size <= 2 * 1024 * 1024,
    "LIMIT",
    "Invalid output manifest",
  );
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  );
  check(
    manifest.environment === environment,
    "OWNER",
    "Output belongs to another environment",
  );
  const entries = Object.entries(manifest.files);
  check(entries.length <= 10000, "LIMIT", "Too many output files");
  let bytes = 0;
  const files = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, expected]) => {
      const file = fence(root, join(out, path));
      if (!existsSync(file))
        return { path, state: "missing" as const, size: 0, previewable: false };
      const stat = lstatSync(file);
      check(
        stat.isFile() && (bytes += stat.size) <= 32 * 1024 * 1024,
        "LIMIT",
        "Output inventory exceeds safe limits",
      );
      const content = readFileSync(file);
      return {
        path,
        state:
          digest(content) === expected
            ? ("saved" as const)
            : ("modified" as const),
        size: content.length,
        previewable:
          content.length <= 256 * 1024 &&
          !content.includes(0) &&
          !path.endsWith(".whl"),
      };
    });
  return { directory, manifest, files };
}
export function inspectBuild(
  root: string,
  environment: string,
  input: unknown,
) {
  const args = buildStatusSchema.parse(input);
  let selections: { flow: string; profile: string; provider: string }[] = [];
  try {
    selections = inspectProject(root, environment, { draft: true })
      .flows.flatMap((f) =>
        Object.entries(f.executionProfiles).map(([profile, p]) => ({
          flow: f.id,
          profile,
          provider: p.provider,
        })),
      )
      .slice(0, 1000);
  } catch {
    /* Saved files remain available with invalid definitions. */
  }
  const base = {
    apiVersion: "ingestron.build-status/v1",
    environment,
    directory: args.out,
    deploymentExecuted: false,
    selections,
  };
  let saved;
  try {
    saved = inventory(root, environment, args.out);
  } catch (error) {
    return {
      ...base,
      status: "unavailable",
      files: [],
      diagnostic: error instanceof Problem ? error.code : "MANIFEST",
    };
  }
  const summary = {
    ...base,
    files: saved.files,
    digest: saved.manifest?.planDigest,
  };
  if (saved.files.some((file) => file.state !== "saved"))
    return { ...summary, status: "conflict", diagnostic: "CONFLICT" };
  if (saved.manifest?.ownership === "team")
    return { ...summary, status: "conflict", diagnostic: "OWNER" };
  try {
    const proposal = reviewBuild(root, environment, args);
    return {
      ...summary,
      status: !saved.manifest
        ? "not-generated"
        : proposal.changes.some(
              (file: { action: string }) => file.action !== "unchanged",
            )
          ? "outdated"
          : "current",
    };
  } catch (error) {
    const diagnostic = error instanceof Problem ? error.code : "VALIDATION";
    return {
      ...summary,
      status: ["CONFLICT", "OWNER"].includes(diagnostic)
        ? "conflict"
        : "unavailable",
      diagnostic,
    };
  }
}
export function readBuildFile(
  root: string,
  environment: string,
  input: unknown,
) {
  const args = buildFileSchema.parse(input),
    saved = inventory(root, environment, args.out);
  const entry = saved.files.find((file) => file.path === args.path);
  check(
    entry && entry.state !== "missing" && entry.previewable,
    "OUTPUT",
    "Select an existing text file from the saved output manifest",
  );
  const content = readFileSync(fence(root, join(args.out, args.path)));
  check(
    content.length <= 256 * 1024 && !content.includes(0),
    "LIMIT",
    "Output preview requires bounded text",
  );
  return {
    path: args.path,
    content: content.toString("utf8"),
    digest: digest(content),
  };
}
