/** Read-only registration impact and dependency fence, including offline authoring. */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  lstatSync,
} from "node:fs";
import { parseDocument } from "yaml";
import { fence } from "./packages.js";
import { canonical, check, digest } from "./errors.js";
export interface ConnectorConsumer {
  kind: string;
  name: string;
  environment: string;
  effect: string;
}
export function portableConnectorInputs(
  root: string,
  folders = ["ingestions", "ingestion-drafts", "discovery"],
) {
  const files: Record<string, string> = {};
  const documents: { path: string; value: any }[] = [];
  let bytes = 0;
  const visit = (folder: string, depth = 0) => {
    const directory = fence(root, folder);
    if (!existsSync(directory)) return;
    check(depth <= 4, "LIMIT", "Portable dependency tree is too deep");
    for (const name of readdirSync(directory).sort()) {
      const path = `${folder}/${name}`,
        file = fence(root, path);
      check(
        !lstatSync(file).isSymbolicLink(),
        "PATH",
        "Portable dependency cannot be a symlink",
      );
      if (statSync(file).isDirectory()) {
        visit(path, depth + 1);
        continue;
      }
      if (!/\.ya?ml$/.test(name)) continue;
      bytes += statSync(file).size;
      check(
        bytes <= 64 * 1024 * 1024 && documents.length < 4000,
        "LIMIT",
        "Portable dependency inventory exceeds review limits",
      );
      const raw = readFileSync(file, "utf8");
      const yaml = parseDocument(raw, { uniqueKeys: true });
      check(!yaml.errors.length, "YAML", "Invalid portable dependency", path);
      const value = yaml.toJS({ maxAliasCount: 0 });
      check(
        (value && typeof value === "object") ||
          (value === null && path.startsWith("ingestion-drafts/")),
        "REFERENCE",
        "Invalid portable dependency",
        path,
      );
      files[path] = digest(raw);
      if (value !== null) documents.push({ path, value });
    }
  };
  for (const folder of folders) visit(folder);
  return { files, documents, fingerprint: digest(canonical(files)) };
}
export function portableConnectorConsumers(
  inputs: ReturnType<typeof portableConnectorInputs>,
  connections: string[],
  connector?: { id: string; version: string },
): ConnectorConsumer[] {
  return inputs.documents.flatMap(({ path, value }) => {
    const doc = value.snapshot ?? value.definition ?? value;
    const pin = doc.source?.connector ?? doc.connector;
    if (
      !connections.includes(
        typeof doc.source === "string" ? doc.source : doc.source?.id,
      ) &&
      !(
        connector &&
        pin?.id === connector.id &&
        pin?.version === connector.version
      )
    )
      return [];
    return [
      {
        kind: path.startsWith("discovery/")
          ? "Saved discovery"
          : path.startsWith("ingestion-drafts/")
            ? "Working copy"
            : "Ingestion definition",
        name: path,
        environment:
          doc.environment ??
          (path.startsWith("ingestion-drafts/")
            ? path.split("/")[1]!
            : "Portable"),
        effect:
          "Preserved with existing version pin; review new discovery separately",
      },
    ];
  });
}
