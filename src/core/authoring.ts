import { requireFlowTarget } from "./bridge-connections.js";
import { scheduleSchema, type Schedule } from "./schedule-schema.js";
import { friendlyReference } from "./package-references.js";
import { providerAuthor, providerReference } from "../plugins/authoring.js";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { resolve, dirname, relative } from "node:path";
import {
  parseDocument,
  stringify,
  isMap as isYamlMap,
  isNode,
  visit,
} from "yaml";
import { check, digest, canonical, merge, Problem } from "./errors.js";
import { Configuration } from "./config.js";
import { connectorPackageSchema } from "./connector-package.js";
import { resolveConnectionSettings } from "./connection-settings.js";
import { policySchema, type ProjectPolicy } from "./policy-schema.js";
import { packageReferenceSchema, projectSchema } from "./schema.js";
import { projectPackages } from "./project-packages.js";
import { contractColumns } from "./contracts.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { validateSchemaShape } from "./provider-commands.js";
import {
  fence,
  installedProviders,
  canonicalPackageReference,
  configuredPackageReference,
  resolvePackage,
  packageYaml,
} from "./packages.js";
function concisePackageReference(root: string, value: unknown) {
  const pkg = packageReferenceSchema.parse(value);
  const reference = configuredPackageReference(pkg);
  const installed = resolvePackage(root, reference);
  const manifest = packageYaml(installed.file);
  const short = `${manifest.id}@${manifest.version}`;
  try {
    const selected = resolvePackage(root, short);
    if (
      selected.entry.repository === installed.entry.repository &&
      selected.entry.path === installed.entry.path &&
      selected.entry.commit === installed.entry.commit
    )
      return short;
  } catch {
    // Keep an explicit reference if multiple installed packages share the ID.
  }
  return `${pkg.source}@${pkg.version}`;
}
export interface Change {
  path: string;
  before: string | null;
  after: string;
}
export interface Proposal {
  apiVersion: "ingestron.change/v1";
  id: string;
  revision: string;
  changes: Change[];
  inputs?: Record<string, string>;
  reviewedPackages?: string[];
}
const yaml = (text: string, file: string) => {
  const doc = parseDocument(text, { uniqueKeys: true });
  check(
    !doc.errors.length,
    "YAML",
    doc.errors[0]?.message ?? "Invalid YAML",
    file,
  );
  return doc;
};
function revision(root: string) {
  const lockFile = resolve(root, "packages.lock.yaml");
  const lock = existsSync(lockFile) ? digest(readFileSync(lockFile)) : null;
  if (!existsSync(resolve(root, "project.yaml")))
    return digest(canonical({ project: null, lock }));
  const reader = new Configuration(root);
  reader.load();
  const delivery = Object.fromEntries(
    ["delivery-plan.yaml", "delivery-plan.baseline.yaml"].map((name) => {
      const path = fence(root, name);
      return [name, existsSync(path) ? digest(readFileSync(path)) : null];
    }),
  );
  return digest(canonical({ files: reader.files, lock, delivery }));
}

export function preview(
  root: string,
  replacements: Record<string, string>,
  inputs?: Record<string, string>,
  reviewedPackages?: string[],
): Proposal {
  root = resolve(root);
  const changes = Object.entries(replacements)
    .map(([name, after]) => {
      const file = fence(root, name);
      const before = existsSync(file) ? readFileSync(file, "utf8") : null;
      return { path: name, before, after };
    })
    .filter((c) => c.before !== c.after);
  const body = {
    apiVersion: "ingestron.change/v1" as const,
    revision: revision(root),
    changes,
    ...(inputs ? { inputs } : {}),
    ...(reviewedPackages ? { reviewedPackages } : {}),
  };
  return { ...body, id: digest(canonical(body)) };
}
export function apply(root: string, proposal: Proposal) {
  root = resolve(root);
  const { id, ...body } = proposal;
  check(
    id === digest(canonical(body)) &&
      proposal.apiVersion === "ingestron.change/v1",
    "PROPOSAL",
    "Invalid change proposal",
  );
  check(
    revision(root) === proposal.revision,
    "STALE",
    "Project inputs changed since this proposal was reviewed",
  );
  check(
    Array.isArray(proposal.changes) && proposal.changes.length <= 1000,
    "PROPOSAL",
    "Invalid or oversized change list",
  );
  const checkInputs = () => {
    if (!proposal.inputs && !proposal.reviewedPackages) return;
    check(
      Object.keys(proposal.inputs ?? {}).length <= 1001,
      "LIMIT",
      "Too many reviewed inputs",
    );
    for (const [path, sha256] of Object.entries(proposal.inputs ?? {})) {
      const file = fence(root, path);
      check(
        existsSync(file) && digest(readFileSync(file)) === sha256,
        "STALE",
        `Reviewed input changed: ${path}`,
      );
    }
    if (proposal.reviewedPackages) {
      check(
        Array.isArray(proposal.reviewedPackages) &&
          proposal.reviewedPackages.length <= 1001 &&
          proposal.reviewedPackages.every(
            (reference) => typeof reference === "string",
          ),
        "PROPOSAL",
        "Invalid reviewed package references",
      );
      for (const reference of proposal.reviewedPackages)
        providerReference(root, reference);
    }
  };
  checkInputs();
  for (const change of proposal.changes)
    check(
      (change.path.split("/").at(-1) === ".gitignore" &&
        !change.path
          .split("/")
          .slice(0, -1)
          .some((part) => part.startsWith("."))) ||
        (/\.(ya?ml|json|sql|py|m?js|md|txt|pbip|pbir|pbism|bim|svg|sql\.j2|py\.j2)$/.test(
          change.path,
        ) &&
          !change.path.split("/").some((part) => part.startsWith("."))),
      "PATH",
      "Authoring applies only visible project configuration/source files",
    );
  for (const change of proposal.changes) {
    const file = fence(root, change.path);
    check(
      (existsSync(file) ? readFileSync(file, "utf8") : null) === change.before,
      "STALE",
      `File changed since preview: ${change.path}`,
    );
  }
  mkdirSync(root, { recursive: true });
  const guard = fence(root, ".ingestron-write.lock");
  try {
    writeFileSync(guard, id, { flag: "wx" });
  } catch {
    throw new Problem("CONFLICT", "Another authoring operation is active");
  }
  const written: Change[] = [];
  try {
    check(
      revision(root) === proposal.revision,
      "STALE",
      "Project changed while waiting for write access",
    );
    checkInputs();
    for (const change of proposal.changes) {
      const file = fence(root, change.path);
      check(
        (existsSync(file) ? readFileSync(file, "utf8") : null) ===
          change.before,
        "STALE",
        `File changed: ${change.path}`,
      );
    }
    for (const change of proposal.changes) {
      const file = fence(root, change.path);
      mkdirSync(dirname(file), { recursive: true });
      const temp = file + `.edit-${process.pid}`;
      writeFileSync(temp, change.after, { flag: "wx" });
      try {
        renameSync(temp, file);
        written.push(change);
      } finally {
        rmSync(temp, { force: true });
      }
    }
  } catch (error) {
    for (const change of written.reverse()) {
      const file = fence(root, change.path);
      check(
        readFileSync(file, "utf8") === change.after,
        "CONFLICT",
        `Rollback stopped because ${change.path} changed externally`,
      );
      if (change.before === null) rmSync(file);
      else writeFileSync(file, change.before);
    }
    throw error;
  } finally {
    rmSync(guard, { force: true });
  }
  return { applied: true, proposalId: id, files: written.map((c) => c.path) };
}
function validProjectIdentifier(value: string) {
  return (
    /^[A-Za-z_][\w-]*$/.test(value) &&
    !["__proto__", "constructor", "prototype"].includes(value)
  );
}

