/** Import explicitly selected offline bundles without extracting or claiming source verification. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonical, check, digest } from "./errors.js";
import { fence } from "./packages.js";
import { auditSecrets } from "./planner.js";
import { presentationReceiptSchema } from "./presentation.js";
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/);
export const snapshotImportReviewSchema = z
  .object({ name, directory: z.string().min(1).max(4096) })
  .strict();
export const snapshotImportApplySchema = snapshotImportReviewSchema
  .extend({ digest: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
function bundle(
  root: string,
  input: z.infer<typeof snapshotImportReviewSchema>,
) {
  const directory = realpathSync(input.directory),
    target = fence(root, `snapshots/${input.name}`);
  check(
    lstatSync(directory).isDirectory(),
    "PATH",
    "Select a snapshot bundle directory",
  );
  check(
    !existsSync(target),
    "OWNER",
    "Choose a new snapshot name; existing snapshots are preserved",
  );
  const regular = (filename: string, max: number) => {
    const file = join(directory, filename),
      stat = lstatSync(file);
    check(
      stat.isFile() && !stat.isSymbolicLink(),
      "PATH",
      "Snapshot files must be regular files",
    );
    check(stat.size <= max, "LIMIT", "Snapshot exceeds its import size limit");
    return readFileSync(file);
  };
  const receiptBytes = regular("receipt.json", 1024 * 1024),
    receipt = presentationReceiptSchema.parse(
      JSON.parse(receiptBytes.toString("utf8")),
    );
  auditSecrets(receipt, "receipt");
  check(
    new Set(receipt.files.map((f) => f.path)).size === receipt.files.length &&
      new Set(receipt.files.map((f) => f.table)).size === receipt.files.length,
    "RECEIPT",
    "Receipt repeats a table or file",
  );
  let size = 0;
  const files = receipt.files.map((file) => {
    const bytes = regular(file.path, 64 * 1024 * 1024 - size);
    size += bytes.length;
    check(
      digest(bytes) === file.sha256,
      "RECEIPT",
      "Snapshot file differs from its receipt",
    );
    check(
      bytes.length >= 12 &&
        bytes.subarray(0, 4).toString() === "PAR1" &&
        bytes.subarray(-4).toString() === "PAR1",
      "RECEIPT",
      "Expected an unencrypted Parquet file",
    );
    return { name: file.path, bytes };
  });
  const summary = {
    apiVersion: "ingestron.snapshot-import/v1",
    name: input.name,
    receipt: `snapshots/${input.name}/receipt.json`,
    snapshot: receipt.sourceSnapshotId,
    version: receipt.version,
    synthetic: receipt.synthetic ?? null,
    bytes: size,
    tables: receipt.files.map((f) => ({
      name: f.table,
      rows: f.rows,
      sha256: f.sha256,
    })),
    digest: digest(
      canonical({
        name: input.name,
        receipt: digest(receiptBytes),
        files: receipt.files.map((f) => [f.path, f.sha256]),
      }),
    ),
    checks: [
      "Receipt structure",
      "Unique table and file names",
      "Exact file hashes",
      "Parquet file signatures",
    ],
    limitations: [
      "Rows and schema are declared by the supplied receipt; source extraction and data quality were not independently verified.",
    ],
  };
  return { target, files, receiptBytes, summary };
}
export function reviewSnapshotImport(
  root: string,
  input: z.infer<typeof snapshotImportReviewSchema>,
) {
  return bundle(root, input).summary;
}
export function applySnapshotImport(
  root: string,
  input: z.infer<typeof snapshotImportApplySchema>,
) {
  const data = bundle(root, input);
  check(
    data.summary.digest === input.digest,
    "STALE",
    "Snapshot bundle changed after review",
  );
  const parent = fence(root, "snapshots");
  mkdirSync(parent, { recursive: true });
  // Claim a new directory exclusively. Receipt is written last, making incomplete imports undiscoverable.
  const target = fence(root, `snapshots/${input.name}`);
  mkdirSync(target, { mode: 0o700 });
  const created: string[] = [];
  try {
    for (const file of [
      ...data.files,
      { name: "receipt.json", bytes: data.receiptBytes },
    ]) {
      const path = join(target, file.name);
      writeFileSync(path, file.bytes, { flag: "wx", mode: 0o600 });
      created.push(path);
    }
  } catch (error) {
    for (const path of created.reverse()) unlinkSync(path);
    try {
      rmdirSync(target);
    } catch {
      /* Preserve any unexpected concurrent content. */
    }
    throw error;
  }
  return { ...data.summary, imported: true };
}
