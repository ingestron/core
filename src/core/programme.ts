import {
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  lstatSync,
  fsyncSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { check, digest } from "./errors.js";
import { programmeSchema, type Programme } from "./programme-schema.js";
const maxBytes = 512 * 1024;
/** Programme intent has its own explicitly registered root; no project or provider is loaded. */
export function readProgramme(root: string, id: string) {
  const file = join(root, "programme.json");
  if (!existsSync(file)) {
    // Broken symlinks also must not become write targets.
    try {
      check(
        !lstatSync(file).isSymbolicLink(),
        "PATH",
        "Programme file cannot be a symbolic link",
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return { document: null, digest: null };
  }
  const stat = lstatSync(file);
  check(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes,
    "PATH",
    "Programme file must be a bounded regular file",
  );
  const raw = readFileSync(file);
  const document = programmeSchema.parse(JSON.parse(raw.toString("utf8")));
  check(
    document.id === id,
    "PROGRAMME",
    "Programme identity does not match the registered folder",
  );
  return { document, digest: digest(raw) };
}
export function saveProgramme(
  root: string,
  id: string,
  expectedDigest: string | null,
  input: Programme,
) {
  const document = programmeSchema.parse(input);
  check(
    document.id === id,
    "PROGRAMME",
    "Programme identity cannot be changed",
  );
  const raw = JSON.stringify(document, null, 2) + "\n";
  check(
    Buffer.byteLength(raw) <= maxBytes,
    "LIMIT",
    "Programme document exceeds 512 KiB",
  );
  const lock = join(root, ".programme-write.lock");
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch {
    throw new Error(
      "Programme is being saved; retry after the other writer completes",
    );
  }
  const temp = join(root, `.programme-${randomUUID()}.tmp`);
  try {
    const current = readProgramme(root, id);
    check(
      current.digest === expectedDigest,
      "CONFLICT",
      "Programme changed since it was opened. Reload before saving.",
    );
    writeFileSync(temp, raw, { flag: "wx", mode: 0o600 });
    const out = openSync(temp, "r");
    try {
      fsyncSync(out);
    } finally {
      closeSync(out);
    }
    renameSync(temp, join(root, "programme.json"));
    return { document, digest: digest(raw) };
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
    closeSync(fd);
    unlinkSync(lock);
  }
}