/** Provider-neutral initial definitions, also used by workspace onboarding. */
export function initialProjectFiles(id: string, environments: string[]) {
  check(validProjectIdentifier(id), "PROJECT", "Invalid project ID");
  check(
    environments.length > 0 &&
      new Set(environments).size === environments.length &&
      environments.every(validProjectIdentifier),
    "ENVIRONMENT",
    "Use distinct environment identifiers",
  );
  const files: Record<string, string> = {
    "project.yaml": stringify({
      apiVersion: "ingestron.project/v1",
      id: id,
      packages: {},
      providers: { configurations: {} },
      defaults: {},
      environments: Object.fromEntries(
        environments.map((name) => [
          name,
          { $resolve: `./environments/${name}.yaml` },
        ]),
      ),
      flows: [],
    }),
    ".gitignore": "build/\n.ingestron/\n.local/\n",
  };
  for (const name of environments)
    files[`environments/${name}.yaml`] = stringify({
      apiVersion: "ingestron.environment/v1",
      environment: name,
      values: {},
      bindings: {},
    });
  return files;
}

export function initialise(
  root: string,
  options: { id: string; provider?: string; environments?: string[] },
) {
  check(validProjectIdentifier(options.id), "PROJECT", "Invalid project ID");
  const environments = options.environments ?? ["dev", "test", "prod"];
  check(
    environments.length > 0 &&
      new Set(environments).size === environments.length &&
      environments.every(validProjectIdentifier),
    "ENVIRONMENT",
    "Use distinct environment identifiers",
  );
  mkdirSync(root, { recursive: true });
  if (!options.provider) {
    const files = initialProjectFiles(options.id, environments);
    for (const name of Object.keys(files))
      check(
        !existsSync(resolve(root, name)),
        "OWNER",
        `Initialisation would replace existing ${name}`,
      );
    return preview(root, files);
  }
  let reference = options.provider;
  if (!reference.includes("@")) {
    const source = canonicalPackageReference(`${reference}@0.0.0`).split(
      "@",
    )[0];
    const matches = installedProviders(root).filter(
      (p) => p.reference.split("@")[0] === source,
    );
    check(
      matches.length > 0,
      "PACKAGE",
      `No installed provider ${reference}; use plugin install ${reference} first`,
    );
    check(
      matches.length === 1,
      "PACKAGE",
      `Multiple installed versions of ${reference}; use an exact reference: ${matches.map((p) => friendlyReference(p.reference)).join(", ")}`,
    );
    reference = matches[0].reference;
  }
  const files = providerAuthor(
    root,
    reference,
    { operation: "initialise", options: { ...options, environments } },
    (name) =>
      name === "project.yaml" ||
      name === "README.md" ||
      name === ".gitignore" ||
      /^environments\/[\w-]+\.yaml$/.test(name),
  );
  check(files["project.yaml"], "PROVIDER", "Provider must author a project");
  const authored = yaml(files["project.yaml"], "project.yaml").toJS();
  const providerPackages = authored.providers?.packages ?? {};
  authored.packages ??= {};
  for (const [name, value] of Object.entries(providerPackages)) {
    check(
      !Object.hasOwn(authored.packages, name),
      "PACKAGE",
      `Duplicate package alias ${name}`,
    );
    authored.packages[name] = concisePackageReference(root, value);
  }
  if (authored.providers) delete authored.providers.packages;
  files["project.yaml"] = stringify(authored);
  // Providers may return JSON (valid YAML); editable scaffolds use block YAML.
  for (const [name, text] of Object.entries(files)) {
    if (name.endsWith(".yaml"))
      files[name] = stringify(yaml(text, name).toJS());
  }
  for (const name of Object.keys(files))
    check(
      !existsSync(resolve(root, name)),
      "OWNER",
      `Initialisation would replace existing ${name}`,
    );
  return preview(root, files);
}
export function migrateProvider(
  root: string,
  options: { package: string; to: string },
) {
  const reader = new Configuration(root),
    doc = yaml(reader.text("project.yaml"), "project.yaml");
  const location = doc.hasIn(["packages", options.package])
    ? ["packages", options.package]
    : ["providers", "packages", options.package];
  check(doc.hasIn(location), "PACKAGE", "Unknown project package");
  const selected = providerReference(root, options.to);
  doc.setIn(
    location,
    location[0] === "packages"
      ? concisePackageReference(root, `${selected.source}@${selected.version}`)
      : { source: selected.source, version: selected.version },
  );
  return preview(
    root,
    { "project.yaml": doc.toString() },
    Object.fromEntries(
      Object.entries(selected.entry.files).map(([path, hash]) => [
        relative(resolve(root), fence(selected.root, path)),
        hash,
      ]),
    ),
    [selected.reference],
  );
}
function flowFile(root: string, id: string) {
  const projectFile = resolve(root, "project.yaml"),
    project = yaml(readFileSync(projectFile, "utf8"), projectFile).toJS();
  const reader = new Configuration(root);
  for (const reference of project.flows ?? []) {
    check(
      reference.$resolve,
      "AUTHORING",
      "Editable flows must be in their own referenced flow.yaml",
    );
    const file = reader.path(reference.$resolve);
    const doc = yaml(reader.text(file), file);
    if (doc.get("id") === id) return { file, doc, projectFile, project };
  }
  throw new Problem("FLOW", `Unknown flow ${id}`);
}
export function addFlow(
  root: string,
  options: {
    id: string;
    kind: "ingestion" | "transformation";
    standard?: string;
    sourceKind?: string;
    format?: string;
    sourceBinding?: string;
    inputDataset?: string;
    language?: "sql" | "python";
    transformationSettings?: Record<string, unknown>;
    outputContract?: Record<string, unknown>;
    provider?: string;
  },
) {
  const reader = new Configuration(root),
    project = yaml(reader.text("project.yaml"), "project.yaml"),
    raw = project.toJS(),
    resolved = reader.load();
  check(/^[A-Za-z_][\w-]*$/.test(options.id), "FLOW", "Invalid flow ID");
  check(
    !resolved.flows.some((f: any) => f.id === options.id),
    "OWNER",
    `Flow ${options.id} already exists`,
  );
  const configuration = options.provider ?? resolved.defaults.provider;
  requireFlowTarget(resolved, configuration);
  const config = resolved.providers.configurations[configuration];
  check(config, "PROVIDER", "Select a provider configuration for this flow");
  const pkg = projectPackages(projectSchema.parse(resolved))[config.package];
  const declared = providerReference(
    root,
    resolvePackage(root, configuredPackageReference(pkg)).reference,
  ).manifest.authoring?.flows;
  if (declared) {
    check(
      declared.kinds.includes(options.kind),
      "CAPABILITY",
      "Provider does not declare authoring for this flow kind",
    );
    check(
      options.kind !== "ingestion" ||
        !options.standard ||
        declared.ingestionStandards.includes(options.standard),
      "CAPABILITY",
      "Provider does not declare authoring for this ingestion standard",
    );
  }
  if (options.transformationSettings !== undefined || options.outputContract) {
    check(
      options.kind === "transformation",
      "FLOW",
      "Output settings apply only to a transformation flow",
    );
    const manifest = providerReference(
      root,
      configuredPackageReference(pkg),
    ).manifest;
    const schema = manifest.authoring?.transformationSettingsSchema;
    check(
      schema,
      "CAPABILITY",
      "This installed provider does not support transformation output authoring",
    );
    if (options.transformationSettings !== undefined) {
      validateSchemaShape(schema);
      const ajv = new Ajv2020({ strict: true, validateFormats: false });
      const validate = ajv.compile(schema);
      check(
        validate(options.transformationSettings),
        "INPUT",
        `Transformation settings: ${ajv.errorsText(validate.errors)}`,
      );
    }
    if (options.outputContract)
      contractColumns(options.outputContract, "Output contract");
  }
  if (options.language) {
    check(
      options.kind === "transformation",
      "FLOW",
      "Select a logic language only for a transformation flow",
    );
    const languages = providerReference(root, configuredPackageReference(pkg))
      .manifest.capabilities?.transformationLanguages;
    check(
      languages?.includes(options.language) ||
        (!languages && options.language === "sql"),
      "CAPABILITY",
      `This installed provider does not support ${options.language} transformation authoring`,
    );
  }
  const environments = Object.values(raw.environments).map((ref: any) => {
    check(
      ref.$resolve,
      "AUTHORING",
      "Keep editable environments in referenced files",
    );
    const file = reader.path(ref.$resolve);
    return {
      path: relative(reader.root, file),
      text: reader.text(file),
      value: yaml(reader.text(file), file).toJS(),
    };
  });
  const files = providerAuthor(
    root,
    resolvePackage(root, configuredPackageReference(pkg)).reference,
    {
      operation: "flow",
      options,
      configuration,
      project: resolved,
      environments,
    },
    (name) =>
      name.startsWith(`flows/${options.id}/`) ||
      environments.some((e) => e.path === name),
  );
  const file = `flows/${options.id}/flow.yaml`;
  check(files[file], "PROVIDER", "Provider must author the requested flow");
  for (const name of Object.keys(files).filter((name) =>
    name.startsWith(`flows/${options.id}/`),
  ))
    check(
      !existsSync(fence(root, name)),
      "OWNER",
      `Flow creation would replace existing ${name}`,
    );
  check(
    !existsSync(resolve(root, file)),
    "OWNER",
    `Existing flow file ${file}`,
  );
  project.set("flows", [...raw.flows, { $resolve: "./" + file }]);
  files["project.yaml"] = project.toString();
  return preview(root, files);
}
export function validateAuthoredConnection(
  reader: Configuration,
  project: ReturnType<typeof projectSchema.parse>,
  environment: string,
  connection: ReturnType<typeof projectSchema.parse>["connections"][string],
  reference?: string,
) {
  // Native and bridge settings are owned by their platform, not a portable schema.
  if (
    !connection.package ||
    ["native", "bridge"].includes(connection.route ?? "")
  )
    return;
  const pkg = projectPackages(project)[connection.package];
  check(pkg || reference, "PACKAGE", "Unknown connector package configuration");
  const locked = resolvePackage(
    reader.root,
    reference ?? configuredPackageReference(pkg),
  );
  const manifest = connectorPackageSchema.parse(packageYaml(locked.file));
  check(
    !connection.connector || connection.connector === manifest.connector,
    "CONNECTION",
    "Connection differs from installed connector identity",
  );
  check(
    manifest.upstream.licenceStatus === "evidenced",
    "LICENCE",
    "Connector licence evidence is unresolved",
  );
  resolveConnectionSettings(
    reader,
    project,
    environment,
    connection,
    manifest.definition.settingsSchema,
  );
}

