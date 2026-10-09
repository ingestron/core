import { withWorkItemKeys } from "./programme-keys.js";
import { check, canonical } from "./errors.js";
import { programmeSchema, type Programme } from "./programme-schema.js";
import {
  loadProgrammeStorage,
  programmeYamlFiles,
  programmeLimit,
  programmeBytes,
} from "./programme-storage.js";
import {
  assertProgrammeReadable,
  withProgrammeWrite,
  programmeTransaction,
} from "./programme-transaction.js";
/** Storage does not change the resolved operation model or authorised root. */
export function readProgramme(root: string, id: string) {
  assertProgrammeReadable(root);
  const { document, digest } = loadProgrammeStorage(root, id);
  return { document, digest };
}
export function saveProgramme(
  root: string,
  id: string,
  expectedDigest: string | null,
  input: Programme,
) {
  const document = withWorkItemKeys(programmeSchema.parse(input));
  check(
    document.id === id,
    "PROGRAMME",
    "Programme identity cannot be changed",
  );
  return withProgrammeWrite(root, () => {
    const current = loadProgrammeStorage(root, id);
    check(
      current.digest === expectedDigest,
      "CONFLICT",
      "Programme changed since it was opened. Reload before saving.",
    );
    for (const previous of current.document?.projects ?? []) {
      if (!previous.compilerId) continue;
      check(
        document.projects.find((project) => project.id === previous.id)
          ?.compilerId === previous.compilerId,
        "CONFLICT",
        "Registered project identities cannot be removed or reassigned",
      );
    }
    const files =
      current.format === "yaml"
        ? programmeYamlFiles(document, current)
        : { "programme.json": JSON.stringify(document, null, 2) + "\n" };
    check(
      Object.values(files).reduce((n, raw) => n + Buffer.byteLength(raw), 0) <=
        programmeLimit,
      "LIMIT",
      "Programme document exceeds 512 KiB",
    );
    const before: Record<string, string | null> = { ...current.files },
      after: Record<string, string | null> = { ...files };
    for (const name of Object.keys(files))
      if (!Object.hasOwn(before, name)) {
        check(
          programmeBytes(root, name) === null,
          "OWNER",
          "New programme definition would overwrite an existing file",
        );
        before[name] = null;
      }
    for (const name of Object.keys(current.files))
      if (!Object.hasOwn(files, name)) after[name] = null;
    programmeTransaction(root, before, after, () => {
      check(
        canonical(loadProgrammeStorage(root, id).document) ===
          canonical(document),
        "PROGRAMME",
        "Saved programme did not round-trip; original files restored",
      );
    });
    return readProgramme(root, id);
  });
}
