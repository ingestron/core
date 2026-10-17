/** Package review and registration share the installed lock and core proposal path. */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { stringify } from "yaml";
import { browseProviders } from "./installed-plugins.js";
import {
  installPackage,
  resolvePackage,
  packageYaml,
  packageLock,
  fence,
} from "./packages.js";
import { providerReference } from "../plugins/authoring.js";
import { preview } from "./authoring.js";
import { check, canonical, digest } from "./errors.js";
import { Configuration } from "./config.js";
import { auditSecrets } from "./planner.js";
import { pluginConfigure, identifier } from "./workflows.js";
import { configurePack } from "./ecosystem-authoring.js";

const kind = z.enum([
  "provider",
  "connector",
  "model-pack",
  "activity-pack",
  "report-pack",
]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const packageInstallReviewSchema = z
  .object({
    reference: z.string().min(1).max(500),
    fromGit: z.string().optional(),
    tagPrefix: z
      .string()
      .regex(/^[a-z0-9-]*$/)
      .optional(),
  })
  .strict();
const installProposal = z
  .object({
    reference: z
      .string()
      .max(500)
      .regex(
        /@(?:[a-f0-9]{40}|(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/,
      ),
    revision: hash,
    packageDigest: hash,
    id: z.string(),
    version: z.string(),
    kind,
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    files: z.number().int().positive(),
    tagPrefix: z
      .string()
      .max(100)
      .regex(/^[a-z0-9-]*$/)
      .optional(),
  })
  .strict();
export const packageInstallApplySchema = z
  .object({ proposal: installProposal, fromGit: z.string().optional() })
  .strict();
export const packageConfigureSchema = z
  .object({
    reference: z.string().min(1).max(500),
    name: identifier,
    provider: identifier.optional(),
    update: z.boolean().optional(),
  })
  .strict();

export function inspectPackageLibrary(root: string) {
  const project = new Configuration(root, {}).load();
  return {
    apiVersion: "ingestron.package-library/v1",
    providers: Object.keys(project.providers?.configurations ?? {}),
    packages: browseProviders(root).map((p) => {
      const manifest = packageYaml(resolvePackage(root, p.reference).file);
      return {
        ...p,
        configuration:
          p.kind === "provider"
            ? manifest.platformBinding
              ? "target"
              : manifest.lifecycle ||
                  (manifest.commands?.execution === "offline-json" &&
                    !manifest.planner &&
                    !manifest.renderer &&
                    !manifest.configurationSchema)
                ? "provider"
                : "none"
            : p.kind === "report-pack"
              ? "none"
              : p.kind,
        presentation:
          p.kind === "report-pack" ||
          !!manifest.commands?.definitions?.some(
            (d: any) => d.name === "report build",
          ),
        dependencies:
          typeof manifest.model === "string" ? [manifest.model] : [],
      };
    }),
  };
}
export function reviewPackageInstall(
  root: string,
  input: z.infer<typeof packageInstallReviewSchema>,
) {
  input = packageInstallReviewSchema.parse(input);
  const revision = preview(root, {}).revision;
  const temporary = mkdtempSync(join(tmpdir(), "ingestron-package-review-"));
  try {
    const installed = installPackage(temporary, input.reference, {
      fromGit: input.fromGit,
      tagPrefix: input.tagPrefix,
    });
    const selected = browseProviders(temporary).find(
      (p) => p.reference === installed.reference,
    );
    check(
      selected,
      "PACKAGE",
      "Choose a supported provider, connector, model, report or activity package",
    );
    if (selected.kind === "provider")
      providerReference(temporary, installed.reference);
    const { repository, path, commit, files } = installed;
    const manifest = packageYaml(
      resolvePackage(temporary, installed.reference).file,
    );
    return {
      proposal: {
        reference: installed.reference,
        revision,
        packageDigest: digest(canonical({ repository, path, commit, files })),
        id: selected.id,
        version: selected.version,
        kind: selected.kind,
        commit,
        files: Object.keys(files).length,
        ...(input.tagPrefix ? { tagPrefix: input.tagPrefix } : {}),
      },
      manifestText: readFileSync(
        resolvePackage(temporary, installed.reference).file,
        "utf8",
      ),
      lockFile: {
        path: "packages.lock.yaml",
        before: existsSync(fence(root, "packages.lock.yaml"))
          ? readFileSync(fence(root, "packages.lock.yaml"), "utf8")
          : null,
        after: stringify({
          ...packageLock(root),
          packages: {
            ...packageLock(root).packages,
            [installed.reference]: { repository, path, commit, files },
          },
        }),
      },
      connector:
        manifest.apiVersion === "ingestron.connector/v1" ? manifest : undefined,
      licence: selected.licence,
      dependencies: typeof manifest.model === "string" ? [manifest.model] : [],
      writes: [
        "packages.lock.yaml",
        ".ingestron/packages",
        ".ingestron/plugin-info",
      ],
      executionEnabled: false,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
export function applyPackageInstall(
  root: string,
  input: z.infer<typeof packageInstallApplySchema>,
) {
  input = packageInstallApplySchema.parse(input);
  const { proposal } = input;
  const checkRevision = () =>
    check(
      preview(root, {}).revision === proposal.revision,
      "STALE",
      "Project or package lock changed; review installation again",
    );
  checkRevision();
  const result = installPackage(root, proposal.reference, {
    fromGit: input.fromGit,
    tagPrefix: proposal.tagPrefix,
    reviewed: { packageDigest: proposal.packageDigest, checkRevision },
  });
  return {
    installed: true,
    reference: result.reference,
    commit: result.commit,
  };
}
export function reviewPackageConfiguration(
  root: string,
  args: z.infer<typeof packageConfigureSchema>,
) {
  args = packageConfigureSchema.parse(args);
  const project = new Configuration(root, {}).load();
  auditSecrets(project.connections, "connections");
  auditSecrets(project.environments, "environments");
  const selected = inspectPackageLibrary(root).packages.find(
    (p) => p.reference === args.reference,
  );
  check(selected, "PACKAGE", "Choose an exact installed package");
  check(
    !["none", "target"].includes(selected.configuration),
    "CAPABILITY",
    selected.configuration === "target"
      ? "Use shared target setup to preserve platform ownership"
      : "Select this package in the presentation builder",
  );
  check(
    args.provider === undefined ||
      ["model-pack", "activity-pack"].includes(selected.kind),
    "INPUT",
    "Provider selection applies only to model and activity packs",
  );
  check(
    args.update === undefined ||
      ["provider", "connector"].includes(selected.kind),
    "INPUT",
    "Update applies only to provider and connector configuration",
  );
  return ["provider", "connector"].includes(selected.kind)
    ? pluginConfigure(root, args)
    : configurePack(root, args);
}