/** Author a connector instance after offline validation, without source access. */
export function addConnection(
  root: string,
  options: {
    id: string;
    package: string;
    sourceId: string;
    tenantId: string;
    binding?: string;
    settings: Record<string, unknown>;
    reference?: string;
  },
  environment = "dev",
  registration?: Proposal,
) {
  const reader = new Configuration(root, {});
  const replacement = registration?.changes.find(
    (change) => change.path === "project.yaml",
  );
  const project = yaml(
    replacement?.after ?? reader.text("project.yaml"),
    "project.yaml",
  );
  const parsed = projectSchema.parse(reader.load());
  check(
    !Object.hasOwn(parsed.connections, options.id),
    "OWNER",
    `Connection ${options.id} already exists`,
  );
  const connection = {
    package: options.package,
    sourceId: options.sourceId,
    tenantId: options.tenantId,
    ...(options.binding ? { binding: options.binding } : {}),
    settings: options.settings,
  };
  validateAuthoredConnection(
    reader,
    parsed,
    environment,
    connection,
    registration ? options.reference : undefined,
  );
  project.setIn(["connections", options.id], connection);
  return preview(
    root,
    {
      ...Object.fromEntries(
        registration?.changes.map((change) => [change.path, change.after]) ??
          [],
      ),
      "project.yaml": project.toString(),
    },
    { ...registration?.inputs, ...reader.files },
  );
}

