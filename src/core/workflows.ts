import { packageReferenceSchema } from "./schema.js";
import { connectorPackageSchema } from "./connector-package.js";
/** User workflows shared by CLI and MCP. These compose the existing offline
 * compiler and isolated plugin APIs. Execution adapters must be separate from
 * this module: importing metadata never grants permission to run SQL or scripts.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";
import { Configuration } from "./config.js";
import { check, digest, canonical } from "./errors.js";
import { preview, addFlow } from "./authoring.js";
import { contractDraft } from "./development.js";
import { validateContract, contractColumns } from "./contracts.js";
import { providerAuthor, providerReference } from "../plugins/authoring.js";
import { runProviderCommand } from "./provider-commands.js";
import {
  fence,
  resolvePackage,
  packageYaml,
  canonicalPackageReference,
} from "./packages.js";
import { friendlyReference } from "./package-references.js";
export const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/);
const connection = z
  .object({
    binding: identifier.optional(),
    provider: identifier.optional(),
    execution: z.enum(["manual", "local"]).optional(),
    resultPath: z.string().max(1024).optional(),
  })
  .strict();
export const sourceSchema = z
  .object({
    apiVersion: z.literal("ingestron.source/v1"),
    id: identifier,
    type: identifier,
    format: identifier.optional(),
    provider: identifier.optional(),
    execution: z.enum(["manual", "local"]).default("manual"),
    binding: identifier.optional(),
    environments: z.record(identifier, connection).default({}),
  })
  .strict();
export function sourcePath(id: string) {
  return `sources/${identifier.parse(id)}.yaml`;
}
export const metadataPath = (id: string, environment: string) =>
  `discovery/${identifier.parse(id)}/${identifier.parse(environment)}/metadata.json`;
export function sourceShow(root: string, id: string, environment: string) {
  const source = sourceSchema.parse(
    new Configuration(root).load(sourcePath(id)),
  );
  check(source.id === id, "SOURCE", "Source filename and identifier differ");
  const reader = new Configuration(root);
  check(
    reader.load().environments[environment],
    "ENVIRONMENT",
    `Unknown environment ${environment}`,
  );
  const path = metadataPath(id, environment);
  const snapshot = existsSync(fence(root, path))
    ? reader.load(path)
    : undefined;
  const discovery = snapshot
    ? {
        path,
        inputDigest: snapshot.inputDigest,
        stale: snapshot.sourceDigest !== digest(reader.text(sourcePath(id))),
        entities: snapshot.contracts?.map((c: any) => ({
          id: c.id,
          physicalNames: c.schema?.map((s: any) => s.physicalName ?? s.name),
        })),
      }
    : { path, imported: false };
  return {
    ...source,
    discovery,
    selected: { environment, ...source, ...source.environments[environment] },
  };
}
export function sourceList(root: string, environment: string) {
  const directory = fence(root, "sources");
  return existsSync(directory)
    ? readdirSync(directory)
        .filter((n) => n.endsWith(".yaml"))
        .sort()
        .map((n) => {
          const source = sourceShow(root, n.slice(0, -5), environment);
          return {
            id: source.id,
            type: source.type,
            format: source.format,
            execution: source.selected.execution,
            provider: source.selected.provider,
          };
        })
    : [];
}
export function sourceAdd(root: string, args: any) {
  const { id, type, format, provider, execution, binding } = args;
  const path = sourcePath(id);
  check(!existsSync(fence(root, path)), "OWNER", `Source ${id} already exists`);
  const source = sourceSchema.parse({
    apiVersion: "ingestron.source/v1",
    id,
    type,
    format,
    provider,
    execution,
    binding,
  });
  return preview(root, { [path]: stringify(source) });
}
export function sourceConfigure(root: string, args: any) {
  const path = sourcePath(args.id),
    reader = new Configuration(root);
  const original = sourceSchema.parse(reader.load(path));
  check(
    !("id" in args.patch) && !("apiVersion" in args.patch),
    "SOURCE",
    "Source identity cannot be changed by a patch",
  );
  const next = sourceSchema.parse({ ...original, ...args.patch });
  return preview(root, { [path]: stringify(next) });
}
function providerConfiguration(root: string, selected?: string) {
  const project = new Configuration(root).load();
  const configurations = project.providers.configurations;
  if (!selected) selected = project.defaults?.provider;
  if (selected && configurations[selected]) return selected;
  const matches = Object.entries(configurations).filter(
    ([, value]: any) => value.package === selected,
  );
  check(
    matches.length === 1,
    "PROVIDER",
    "Select an installed provider configuration by name",
  );
  return matches[0][0];
}
/** Register installed provider authoring defaults without overwriting another
 * provider's bindings or values. Cache installation and registration are distinct
 * shared operations; a registration conflict leaves the immutable cache usable. */
