/** Serialised local programme transactions. Readers reject an in-flight external writer. */
import {
  openSync,
  closeSync,
  existsSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  fsyncSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { check } from "./errors.js";
import { programmeBytes, programmePath } from "./programme-storage.js";
const owned = new Set<string>();
export function assertProgrammeReadable(root: string) {
  const path = realpathSync(root);
  check(
    !existsSync(join(path, ".programme-write.lock")) || owned.has(path),
    "BUSY",
    "Programme is being changed; retry when its writer completes",
  );
}
export function withProgrammeWrite<T>(root: string, action: () => T): T {
  root = realpathSync(root);
  const lock = programmePath(root, ".programme-write.lock");
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch {
    throw Error(
      "Programme is being saved; retry after the other writer completes",
    );
  }
  owned.add(root);
  try {
    return action();
  } finally {
    owned.delete(root);
    closeSync(fd);
    unlinkSync(lock);
  }
}
export function programmeTransaction(
  root: string,
  before: Record<string, string | null>,
  after: Record<string, string | null>,
  validate?: () => void,
) {
  check(
    owned.has(realpathSync(root)),
    "PERMISSION",
    "Programme transaction requires its write lock",
  );
  for (const [name, expected] of Object.entries(before))
    check(
      programmeBytes(root, name) === expected,
      "CONFLICT",
      "Programme files changed before the transaction; review again",
    );
  for (const name of Object.keys(after))
    check(
      Object.hasOwn(before, name),
      "OWNER",
      "Every changed programme file requires a reviewed prior value",
    );
  const staged = new Map<string, string>(),
    touched: string[] = [];
  try {
    // Stage all contents before replacing anything; never overwrite an unreviewed path.
    for (const [name, raw] of Object.entries(after))
      if (raw !== null && raw !== before[name]) {
        const file = programmePath(root, name);
        mkdirSync(dirname(file), { recursive: true });
        const temp = join(dirname(file), `.programme-${randomUUID()}.tmp`);
        writeFileSync(temp, raw, { mode: 0o600, flag: "wx" });
        staged.set(name, temp);
        const fd = openSync(temp, "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    for (const [name, expected] of Object.entries(before))
      check(
        programmeBytes(root, name) === expected,
        "CONFLICT",
        "Programme files changed while staging; review again",
      );
    for (const [name, raw] of Object.entries(after)) {
      if (raw === before[name]) continue;
      const file = programmePath(root, name);
      if (raw === null) {
        if (before[name] !== null) unlinkSync(file);
      } else {
        renameSync(staged.get(name)!, file);
        staged.delete(name);
      }
      touched.push(name);
    }
    validate?.();
  } catch (error) {
    for (const name of touched.reverse()) {
      const file = programmePath(root, name),
        raw = before[name];
      if (raw === null) {
        if (existsSync(file)) unlinkSync(file);
      } else writeFileSync(file, raw, { mode: 0o600 });
    }
    throw error;
  } finally {
    for (const temp of staged.values()) if (existsSync(temp)) unlinkSync(temp);
  }
}