/** Preserve route, package and binding ownership while reviewing portable settings. */
export function configureConnection(
  root: string,
  options: {
    id: string;
    sourceId: string;
    tenantId: string;
    settings: Record<string, unknown>;
  },
  environment = "dev",
) {
  const reader = new Configuration(root, {});
  const project = yaml(reader.text("project.yaml"), "project.yaml");
  const parsed = projectSchema.parse(reader.load());
  const raw = project.getIn(["connections", options.id], true);
  check(
    isYamlMap(raw) && !raw.has("$resolve"),
    "CONNECTION",
    "Open the definition to edit a missing or referenced connection",
  );
  const current = parsed.connections[options.id];
  check(current, "CONNECTION", "Unknown source connection");
  validateAuthoredConnection(reader, parsed, environment, {
    ...current,
    settings: options.settings,
  });
  for (const key of ["sourceId", "tenantId", "settings"] as const) {
    const previous = project.getIn(["connections", options.id, key], true);
    const anchors = new Set<string>();
    visit(isNode(previous) ? previous : null, {
      Node(_, node) {
        if (node.anchor) anchors.add(node.anchor);
      },
    });
    // A sibling alias must retain its old value when its original anchor is edited.
    // Materialise only aliases to nodes being removed; retain all other anchors.
    if (anchors.size)
      visit(project, {
        Alias(_, node) {
          if (!anchors.has(node.source)) return;
          const copy = project.createNode(
            node.toJS(project, { maxAliasCount: 50 }),
            { aliasDuplicateObjects: false },
          );
          copy.comment = node.comment;
          copy.commentBefore = node.commentBefore;
          copy.spaceBefore = node.spaceBefore;
          return copy;
        },
      });
    project.setIn(["connections", options.id, key], options[key]);
  }
  return preview(root, { "project.yaml": project.toString() }, reader.files);
}

/** Create a minimal reviewed-by-human starting point without reading source data. */
export function scaffoldContract(
  root: string,
  options: {
    id: string;
    table: string;
    field: string;
    type: "string" | "integer" | "number" | "boolean";
  },
) {
  const path = `contracts/${options.id}.odcs.yaml`;
  check(
    !existsSync(fence(root, path)),
    "OWNER",
    `Contract ${path} already exists`,
  );
  const physicalTypes = {
    string: "STRING",
    integer: "BIGINT",
    number: "DOUBLE",
    boolean: "BOOLEAN",
  };
  const contract = {
    apiVersion: "v3.1.0",
    kind: "DataContract",
    id: options.id,
    name: options.id.replaceAll("-", " "),
    version: "0.1.0",
    status: "draft",
    description: {
      purpose: "Review this draft against source metadata before approval.",
    },
    schema: [
      {
        name: options.table,
        logicalType: "object",
        physicalType: "table",
        properties: [
          {
            name: options.field,
            logicalType: options.type,
            physicalType: physicalTypes[options.type],
            required: false,
          },
        ],
      },
    ],
  };
  contractColumns(contract, path);
  return preview(root, { [path]: stringify(contract) });
}