function packageEditor(root: string) {
  const reader = new Configuration(root);
  const project = parseDocument(reader.text("project.yaml"));
  const reference = project.toJS().providers?.$resolve;
  let providerFile: string | undefined;
  let providerDoc: ReturnType<typeof parseDocument> | undefined;
  if (reference) {
    check(
      typeof reference === "string" && !reference.includes("#"),
      "REFERENCE",
      "Plugin registration requires a whole providers file, not a fragment",
    );
    providerFile = relative(root, reader.path(reference));
    providerDoc = parseDocument(reader.text(providerFile));
    check(
      !providerDoc.toJS().packages?.$resolve &&
        !providerDoc.toJS().configurations?.$resolve,
      "REFERENCE",
      "Keep packages and configurations in the providers file for automatic registration",
    );
    project.set("providers", providerDoc.contents?.clone());
  }
  const finish = (files: Record<string, string>) => {
    if (providerFile && providerDoc && files["project.yaml"]) {
      const edited = parseDocument(files["project.yaml"]);
      providerDoc.contents = edited.get("providers", true) as any;
      files[providerFile] = providerDoc.toString();
      edited.set("providers", { $resolve: reference });
      files["project.yaml"] = edited.toString();
    }
    return preview(root, files);
  };
  return { reader, project, finish };
}
function packageValue(raw: any, name: string) {
  return raw.packages?.[name] ?? raw.providers?.packages?.[name];
}
function packagePath(raw: any, name: string) {
  return raw.packages?.[name] ||
    (raw.packages && !raw.providers?.packages?.[name])
    ? ["packages", name]
    : ["providers", "packages", name];
}
function sameInstalledPackage(root: string, left: string, right: string) {
  try {
    const a = resolvePackage(root, left).entry;
    const b = resolvePackage(root, right).entry;
    return (
      a.repository === b.repository &&
      a.path === b.path &&
      a.commit === b.commit
    );
  } catch {
    return false;
  }
}
function preferredReference(
  root: string,
  raw: any,
  full: string,
  id: string,
  version: string,
) {
  const short = `${id}@${version}`;
  return raw.packages && sameInstalledPackage(root, short, full)
    ? short
    : friendlyReference(full);
}
export function pluginConfigure(root: string, args: any) {
  const reference = canonicalPackageReference(args.reference);
  const sourceManifest = packageYaml(resolvePackage(root, reference).file);
  if (sourceManifest.apiVersion === "ingestron.connector/v1") {
    const connector = connectorPackageSchema.parse(sourceManifest);
    const { project, finish } = packageEditor(root);
    const name = identifier.parse(args.name ?? connector.id);
    const at = reference.lastIndexOf("@");
    const raw = project.toJS();
    const friendly = preferredReference(
      root,
      raw,
      reference,
      connector.id,
      connector.version,
    );
    const value = {
      source: friendly.slice(0, friendly.lastIndexOf("@")),
      version: reference.slice(at + 1),
    };
    const previous = packageValue(raw, name);
    if (previous) {
      const old = packageReferenceSchema.parse(previous);
      check(
        sameInstalledPackage(root, `${old.source}@${old.version}`, reference) ||
          (args.update &&
            (old.source === value.source ||
              old.source ===
                friendlyReference(reference).slice(
                  0,
                  -value.version.length - 1,
                ))),
        "CONFLICT",
        "Connector package key already exists; choose a different name",
      );
    }
    project.setIn(packagePath(raw, name), `${value.source}@${value.version}`);
    return finish({ "project.yaml": project.toString() });
  }

  const { reader, project, finish } = packageEditor(root);
  const raw = project.toJS(),
    selected = providerReference(root, args.reference);
  const preferred = preferredReference(
    root,
    raw,
    canonicalPackageReference(args.reference),
    selected.manifest.id,
    selected.manifest.version,
  );
  const name = identifier.parse(args.name ?? selected.manifest.platform);
  const configurations = raw.providers.configurations;
  if (configurations[name]) {
    const existing = packageReferenceSchema.parse(
      packageValue(raw, configurations[name].package),
    );
    check(
      args.update ||
        sameInstalledPackage(
          root,
          `${existing.source}@${existing.version}`,
          args.reference,
        ),
      "CONFLICT",
      `Provider configuration ${name} already exists; use provider_migrate or a different name`,
    );
    if (args.update) {
      check(
        existing.source === preferred.slice(0, preferred.lastIndexOf("@")) ||
          friendlyReference(existing.source) === selected.source,
        "CONFLICT",
        "Use plugin migrate to change provider identity",
      );
      project.setIn(packagePath(raw, configurations[name].package), preferred);
      return finish({ "project.yaml": project.toString() });
    }
    if (
      !sameInstalledPackage(
        root,
        `${existing.source}@${existing.version}`,
        args.reference,
      )
    ) {
      project.setIn(packagePath(raw, configurations[name].package), preferred);
      return finish({ "project.yaml": project.toString() });
    }
    return finish({});
  }
  check(
    !packageValue(raw, name),
    "CONFLICT",
    `Package key ${name} already exists`,
  );
  const environmentNames = Object.keys(raw.environments);
  const files = providerAuthor(
    root,
    args.reference,
    {
      operation: "initialise",
      options: {
        id: raw.id,
        provider: args.reference,
        environments: environmentNames,
      },
    },
    (n) =>
      ["project.yaml", "README.md", ".gitignore"].includes(n) ||
      /^environments\/[\w-]+\.yaml$/.test(n),
  );
  const skeleton = parseDocument(files["project.yaml"]).toJS();
  const defaults =
    skeleton.providers.configurations[skeleton.defaults.provider];
  check(
    defaults,
    "PROVIDER",
    "Provider did not supply its default configuration",
  );
  project.setIn(packagePath(raw, name), preferred);
  const bindingName = `${name}_${defaults.binding}`;
  project.setIn(["providers", "configurations", name], {
    ...defaults,
    package: name,
    binding: bindingName,
  });
  if (!raw.defaults?.provider) project.setIn(["defaults", "provider"], name);
  const replacements: Record<string, string> = {};
  for (const env of environmentNames) {
    const reference = raw.environments[env];
    const envPath = reference.$resolve
      ? relative(root, reader.path(reference.$resolve))
      : undefined;
    const current = envPath
      ? parseDocument(reader.text(envPath))
      : parseDocument(stringify(reference));
    const generated = parseDocument(files[`environments/${env}.yaml`]).toJS();
    for (const group of ["values", "bindings"])
      for (const [originalKey, value] of Object.entries(
        generated[group] ?? {},
      )) {
        const key =
          group === "bindings" && originalKey === defaults.binding
            ? bindingName
            : originalKey;
        if (current.hasIn([group, key]))
          check(
            canonical(current.toJS()[group][key]) === canonical(value),
            "CONFLICT",
            `Environment ${env} ${group}.${key} conflicts with provider defaults; configure explicitly before registration`,
          );
        else current.setIn([group, key], value);
      }
    if (envPath) replacements[envPath] = current.toString();
    else project.setIn(["environments", env], current.toJS());
  }
  replacements["project.yaml"] = project.toString();
  return finish(replacements);
}
function artifactFiles(envelope: any) {
  check(
    envelope.apiVersion === "ingestron.provider-command-result/v1" &&
      envelope.execution === "offline-json",
    "PROVIDER",
    "Expected an offline provider result",
  );
  const artifacts = envelope.result?.artifacts;
  check(
    envelope.result?.apiVersion === "ingestron.artifact-proposal/v1" &&
      artifacts &&
      typeof artifacts === "object" &&
      !Array.isArray(artifacts),
    "PROVIDER",
    "Provider did not return file artifacts",
  );
  check(
    Object.keys(artifacts).length > 0 && Object.keys(artifacts).length <= 200,
    "LIMIT",
    "Expected 1–200 artifacts",
  );
  for (const [name, text] of Object.entries(artifacts))
    check(
      /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(json|yaml|yml|sql|py|mjs|txt|md)$/.test(
        name,
      ) &&
        typeof text === "string" &&
        text.length <= 2000000,
      "PROVIDER",
      "Invalid artifact filename or content",
    );
  return artifacts as Record<string, string>;
}
export function sourcePrepare(root: string, environment: string, args: any) {
  const source = sourceShow(root, args.id, environment).selected;
  check(
    source.execution === "local" || source.execution === "manual",
    "NOT_IMPLEMENTED",
    "Source preparation supports manual and local execution modes only.",
  );
  const input = new Configuration(root).load(args.input);
  check(
    !input.sourceId || input.sourceId === source.id,
    "SOURCE",
    "Reader input belongs to a different source",
  );
  check(
    !input.sourceKind || input.sourceKind === source.type,
    "SOURCE",
    "Reader input has a different source type",
  );
  check(
    !input.format || input.format === source.format,
    "SOURCE",
    "Reader input has a different format",
  );
  const result = runProviderCommand(root, environment, {
    configuration: providerConfiguration(root, source.provider),
    command: "discover source prepare",
    input: {
      ...input,
      sourceId: source.id,
      sourceKind: source.type,
      ...(source.format ? { format: source.format } : {}),
    },
  });
  const artifacts = artifactFiles(result),
    files: Record<string, string> = {};
  const out = args.out ?? `discovery/${source.id}/reader`;
  for (const [name, text] of Object.entries(artifacts)) {
    const path = `${out}/${name}`;
    check(
      !existsSync(fence(root, path)),
      "OWNER",
      `Existing reader file ${path}; choose another output directory`,
    );
    files[path] = text;
  }
  return preview(root, files);
}
function metadataContracts(
  root: string,
  environment: string,
  path: string,
  provider?: string,
) {
  const reader = new Configuration(root),
    metadata = reader.load(path);
  if (metadata.kind === "DataContract") {
    validateContract(metadata);
    return [metadata];
  }
  if (metadata.columns) {
    const proposal = contractDraft(
      root,
      path,
      "imported",
      "contracts/imported.odcs.yaml",
    );
    return [parseDocument(proposal.changes[0].after).toJS()];
  }
  const result = runProviderCommand(root, environment, {
    configuration: providerConfiguration(root, provider),
    command: "discover contracts",
    input: metadata,
  });
  const contracts = Object.entries(artifactFiles(result))
    .filter(([n]) => n.endsWith(".odcs.json"))
    .map(([, text]) => JSON.parse(text));
  check(contracts.length > 0, "METADATA", "No contracts found in metadata");
  contracts.forEach((c) => validateContract(c));
  return contracts;
}
export function sourceImport(root: string, environment: string, args: any) {
  const source = sourceShow(root, args.id, environment).selected,
    reader = new Configuration(root);
  const input = reader.load(args.metadata);
  check(
    !input.sourceId || input.sourceId === source.id,
    "SOURCE",
    "Metadata belongs to a different source",
  );
  check(
    !input.sourceKind || input.sourceKind === source.type,
    "SOURCE",
    "Metadata has a different source type",
  );
  check(
    !input.format || input.format === source.format,
    "SOURCE",
    "Metadata has a different format",
  );
  const contracts = metadataContracts(
    root,
    environment,
    args.metadata,
    source.provider,
  );
  const path = metadataPath(source.id, environment);
  // Replacement is a normal digest-bound authoring proposal, so --dry-run and
  // MCP review/apply protect imported evidence just like configuration edits.
  return preview(root, {
    [path]:
      JSON.stringify(
        {
          apiVersion: "ingestron.discovery/v1",
          sourceId: source.id,
          environment,
          sourceDigest: digest(reader.text(sourcePath(source.id))),
          inputDigest: digest(reader.text(args.metadata)),
          contracts,
          evidence:
            "Imported metadata; source access and completeness are not verified by core",
        },
        null,
        2,
      ) + "\n",
  });
}
export function draftContract(root: string, environment: string, args: any) {
  identifier.parse(args.id);
  check(
    !!args.source !== !!args.metadata,
    "INPUT",
    "Choose exactly one of source or metadata",
  );
  let contracts: any[], evidence: any;
  if (args.source) {
    const source = sourceShow(root, args.source, environment);
    const reader = new Configuration(root),
      snapshot = reader.load(metadataPath(source.id, environment));
    check(
      snapshot.apiVersion === "ingestron.discovery/v1" &&
        snapshot.sourceId === source.id &&
        snapshot.environment === environment,
      "METADATA",
      "Import discovery metadata for this source and selected environment first",
    );
    check(
      snapshot.sourceDigest === digest(reader.text(sourcePath(source.id))),
      "STALE",
      "Source configuration changed; import fresh metadata before drafting",
    );
    contracts = snapshot.contracts;
    evidence = {
      sourceId: source.id,
      inputDigest: snapshot.inputDigest,
      environment,
    };
  } else {
    contracts = metadataContracts(
      root,
      environment,
      args.metadata,
      args.provider,
    );
    evidence = {
      inputDigest: digest(new Configuration(root).text(args.metadata)),
      environment,
    };
  }
  const matches = args.entity
    ? contracts.filter(
        (c) =>
          c.id === args.entity ||
          c.id.endsWith(`__${args.entity}`) ||
          c.schema?.some(
            (s: any) =>
              s.name === args.entity || s.physicalName === args.entity,
          ),
      )
    : contracts;
  check(
    matches.length === 1,
    "SELECT",
    "Select exactly one discovered entity with entity (contract ID or physical name)",
  );
  const contract = {
    ...matches[0],
    id: args.id,
    name: args.id,
    status: "draft",
  };
  validateContract(contract);
  const path = args.out ?? `contracts/${args.id}.odcs.yaml`;
  const provenance = `contracts/${args.id}.provenance.json`;
  for (const file of [path, provenance])
    check(
      !existsSync(fence(root, file)),
      "OWNER",
      `Contract output ${file} already exists; use a new ID or review the existing file`,
    );
  return preview(root, {
    [path]: stringify(contract),
    [provenance]:
      JSON.stringify(
        {
          ...evidence,
          contract: path,
          status: "draft",
          review:
            "Review schema, keys, types and business requirements before building",
        },
        null,
        2,
      ) + "\n",
  });
}
export function contractPath(root: string, id: string) {
  if (/\.(json|ya?ml)$/.test(id)) {
    fence(root, id);
    return id;
  }
  return `contracts/${identifier.parse(id)}.odcs.yaml`;
}
export function contractList(root: string) {
  const dir = fence(root, "contracts");
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => /\.odcs\.(json|ya?ml)$/.test(n))
        .sort()
        .map((n) => {
          const path = `contracts/${n}`,
            contract = new Configuration(root).load(path);
          validateContract(contract, path);
          return {
            id: contract.id,
            status: contract.status,
            path,
            entities:
              contract.schema?.map((s: any) => s.physicalName ?? s.name) ?? [],
          };
        })
    : [];
}
export function flowCreate(root: string, environment: string, args: any) {
  const {
    contract: selectedContract,
    source: selectedSource,
    ...options
  } = args;
  let sourceId = selectedSource;
  if (
    !sourceId &&
    selectedContract &&
    /^[A-Za-z_][\w-]*$/.test(selectedContract)
  ) {
    const provenance = fence(
      root,
      `contracts/${selectedContract}.provenance.json`,
    );
    if (existsSync(provenance))
      sourceId = JSON.parse(readFileSync(provenance, "utf8")).sourceId;
  }
  if (sourceId) {
    const source = sourceShow(root, sourceId, environment).selected;
    options.sourceKind ??= source.type;
    options.format ??= source.format;
    options.sourceBinding ??= source.binding;
    options.provider ??= source.provider;
  }
  if (options.provider)
    options.provider = providerConfiguration(root, options.provider);
  const proposal = addFlow(root, options);
  if (!selectedContract) return proposal;
  check(
    options.kind === "ingestion",
    "INPUT",
    "Use flow output add to bind a transformation's producing port and output contract",
  );
  const path = contractPath(root, selectedContract),
    contract = new Configuration(root).load(path);
  contractColumns(contract, path);
  const tableId = identifier.parse(contract.id);
  const replacements = Object.fromEntries(
    proposal.changes.map((c) => [c.path, c.after]),
  );
  const file = `flows/${options.id}/flow.yaml`,
    doc = parseDocument(replacements[file]);
  const relativeContract = relative(
    dirname(resolve(root, file)),
    resolve(root, path),
  ).replaceAll("\\", "/");
  doc.setIn(["tables", tableId], { contract: { $resolve: relativeContract } });
  replacements[file] = doc.toString();
  return preview(root, replacements);
}
