/** Offline generation review. Re-render on apply; never accept client-supplied assets. */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonical, check, digest } from "./errors.js";
import { fence } from "./packages.js";
import { programmeSourceSchema } from "./platform-binding.js";
import { renderProjectBuild } from "./project-build.js";
import { writeOutput, inspectOutputOwnership } from "./generate.js";

export const buildReviewSchema = z
  .object({
    programme: programmeSourceSchema.optional(),
    provider: z.string().optional(),
    flow: z.string().optional(),
    profile: z.string().optional(),
    out: z.string().default("build/generated"),
  })
  .strict();
export const buildApplySchema = z
  .object({
    programme: programmeSourceSchema.optional(),
    proposal: z.unknown(),
  })
  .strict();

/** Includes unowned files so a review cannot silently supersede another export. */
function outputState(directory: string) {
  const files: Record<string, string> = {};
  let count = 0,
    bytes = 0;
  const walk = (at: string, prefix: string) => {
    const stat = lstatSync(at);
    check(
      !stat.isSymbolicLink() && stat.isDirectory(),
      "PATH",
      "Output review requires ordinary directories",
    );
    for (const name of readdirSync(at).sort()) {
      if (!prefix && name === ".ingestron-generate.lock") continue;
      check(++count <= 12000, "LIMIT", "Output review exceeds 12000 entries");
      const path = prefix + name,
        file = join(at, name),
        info = lstatSync(file);
      check(
        !info.isSymbolicLink(),
        "PATH",
        "Output review cannot cross symlinks",
      );
      if (info.isDirectory()) walk(file, path + "/");
      else {
        check(
          info.isFile() && (bytes += info.size) <= 32 * 1024 * 1024,
          "LIMIT",
          "Output review exceeds 32 MiB or contains a special file",
        );
        files[path] = digest(readFileSync(file));
      }
    }
  };
  if (existsSync(directory)) walk(directory, "");
  return files;
}

function reviewed(root: string, environment: string, input: unknown) {
  const args = buildReviewSchema.parse(input);
  const directory = fence(root, args.out);
  check(
    directory !== realpathSync(root),
    "PATH",
    "Generate into a dedicated output folder",
  );
  const previous = outputState(directory);
  const rendered = renderProjectBuild(root, environment, args);
  check(
    rendered.metadata.includedFlows.length > 0,
    "BUILD",
    "Define a deliverable flow before generating assets",
  );
  const { previous: owned } = inspectOutputOwnership(
    directory,
    rendered.plan,
    rendered.files,
  );
  const files = Object.fromEntries(
    Object.entries(rendered.files).map(([name, content]) => [
      name,
      digest(name.endsWith(".whl") ? Buffer.from(content, "base64") : content),
    ]),
  );
  const body = {
    apiVersion: "ingestron.build-review/v1",
    rootDigest: digest(realpathSync(root)),
    environment,
    // The host supplies programme authority again on apply; it is never taken from the proposal.
    args: {
      ...args,
      programme: args.programme
        ? {
            id: args.programme.id,
            rootDigest: digest(realpathSync(args.programme.root)),
          }
        : undefined,
    },
    project: rendered.plan.project,
    buildDigest: rendered.plan.digest,
    outputDigest: digest(canonical(previous)),
    directory: args.out,
    files,
    changes: [
      ...Object.keys(files)
        .sort()
        .map((path) => ({
          path,
          action: previous[path]
            ? previous[path] === files[path]
              ? "unchanged"
              : "update"
            : "create",
        })),
      ...Object.keys(owned?.files ?? {})
        .filter((path) => !Object.hasOwn(files, path))
        .sort()
        .map((path) => ({ path, action: "remove" })),
    ],
    flows: rendered.metadata.includedFlows,
    packages: rendered.metadata.packages.map((p) => ({
      configuration: p.configuration,
      reference: p.reference,
      commit: p.commit,
    })),
    dataProducts: rendered.metadata.dataProducts.map((p) => ({
      name: p.name,
      contract: p.contract,
    })),
    deploymentExecuted: false,
  };
  const proposal = JSON.parse(
    JSON.stringify({ ...body, digest: digest(canonical(body)) }),
  );
  return { args, directory, rendered, proposal };
}

export function reviewBuild(root: string, environment: string, args: unknown) {
  return reviewed(root, environment, args).proposal;
}

export function applyBuild(root: string, environment: string, input: unknown) {
  const { programme, proposal } = buildApplySchema.parse(input);
  check(
    proposal && typeof proposal === "object" && "args" in proposal,
    "BUILD",
    "Invalid generation review",
  );
  const p = proposal as any;
  const current = reviewed(root, environment, { ...p.args, programme });
  check(
    canonical(current.proposal) === canonical(p),
    "STALE",
    "Generation inputs, compiler, packages or output changed; review again",
  );
  const output = writeOutput(
    current.directory,
    current.rendered.plan,
    current.rendered.files,
    "managed",
    () => {
      check(
        digest(canonical(outputState(current.directory))) ===
          current.proposal.outputDigest,
        "STALE",
        "Output changed since review; review again",
      );
    },
  );
  return {
    ...output,
    directory: current.args.out,
    ...current.rendered.result,
    applied: true,
  };
}