/** Add a connection-backed ingestion flow with one selected ODCS table. */
export function addConnectionFlow(
  root: string,
  options: {
    id: string;
    provider: string;
    connection: string;
    table: string;
    contract: string;
    source: Record<string, unknown>;
    execution?: Record<string, unknown>;
  },
) {
  const reader = new Configuration(root);
  const project = yaml(reader.text("project.yaml"), "project.yaml");
  const raw = project.toJS();
  const parsed = projectSchema.parse(reader.load());
  check(
    !parsed.flows.some((flow: any) => flow?.id === options.id),
    "OWNER",
    `Flow ${options.id} already exists`,
  );
  check(
    parsed.connections[options.connection],
    "CONNECTION",
    "Select a configured connection",
  );
  check(
    parsed.providers.configurations[options.provider],
    "PROVIDER",
    "Select a configured provider",
  );
  check(
    !resolve(root, options.contract).startsWith(
      resolve(root, "flows", options.id) + "/",
    ),
    "PATH",
    "Contract must be outside the new flow directory",
  );
  const contractFile = fence(root, options.contract);
  check(existsSync(contractFile), "ODCS", "Contract file is missing");
  contractColumns(reader.load(options.contract), options.contract);
  const path = `flows/${options.id}/flow.yaml`;
  check(
    !existsSync(fence(root, path)),
    "OWNER",
    `Flow ${options.id} already exists`,
  );
  const contractRef = relative(
    dirname(resolve(root, path)),
    contractFile,
  ).replaceAll("\\", "/");
  const flow = {
    apiVersion: "ingestron.flow/v1",
    kind: "ingestion",
    id: options.id,
    provider: options.provider,
    ingestion: {
      connection: options.connection,
      execution: options.execution ?? { mode: "local" },
    },
    tables: {
      [options.table]: {
        source: options.source,
        contract: {
          $resolve: contractRef.startsWith(".")
            ? contractRef
            : `./${contractRef}`,
        },
      },
    },
  };
  project.set("flows", [...raw.flows, { $resolve: `./${path}` }]);
  return preview(root, {
    "project.yaml": project.toString(),
    [path]: stringify(flow),
  });
}
/** Apply a reviewed source-field selection to one ODCS table. Approval remains separate. */
export function mapContractFields(
  root: string,
  options: {
    apiVersion: "ingestron.field-mapping/v1";
    flow: string;
    environment: string;
    contract: string;
    discovery: string;
    stream: string;
    table: string;
    fields: { source: string; target: string }[];
  },
  reviewedInputs: Record<string, string> = {},
) {
  const reader = new Configuration(root);
  const discovered = JSON.parse(reader.text(options.discovery));
  check(
    discovered.apiVersion === "ingestron.singer-discovery/v1",
    "DISCOVERY",
    "Select saved Singer discovery evidence",
  );
  const stream = discovered.catalog?.streams?.find(
    (entry: any) =>
      entry?.stream === options.stream ||
      entry?.tap_stream_id === options.stream,
  );
  check(
    stream,
    "DISCOVERY",
    "Selected source dataset is absent from discovery",
  );
  const sourceFields = stream.schema?.properties;
  check(
    sourceFields &&
      typeof sourceFields === "object" &&
      !Array.isArray(sourceFields),
    "DISCOVERY",
    "Discovery has no field schema",
  );
  const bound = contractLocation(root, options.flow, options.table);
  const split = options.contract.indexOf("#");
  const suppliedPath =
    split < 0 ? options.contract : options.contract.slice(0, split);
  const fragment =
    split < 0 ? "" : decodeURIComponent(options.contract.slice(split + 1));
  check(
    !fragment || fragment.startsWith("/"),
    "CONTRACT",
    "Use an exact contract JSON pointer",
  );
  const suppliedPointer = fragment
    ? fragment
        .slice(1)
        .split("/")
        .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    : [];
  check(
    relative(reader.root, reader.path(suppliedPath)) === bound.path &&
      canonical(suppliedPointer.map(String)) ===
        canonical(bound.pointer.map(String)),
    "CONTRACT",
    "Selected contract differs from the authoritative workflow table binding",
  );
  const doc = yaml(reader.text(bound.path), bound.path);
  const contract = bound.pointer.reduce(
    (parent: any, part) => parent?.[part],
    doc.toJS(),
  );
  contractColumns(contract, options.contract);
  check(
    contract.schema[0].name === options.table,
    "ODCS",
    "Selected contract table differs from the workflow table",
  );
  const previous = new Map(
    contract.schema[0].properties.map((property: any) => [
      property.physicalName ?? property.name,
      property,
    ]),
  );
  const previousTargets = new Map(
    contract.schema[0].properties.map((property: any) => [
      property.name,
      property,
    ]),
  );
  const sources = new Set<string>(),
    targets = new Set<string>();
  const properties = options.fields.map(({ source, target }) => {
    check(
      Object.hasOwn(sourceFields, source) && !sources.has(source),
      "MAPPING",
      `Unknown or duplicate source field ${source}`,
    );
    check(!targets.has(target), "MAPPING", `Duplicate target field ${target}`);
    sources.add(source);
    targets.add(target);
    const old = (previous.get(source) ?? previousTargets.get(target)) as any;
    if (old) {
      const next = { ...old, name: target };
      if (source !== target) next.physicalName = source;
      else delete next.physicalName;
      return next;
    }
    const shape = sourceFields[source],
      types = Array.isArray(shape?.type) ? shape.type : [shape?.type];
    const type = types.find((value: unknown) => value !== "null");
    const physicalType = (
      {
        string: "STRING",
        integer: "BIGINT",
        number: "DOUBLE",
        boolean: "BOOLEAN",
      } as Record<string, string>
    )[String(type)];
    check(
      physicalType,
      "MAPPING",
      `Source field ${source} needs an explicitly authored ODCS type`,
    );
    return {
      name: target,
      ...(source !== target ? { physicalName: source } : {}),
      logicalType: type,
      physicalType,
      required: !types.includes("null"),
    };
  });
  check(properties.length > 0, "MAPPING", "Select at least one source field");
  doc.setIn([...bound.pointer, "schema", 0, "properties"], properties);
  doc.setIn([...bound.pointer, "status"], "draft");
  contractColumns(
    bound.pointer.reduce((parent: any, part) => parent?.[part], doc.toJS()),
    options.contract,
  );
  for (const [path, hash] of Object.entries(reviewedInputs))
    check(
      !reader.files[path] || reader.files[path] === hash,
      "STALE",
      "Reviewed mapping inputs changed",
    );
  return preview(
    root,
    { [bound.path]: doc.toString() },
    { ...reader.files, ...reviewedInputs },
  );
}
export function addTable(
  root: string,
  options: { flow: string; id: string; contract: string },
) {
  const { file, doc } = flowFile(root, options.flow);
  check(
    doc.get("kind") === "ingestion",
    "FLOW",
    "table add requires an ingestion flow",
  );
  check(/^[A-Za-z_][\w-]*$/.test(options.id), "TABLE", "Invalid table ID");
  check(
    !doc.hasIn(["tables", options.id]),
    "OWNER",
    `Table ${options.id} already exists`,
  );
  const reader = new Configuration(root),
    contract = reader.load(options.contract),
    target = `flows/${options.flow}/01-ingest/contracts/${options.id}.odcs.yaml`;
  contractColumns(contract);
  const table = {
    contract: { $resolve: `./01-ingest/contracts/${options.id}.odcs.yaml` },
  };
  doc.setIn(["tables", options.id], table);
  return preview(root, {
    [relative(realpathSync(root), file)]: doc.toString(),
    [target]: stringify(contract),
  });
}
export function configureTable(
  root: string,
  flow: string,
  id: string,
  patch: Record<string, unknown>,
) {
  const { file, doc } = flowFile(root, flow);
  check(doc.hasIn(["tables", id]), "TABLE", `Unknown table ${id}`);
  check(
    !("id" in patch) && !("contract" in patch),
    "AUTHORING",
    "Identity/contract changes require an explicit file edit",
  );
  doc.setIn(["tables", id], merge(doc.toJS().tables[id], patch));
  return preview(root, {
    [relative(realpathSync(root), file)]: doc.toString(),
  });
}
export function addDataset(
  root: string,
  options: { flow: string; id: string; contract: string; from: string },
) {
  const { file, doc } = flowFile(root, options.flow);
  check(
    doc.get("kind") === "transformation",
    "FLOW",
    "dataset add requires a transformation flow",
  );
  check(
    !doc.hasIn(["publishes", options.id]),
    "OWNER",
    "Dataset already exists",
  );
  const reader = new Configuration(root),
    contract = reader.load(options.contract);
  contractColumns(contract);
  const target = `flows/${options.flow}/contracts/${options.id}.odcs.yaml`;
  doc.setIn(["publishes", options.id], {
    from: options.from,
    contract: { $resolve: `./contracts/${options.id}.odcs.yaml` },
  });
  return preview(root, {
    [relative(realpathSync(root), file)]: doc.toString(),
    [target]: stringify(contract),
  });
}
export function addEnvironment(
  root: string,
  options: { name: string; from: string },
) {
  check(
    validProjectIdentifier(options.name),
    "ENVIRONMENT",
    "Invalid environment identifier",
  );
  const reader = new Configuration(root);
  const project = yaml(reader.text("project.yaml"), "project.yaml");
  const raw = project.toJS();
  check(
    raw.environments && !Object.hasOwn(raw.environments, options.name),
    "OWNER",
    `Environment ${options.name} already exists`,
  );
  check(
    Object.hasOwn(raw.environments, options.from),
    "ENVIRONMENT",
    `Unknown source environment ${options.from}`,
  );
  const source = raw.environments[options.from];
  if (typeof source?.$resolve !== "string") {
    check(
      source?.apiVersion === "ingestron.environment/v1",
      "ENVIRONMENT",
      "Expected an environment document",
    );
    const original = project.getIn(["environments", options.from]);
    check(
      isYamlMap(original),
      "ENVIRONMENT",
      "Expected an inline environment mapping",
    );
    const profile = original.clone();
    check(
      isYamlMap(profile),
      "ENVIRONMENT",
      "Expected an inline environment mapping",
    );
    // The copied mapping stays in project.yaml, so relative references and
    // aliases to shared project values retain their original scope.
    const occupied = new Set<string>();
    visit(project, {
      Value(_key, node) {
        if (node.anchor) occupied.add(node.anchor);
      },
    });
    const anchors = new Map<string, string>();
    visit(profile, {
      Value(_key, node) {
        if (!node.anchor) return;
        const base = `env_${options.name}_${node.anchor}`;
        let candidate = base,
          suffix = 2;
        while (occupied.has(candidate)) candidate = `${base}_${suffix++}`;
        occupied.add(candidate);
        anchors.set(node.anchor, candidate);
        node.anchor = candidate;
      },
    });
    visit(profile, {
      Alias(_key, node) {
        node.source = anchors.get(node.source) ?? node.source;
      },
    });
    profile.set("environment", options.name);
    project.setIn(["environments", options.name], profile);
    return preview(root, { "project.yaml": project.toString() });
  }
  // Copy beside the source so every relative reference keeps its meaning.
  const sourceFile = reader.path(source.$resolve);
  const destination = resolve(dirname(sourceFile), `${options.name}.yaml`);
  const target = relative(reader.root, destination);
  fence(reader.root, target);
  check(
    !existsSync(destination),
    "OWNER",
    `Existing environment file ${target}`,
  );
  const profile = yaml(reader.text(sourceFile), sourceFile);
  check(
    profile.toJS()?.apiVersion === "ingestron.environment/v1",
    "ENVIRONMENT",
    "Expected an environment document",
  );
  profile.set("environment", options.name);
  project.setIn(["environments", options.name], { $resolve: "./" + target });
  return preview(root, {
    [target]: profile.toString(),
    "project.yaml": project.toString(),
  });
}

