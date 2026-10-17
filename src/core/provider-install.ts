import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { check, canonical, digest } from "./errors.js";
import { installPackage } from "./packages.js";
import { providerReference } from "../plugins/authoring.js";
import { preview } from "./authoring.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const providerInstallSchema = z
  .object({
    reference: z.string().min(1).max(500),
    fromGit: z.string().optional(),
  })
  .strict();
const proposalSchema = z
  .object({
    reference: z.string().regex(/@[a-f0-9]{40}$/),
    revision: hash,
    packageDigest: hash,
    id: z.string(),
    version: z.string(),
    platform: z.string(),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    files: z.number().int().positive(),
  })
  .strict();
export const providerInstallApplySchema = z
  .object({ proposal: proposalSchema, fromGit: z.string().optional() })
  .strict();
export function reviewProviderInstall(
  root: string,
  input: z.infer<typeof providerInstallSchema>,
) {
  input = providerInstallSchema.parse(input);
  const revision = preview(root, {}).revision;
  const temporary = mkdtempSync(join(tmpdir(), "ingestron-provider-review-"));
  try {
    const installed = installPackage(temporary, input.reference, {
      kind: "provider",
      fromGit: input.fromGit,
    });
    const provider = providerReference(temporary, installed.reference);
    check(
      provider.manifest.platformBinding,
      "PROVIDER",
      "Provider does not declare guided resource bindings",
    );
    const { repository, path, commit, files } = installed;
    return {
      proposal: {
        reference: `${repository}/${path}@${commit}`,
        revision,
        packageDigest: digest(canonical({ repository, path, commit, files })),
        id: provider.manifest.id,
        version: provider.manifest.version,
        platform: provider.manifest.platform,
        commit,
        files: Object.keys(files).length,
      },
      writes: [
        "packages.lock.yaml",
        ".ingestron/packages",
        "plugin-information",
      ],
      executionEnabled: false,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
export function applyProviderInstall(
  root: string,
  input: z.infer<typeof providerInstallApplySchema>,
) {
  input = providerInstallApplySchema.parse(input);
  const proposal = input.proposal;
  const checkRevision = () =>
    check(
      preview(root, {}).revision === proposal.revision,
      "STALE",
      "Project or package lock changed; review installation again",
    );
  checkRevision();
  const result = installPackage(root, proposal.reference, {
    kind: "provider",
    fromGit: input.fromGit,
    reviewed: { packageDigest: proposal.packageDigest, checkRevision },
  });
  return {
    installed: true,
    reference: result.reference,
    commit: result.commit,
  };
}
