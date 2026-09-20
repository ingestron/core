import { Configuration } from "./config.js";
import { externalActivitySchema, packageYaml } from "./packages.js";
import { contractColumns, validateContract } from "./contracts.js";
import { preview } from "./authoring.js";
import { check, isMap } from "./errors.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fence } from "./packages.js";
import { stringify } from "yaml";
export function activityInspect(root: string, path: string) {
  const reader = new Configuration(root),
    file = reader.path(path);
  const manifest = externalActivitySchema.parse(packageYaml(file));
  reader.text(file);
  const generationSource = manifest.generator?.code
    ? reader.text(manifest.generator.code, file)
    : undefined;
  const templates = manifest.templates.map((t) => ({
    ...t,
    content: reader.text(t.source, file),
  }));
  return {
    manifest,
    generationSource,
    templates,
    sourceDigests: reader.files,
    evidence:
      "Manifest and source inventory only; no activity code executed. Composition is checked by the owning provider.",
  };
}
export function contractDraft(
  root: string,
  path: string,
  id: string,
  out: string,
) {
  const reader = new Configuration(root),
    metadata = reader.load(path);
  check(
    Array.isArray(metadata.columns) && metadata.columns.length,
    "METADATA",
    "Imported metadata needs a non-empty columns array",
  );
  const types: Record<string, string> = {
    string: "string",
    integer: "integer",
    number: "number",
    boolean: "boolean",
    date: "date",
    timestamp: "timestamp",
  };
  const contract = {
    apiVersion: "v3.1.0",
    kind: "DataContract",
    id,
    name: id,
    version: "1.0.0",
    status: "draft",
    schema: [
      {
        name: id,
        physicalName: metadata.table ?? id,
        logicalType: "object",
        physicalType: "table",
        properties: metadata.columns.map((c: any) => {
          check(
            types[c.logicalType],
            "METADATA",
            `Review logicalType for ${c.name}`,
          );
          return {
            name: c.name,
            logicalType: c.logicalType,
            ...(c.physicalType ? { physicalType: c.physicalType } : {}),
            required: c.required ?? false,
            ...(c.primaryKey ? { primaryKey: true } : {}),
          };
        }),
      },
    ],
  };
  contractColumns(contract);
  return preview(root, { [out]: stringify(contract) });
}

export function exportProviderArtifacts(
  root: string,
  path: string,
  directory: string,
) {
  const reader = new Configuration(root),
    envelope = JSON.parse(reader.text(path));
  check(
    envelope.apiVersion === "ingestron.provider-command-result/v1" &&
      envelope.execution === "offline-json",
    "PROVIDER",
    "Expected a saved offline provider command result",
  );
  const proposal = envelope.result;
  check(
    proposal?.apiVersion === "ingestron.artifact-proposal/v1" &&
      isMap(proposal.artifacts),
    "PROVIDER",
    "Provider did not return exportable artifacts",
  );
  const entries = Object.entries(proposal.artifacts);
  check(
    entries.length > 0 && entries.length <= 200,
    "LIMIT",
    "Export requires 1–200 artifacts",
  );
  const files: Record<string, string> = {};
  for (const [name, value] of entries) {
    check(
      /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(json|yaml|yml|sql|py|mjs|txt|md|pbip|pbir|pbism|bim|svg)$/.test(
        name,
      ) &&
        typeof value === "string" &&
        value.length <= 2000000,
      "PROVIDER",
      "Invalid artifact name or content",
    );
    const target = directory + "/" + name;
    fence(root, target);
    check(
      !existsSync(resolve(root, target)),
      "OWNER",
      `Existing artifact ${target}; choose a new export directory`,
    );
    if (/\.(json|pbip|pbir|pbism|bim)$/.test(name)) {
      const doc = JSON.parse(value as string);
      if (name.endsWith(".odcs.json")) validateContract(doc);
    }
    files[target] = value as string;
  }
  return preview(root, files);
}