export function editValue(
  root: string,
  environment: string,
  pointer: string,
  value: unknown,
) {
  const reader = new Configuration(root),
    project = yaml(reader.text("project.yaml"), "project.yaml").toJS(),
    selected = project.environments[environment];
  check(
    selected?.$resolve,
    "ENVIRONMENT",
    "Environment values must be in a referenced environment file for editing",
  );
  const file = reader.path(selected.$resolve),
    doc = yaml(reader.text(file), file);
  const keys = pointer.split(".");
  check(
    keys.length &&
      ["values", "bindings"].includes(keys[0]) &&
      keys.every((k) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)),
    "CONFIG",
    "Use a values.* or bindings.* field path",
  );
  doc.setIn(keys, value);
  return preview(root, { [relative(reader.root, file)]: doc.toString() });
}
export function configureFlow(
  root: string,
  flow: string,
  patch: Record<string, unknown>,
) {
  const { file, doc } = flowFile(root, flow);
  check(
    !["apiVersion", "id", "kind", "tables", "steps"].some((k) => k in patch),
    "AUTHORING",
    "Use dedicated table/step commands for structural changes",
  );
  return preview(root, {
    [relative(realpathSync(root), file)]: stringify(merge(doc.toJS(), patch)),
  });
}

export function editableProject(root: string) {
  const reader = new Configuration(root);
  const documents = new Map<string, ReturnType<typeof parseDocument>>();
  const document = (file: string) => {
    if (!documents.has(file))
      documents.set(file, yaml(reader.text(file), file));
    return documents.get(file)!;
  };
  type Location = {
    file: string;
    prefix: (string | number)[];
    chain?: string[];
  };
  const location = (start: Location): Location => {
    let current = start;
    const chain = [start.file];
    const seen = new Set<string>();
    for (let depth = 0; depth < 64; depth++) {
      const key = current.file + "#" + canonical(current.prefix);
      check(!seen.has(key), "CYCLE", "Editable reference cycle");
      seen.add(key);
      const raw: any = document(current.file).toJS();
      const value = current.prefix.reduce(
        (parent: any, part) => parent?.[part],
        raw,
      );
      if (!value?.$resolve) return { ...current, chain };
      const reference = String(value.$resolve);
      reader.load(reference, current.file); // Apply the authoritative include/pointer fences.
      const split = reference.indexOf("#");
      const path = split < 0 ? reference : reference.slice(0, split);
      const pointer =
        split < 0 ? "" : decodeURIComponent(reference.slice(split + 1));
      const file = path ? reader.path(path, current.file) : current.file;
      const prefix = pointer
        ? pointer
            .slice(1)
            .split("/")
            .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
        : [];
      current = { file, prefix };
      chain.push(file);
    }
    throw new Problem("LIMIT", "Editable includes exceed 64 levels");
  };
  const projectFile = reader.path("project.yaml");
  const project = document(projectFile).toJS();
  const selectFlow = (id: string) => {
    const matches: Location[] = [];
    for (let index = 0; index < (project.flows ?? []).length; index++) {
      const candidate = location({
        file: projectFile,
        prefix: ["flows", index],
      });
      if (document(candidate.file).getIn([...candidate.prefix, "id"]) === id)
        matches.push(candidate);
    }
    check(matches.length === 1, "FLOW", "Select one existing flow identity");
    return matches[0];
  };
  return { reader, document, location, projectFile, selectFlow };
}

