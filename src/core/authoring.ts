import { friendlyReference } from "./provider-catalogue.js";
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
import { parseDocument, stringify } from "yaml";
import { check, digest, canonical, merge, Problem } from "./errors.js";
import { Configuration } from "./config.js";
import { contractColumns } from "./contracts.js";
import {
  fence,
  installedProviders,
  canonicalPackageReference,
} from "./packages.js";
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
  return digest(canonical({ files: reader.files, lock }));
}

export function preview(
  root: string,
  replacements: Record<string, string>,
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
export function initialise(
  root: string,
  options: { id: string; provider?: string; environments?: string[] },
) {
  check(/^[A-Za-z_][\w-]*$/.test(options.id), "PROJECT", "Invalid project ID");
  const environments = options.environments ?? ["dev", "test", "prod"];
  check(
    environments.length > 0 &&
      new Set(environments).size === environments.length &&
      environments.every((e) => /^[A-Za-z_][\w-]*$/.test(e)),
    "ENVIRONMENT",
    "Use distinct environment identifiers",
  );
  mkdirSync(root, { recursive: true });
  if (!options.provider) {
    const files: Record<string, string> = {
      "project.yaml": stringify({
        apiVersion: "ingestron.project/v1",
        id: options.id,
        providers: { packages: {}, configurations: {} },
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
  check(
    doc.hasIn(["providers", "packages", options.package]),
    "PACKAGE",
    "Unknown project package",
  );
  const selected = providerReference(root, options.to);
  doc.setIn(["providers", "packages", options.package], {
    source: selected.source,
    version: selected.version,
  });
  return preview(root, { "project.yaml": doc.toString() });
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
  const config = resolved.providers.configurations[configuration];
  check(config, "PROVIDER", "Select a provider configuration for this flow");
  const pkg = resolved.providers.packages[config.package];
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
    `${pkg.source}@${pkg.version}`,
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
  check(
    !existsSync(resolve(root, file)),
    "OWNER",
    `Existing flow file ${file}`,
  );
  project.set("flows", [...raw.flows, { $resolve: "./" + file }]);
  files["project.yaml"] = project.toString();
  return preview(root, files);
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
    /^[A-Za-z_][\w-]*$/.test(options.name) &&
      !["__proto__", "constructor", "prototype"].includes(options.name),
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
  check(
    typeof source?.$resolve === "string",
    "ENVIRONMENT",
    "The source environment must be in a referenced file",
  );
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
