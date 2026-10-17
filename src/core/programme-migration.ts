import { existsSync, readdirSync, realpathSync } from "node:fs";
import { z } from "zod";
import { canonical, check, digest } from "./errors.js";
import { programmeReadSchema, programmeSchema } from "./programme-schema.js";
import { withWorkItemKeys } from "./programme-keys.js";
import {
  loadProgrammeStorage,
  programmeYamlFiles,
  programmeBytes,
  programmePath,
} from "./programme-storage.js";
import {
  assertProgrammeReadable,
  programmeTransaction,
  withProgrammeWrite,
} from "./programme-transaction.js";
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const programmeMigrationSchema = programmeReadSchema
  .extend({
    direction: z.enum(["to-yaml", "restore-json"]),
    migration: sha.optional(),
  })
  .strict();
export const programmeMigrationApplySchema = programmeReadSchema
  .extend({ proposal: z.unknown() })
  .strict();
const receiptSchema = z
  .object({
    apiVersion: z.literal("ingestron.programme-migration/v1"),
    programmeId: z.string(),
    sourceDigest: sha,
    definitionDigest: sha,
    files: z.record(z.string(), sha),
  })
  .strict();
const hashFiles = (files: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(files).map(([name, raw]) => [name, digest(raw)]),
  );
function backupPaths(migration: string) {
  sha.parse(migration);
  return {
    original: `.programme-migrations/${migration}/programme.json`,
    receipt: `.programme-migrations/${migration}/receipt.json`,
  };
}
function readBackup(root: string, migration: string) {
  const paths = backupPaths(migration),
    raw = programmeBytes(root, paths.original),
    receipt = programmeBytes(root, paths.receipt);
  check(
    raw !== null && receipt !== null && digest(raw) === migration,
    "BACKUP",
    "Migration backup is missing or changed",
  );
  const metadata = receiptSchema.parse(JSON.parse(receipt));
  check(
    metadata.sourceDigest === migration,
    "BACKUP",
    "Migration receipt identity changed",
  );
  return { paths, raw, metadata };
}
export function inspectProgrammeStorage(root: string, id: string) {
  assertProgrammeReadable(root);
  const state = loadProgrammeStorage(root, id),
    directory = programmePath(root, ".programme-migrations");
  const candidates = existsSync(directory) ? readdirSync(directory) : [];
  check(
    candidates.length <= 100,
    "LIMIT",
    "Review programme migration history before adding more backups",
  );
  return {
    apiVersion: "ingestron.programme-storage/v1",
    format: state.format,
    sourceDigest: state.digest,
    definitionDigest: state.document ? digest(canonical(state.document)) : null,
    files: hashFiles(state.files),
    rollback: candidates
      .filter((name) => sha.safeParse(name).success)
      .map((migration) => {
        try {
          const backup = readBackup(root, migration);
          return {
            migration,
            eligible:
              state.format === "yaml" &&
              backup.metadata.programmeId === id &&
              canonical(backup.metadata.files) ===
                canonical(hashFiles(state.files)),
          };
        } catch {
          return { migration, eligible: false };
        }
      }),
    executionEnabled: false,
  };
}
function prepareMigration(root: string, input: unknown) {
  assertProgrammeReadable(root);
  const args = programmeMigrationSchema.parse(input),
    state = loadProgrammeStorage(root, args.id);
  check(
    state.document && state.digest,
    "PROGRAMME",
    "Save a programme before reviewing migration",
  );
  let after: Record<string, string | null>, migration: string;
  const before: Record<string, string | null> = { ...state.files };
  if (args.direction === "to-yaml") {
    check(
      !args.migration && state.format === "json",
      "MIGRATION",
      "Migration requires one legacy programme.json authority",
    );
    migration = state.digest;
    const files = programmeYamlFiles(state.document),
      paths = backupPaths(migration);
    const receipt = {
      apiVersion: "ingestron.programme-migration/v1",
      programmeId: args.id,
      sourceDigest: state.digest,
      definitionDigest: digest(canonical(state.document)),
      files: hashFiles(files),
    };
    after = {
      ...files,
      [paths.original]: state.files["programme.json"],
      [paths.receipt]: JSON.stringify(receipt, null, 2) + "\n",
      "programme.json": null,
    };
    for (const [name, value] of Object.entries(after)) {
      if (Object.hasOwn(before, name)) continue;
      const existing = programmeBytes(root, name);
      check(
        existing === null ||
          ((name === paths.original || name === paths.receipt) &&
            existing === value),
        "OWNER",
        "Migration would overwrite an existing definition or backup file",
      );
      before[name] = existing;
    }
  } else {
    check(
      state.format === "yaml" && args.migration,
      "MIGRATION",
      "Choose the backup of the YAML migration to restore",
    );
    migration = args.migration;
    const backup = readBackup(root, migration);
    check(
      backup.metadata.programmeId === args.id &&
        canonical(backup.metadata.files) === canonical(hashFiles(state.files)),
      "STALE",
      "YAML changed after migration; rollback cannot discard later edits",
    );
    const original = withWorkItemKeys(
      programmeSchema.parse(JSON.parse(backup.raw)),
    );
    check(
      canonical(original) === canonical(state.document) &&
        digest(canonical(original)) === backup.metadata.definitionDigest,
      "BACKUP",
      "Backup no longer matches the migrated programme",
    );
    check(
      programmeBytes(root, "programme.json") === null,
      "OWNER",
      "Rollback cannot overwrite another JSON authority",
    );
    before["programme.json"] = null;
    before[backup.paths.original] = backup.raw;
    before[backup.paths.receipt] = programmeBytes(root, backup.paths.receipt);
    after = {
      "programme.json": backup.raw,
      ...Object.fromEntries(
        Object.keys(state.files).map((name) => [name, null]),
      ),
    };
  }
  const body = {
    apiVersion: "ingestron.programme-migration-review/v1",
    request: args,
    rootDigest: digest(realpathSync(root)),
    inputs: Object.fromEntries(
      Object.entries(before).map(([path, raw]) => [
        path,
        raw === null ? null : digest(raw),
      ]),
    ),
    sourceDigest: state.digest,
    definitionDigest: digest(canonical(state.document)),
    migration,
    minimumCoreVersion: "0.12.60",
    from: state.format,
    to: args.direction === "to-yaml" ? "yaml" : "json",
    workItems: state.document.requirements.length,
    projectIds: state.document.projects.map((p) => p.id),
    platformIds: (state.document.platforms ?? []).map((p) => p.id),
    backup: backupPaths(migration).original,
    changes: Object.entries(after).map(([path, raw]) => ({
      path,
      action:
        raw === null
          ? "remove"
          : before[path] === null
            ? "create"
            : raw === before[path]
              ? "unchanged"
              : "update",
      before: before[path] === null ? null : digest(before[path]!),
      after: raw === null ? null : digest(raw),
    })),
    executionEnabled: false,
  };
  return {
    before,
    after,
    proposal: { ...body, digest: digest(canonical(body)) },
  };
}
export function reviewProgrammeMigration(root: string, input: unknown) {
  return prepareMigration(root, input).proposal;
}
export function applyProgrammeMigration(root: string, input: unknown) {
  const args = programmeMigrationApplySchema.parse(input),
    proposal = args.proposal as any;
  check(
    proposal?.request?.id === args.id,
    "PROPOSAL",
    "Migration review belongs to another programme",
  );
  return withProgrammeWrite(root, () => {
    const current = prepareMigration(root, proposal.request);
    check(
      canonical(current.proposal) === canonical(proposal),
      "STALE",
      "Programme migration inputs changed or review was altered; review again",
    );
    programmeTransaction(root, current.before, current.after, () => {
      const verified = loadProgrammeStorage(root, args.id);
      check(
        verified.document &&
          digest(canonical(verified.document)) ===
            current.proposal.definitionDigest,
        "MIGRATION",
        "Resolved programme changed during migration; original files restored",
      );
    });
    const saved = loadProgrammeStorage(root, args.id);
    check(
      saved.document &&
        digest(canonical(saved.document)) === current.proposal.definitionDigest,
      "MIGRATION",
      "Resolved programme changed during migration",
    );
    return {
      applied: true,
      format: saved.format,
      digest: saved.digest,
      definitionDigest: current.proposal.definitionDigest,
      migration: current.proposal.migration,
    };
  });
}