function providerOptionsEditor(root: string, configuration: string) {
  const workspace = editableProject(root);
  let target = workspace.location({
    file: workspace.projectFile,
    prefix: ["providers"],
  });
  target = workspace.location({
    file: target.file,
    prefix: [...target.prefix, "configurations"],
  });
  target = workspace.location({
    file: target.file,
    prefix: [...target.prefix, configuration],
  });
  check(
    workspace.document(target.file).hasIn([...target.prefix, "package"]),
    "PROVIDER",
    "Choose an existing provider configuration",
  );
  target = workspace.location({
    file: target.file,
    prefix: [...target.prefix, "options"],
  });
  const doc = workspace.document(target.file),
    node = doc.getIn(target.prefix, true);
  check(
    node === undefined || isYamlMap(node),
    "AUTHORING",
    "Provider options must use their own mapping; edit a shared YAML alias in the definition",
  );
  if (isYamlMap(node) && node.anchor) {
    visit(doc, {
      Alias(_key, alias) {
        check(
          alias.source !== node.anchor,
          "AUTHORING",
          "Provider options use a shared YAML alias; edit the shared definition",
        );
      },
    });
  }
  const pointer = target.prefix
    .map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/");
  const options =
    node === undefined
      ? {}
      : workspace.reader.load(target.file + (pointer ? "#/" + pointer : ""));
  return { workspace, target, doc, options };
}
export function providerOptionsDefinition(root: string, configuration: string) {
  const { workspace, target, options } = providerOptionsEditor(
    root,
    configuration,
  );
  return {
    path: relative(workspace.reader.root, target.file),
    pointer: target.prefix,
    options,
  };
}
/** Change only differing option leaves, retaining neighbouring YAML nodes and comments. */
export function configureProviderOptions(
  root: string,
  configuration: string,
  options: Record<string, unknown>,
  inputs?: Record<string, string>,
) {
  const {
    workspace,
    target,
    options: before,
  } = providerOptionsEditor(root, configuration);
  const changed = new Set<string>();
  const update = (
    position: { file: string; prefix: (string | number)[] },
    previous: any,
    next: any,
  ) => {
    if (canonical(previous) === canonical(next)) return;
    const actual = workspace.location(position),
      current = workspace.document(actual.file);
    const maps = (value: any) =>
      !!value && typeof value === "object" && !Array.isArray(value);
    if (
      maps(previous) &&
      maps(next) &&
      isYamlMap(current.getIn(actual.prefix, true))
    ) {
      for (const key of Object.keys(previous))
        if (!Object.hasOwn(next, key)) {
          current.deleteIn([...actual.prefix, key]);
          changed.add(actual.file);
        }
      for (const [key, value] of Object.entries(next)) {
        if (Object.hasOwn(previous, key))
          update(
            { file: actual.file, prefix: [...actual.prefix, key] },
            previous[key],
            value,
          );
        else {
          current.setIn([...actual.prefix, key], value);
          changed.add(actual.file);
        }
      }
    } else {
      current.setIn(actual.prefix, next);
      changed.add(actual.file);
    }
  };
  update(target, before, options);
  return preview(
    root,
    Object.fromEntries(
      [...changed].map((file) => [
        relative(workspace.reader.root, file),
        workspace.document(file).toString(),
      ]),
    ),
    inputs,
  );
}

/** Edit only the authoritative schedule node, preserving inline/referenced flow layout and comments. */
export function configureSchedule(
  root: string,
  flow: string,
  schedule: Schedule | null,
) {
  const workspace = editableProject(root);
  const selected = workspace.selectFlow(flow);
  const doc = workspace.document(selected.file);
  const path = [...selected.prefix, "schedule"];
  if (schedule === null) doc.deleteIn(path);
  else doc.setIn(path, scheduleSchema.parse(schedule));
  return preview(root, {
    [relative(workspace.reader.root, selected.file)]: doc.toString(),
  });
}

/** Locate the authoritative contract node without rewriting its layout. */
export function authoringLocations(root: string, flowId: string) {
  return describeAuthoringLocations(editableProject(root), flowId);
}
function describeAuthoringLocations(
  workspace: ReturnType<typeof editableProject>,
  flowId: string,
) {
  const { reader, document, location, selectFlow } = workspace;
  const selected = selectFlow(flowId);
  const describe = (target: { file: string; prefix: (string | number)[] }) => ({
    path: relative(reader.root, target.file),
    pointer: target.prefix,
    documentRevision: reader.files[relative(reader.root, target.file)],
  });
  const value: any = document(selected.file).toJS();
  const flow = selected.prefix.reduce(
    (parent: any, part) => parent?.[part],
    value,
  );
  const names = Object.keys(flow.tables ?? {});
  check(
    names.length <= 100,
    "LIMIT",
    "Locate at most 100 table definitions per flow",
  );
  const tables = Object.fromEntries(
    names.map((name) => {
      const table = location({
        file: selected.file,
        prefix: [...selected.prefix, "tables", name],
      });
      const contract = location({
        file: table.file,
        prefix: [...table.prefix, "contract"],
      });
      const node: any = document(contract.file).getIn(contract.prefix, true);
      return [
        name,
        {
          ...describe(table),
          ...(node?.get?.("kind") === "DataContract" &&
          node?.get?.("apiVersion") === "v3.1.0"
            ? { contract: describe(contract) }
            : {}),
        },
      ];
    }),
  );
  return { flow: describe(selected), tables };
}

/** One consistent source read for bounded editor estates, with the same fences as individual locations. */
export function authoringLocationsBatch(root: string, flows: string[]) {
  check(new Set(flows).size === flows.length, "FLOW", "Choose each flow once");
  const workspace = editableProject(root);
  const locations = Object.fromEntries(
    flows.map((id) => [id, describeAuthoringLocations(workspace, id)]),
  );
  const paths = new Set<string>();
  for (const value of Object.values(locations)) {
    paths.add(value.flow.path);
    for (const table of Object.values(value.tables)) {
      paths.add(table.path);
      if (table.contract) paths.add(table.contract.path);
    }
  }
  const documents = Object.fromEntries(
    [...paths].sort().map((path) => {
      check(
        /\.ya?ml$/.test(path) &&
          !path.split("/").some((part) => part.startsWith(".")),
        "PATH",
        "Read only visible project configuration files",
      );
      const physical = relative(
        workspace.reader.root,
        workspace.reader.path(path),
      );
      check(
        !physical.split("/").some((part) => part.startsWith(".")),
        "PATH",
        "A visible definition cannot redirect to private files",
      );
      const expected = workspace.reader.files[path];
      const content = workspace.reader.text(path),
        sha256 = digest(content);
      check(
        expected === sha256,
        "STALE",
        "Definition changed while locations were read",
      );
      return [path, { content, sha256 }];
    }),
  );
  const result = { flows: locations, documents };
  check(
    Buffer.byteLength(JSON.stringify(result)) <= 6 * 1024 * 1024,
    "LIMIT",
    "Authoring batch exceeds 6 MiB; select fewer flows",
  );
  return result;
}

export function contractLocation(
  root: string,
  flowId: string,
  tableId: string,
) {
  const { reader, document, location, selectFlow } = editableProject(root);
  const flow = selectFlow(flowId);
  check(
    document(flow.file).hasIn([...flow.prefix, "tables", tableId]),
    "TABLE",
    "Choose an existing input table",
  );
  const table = location({
    file: flow.file,
    prefix: [...flow.prefix, "tables", tableId],
  });
  const contract = location({
    file: table.file,
    prefix: [...table.prefix, "contract"],
  });
  const value: any = document(contract.file).getIn(contract.prefix, true);
  check(
    value?.get?.("kind") === "DataContract" &&
      value?.get?.("apiVersion") === "v3.1.0",
    "CONTRACT",
    "Choose a locally resolved ODCS contract",
  );
  return {
    path: relative(reader.root, contract.file),
    pointer: contract.prefix,
    documentRevision: reader.files[relative(reader.root, contract.file)],
  };
}

/** One reviewed proposal for execution settings and selected table sources. */
export function configureIngestion(
  root: string,
  args: {
    flow: string;
    execution: Record<string, unknown>;
    sources: Record<string, Record<string, unknown>>;
  },
) {
  check(
    Object.keys(args.sources).length <= 100,
    "LIMIT",
    "Configure at most 100 table sources at once",
  );
  const { reader, document, location, projectFile, selectFlow } =
    editableProject(root);
  const flow = selectFlow(args.flow),
    doc = document(flow.file);
  check(
    doc.getIn([...flow.prefix, "kind"]) === "ingestion",
    "FLOW",
    "Execution/source configuration requires an ingestion flow",
  );
  const edits = new Map<string, string>();
  const changed = new Set<string>([flow.file]);
  const inputs = new Set<string>([projectFile, ...(flow.chain ?? [])]);
  for (const [table, source] of Object.entries(args.sources)) {
    check(
      doc.hasIn([...flow.prefix, "tables", table]),
      "TABLE",
      `Unknown table ${table}`,
    );
    const target = location({
      file: flow.file,
      prefix: [...flow.prefix, "tables", table],
    });
    const key = target.file + "#" + canonical(target.prefix);
    for (const file of target.chain ?? []) inputs.add(file);
    const serialised = canonical(source);
    check(
      !edits.has(key) || edits.get(key) === serialised,
      "OWNER",
      "Shared table definitions cannot receive conflicting source policies",
    );
    edits.set(key, serialised);
    document(target.file).setIn([...target.prefix, "source"], source);
    changed.add(target.file);
  }
  doc.setIn([...flow.prefix, "ingestion", "execution"], args.execution);
  check(
    inputs.size <= 201,
    "LIMIT",
    "Configure fewer tables or simplify references; at most 201 reviewed input files are supported",
  );
  return preview(
    root,
    Object.fromEntries(
      [...changed].map((file) => [
        relative(reader.root, file),
        document(file).toString(),
      ]),
    ),
    Object.fromEntries(
      [...inputs].map((file) => [
        relative(reader.root, file),
        reader.files[relative(reader.root, file)],
      ]),
    ),
  );
}
export function addStep(
  root: string,
  flow: string,
  step: unknown,
  after?: string,
) {
  const { file, doc } = flowFile(root, flow);
  const value: any = step;
  check(
    doc.toJS().kind === "transformation",
    "FLOW",
    "Ingestion steps are owned by the standard; use a transformation flow",
  );
  {
    const steps: any[] = doc.toJS().steps ?? [];
    check(
      !steps.some((s) => s.id === value.id),
      "OWNER",
      "Step already exists",
    );
    const at = after
      ? steps.findIndex((s) => s.id === after)
      : steps.length - 1;
    check(!after || at >= 0, "STEP", `Unknown predecessor ${after}`);
    steps.splice(at + 1, 0, step);
    doc.set("steps", steps);
  }
  return preview(root, {
    [relative(realpathSync(root), file)]: doc.toString(),
  });
}

/** Configure saved policy through the standard atomic reviewed proposal. */
export function configurePolicy(root: string, policy: ProjectPolicy): Proposal {
  const parsed = policySchema.parse(policy);
  const reader = new Configuration(root, {});
  reader.load();
  const project = yaml(reader.text("project.yaml"), "project.yaml");
  const raw = project.toJS({ maxAliasCount: 100 });
  if (
    raw.policy &&
    typeof raw.policy === "object" &&
    typeof raw.policy.$resolve === "string"
  ) {
    const path = relative(reader.root, reader.path(raw.policy.$resolve));
    const document = yaml(reader.text(path), path);
    for (const key of Object.keys(document.toJS({ maxAliasCount: 100 })))
      if (!Object.hasOwn(parsed, key)) document.delete(key);
    for (const [key, value] of Object.entries(parsed)) document.set(key, value);
    return preview(root, { [path]: document.toString() });
  }
  if (raw.policy !== undefined) {
    project.set("policy", parsed);
    return preview(root, { "project.yaml": project.toString() });
  }
  const path = "governance/policy.yaml";
  check(
    !existsSync(fence(root, path)),
    "OWNER",
    "Policy destination already exists; connect it explicitly before editing",
    path,
  );
  project.set("policy", { $resolve: "./" + path });
  return preview(root, {
    "project.yaml": project.toString(),
    [path]: stringify(parsed),
  });
}
