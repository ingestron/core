import { requireFlowTarget } from "./bridge-connections.js";
/** Reviewed native bridge composition. Provider contracts own resource semantics. */
import { z } from "zod";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseDocument, visit } from "yaml";
import { editableProject, preview } from "./authoring.js";
import { check, canonical } from "./errors.js";
import { auditSecrets } from "./planner.js";
import { projectSchema } from "./schema.js";
import { projectPackages } from "./project-packages.js";
import { configuredPackageReference, fence } from "./packages.js";
import { providerReference } from "../plugins/authoring.js";
const map = z.record(z.string(), z.unknown());
export const sourceBridgeSchema = z
  .object({
    provider: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/),
    kind: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
    sourceBinding: map,
    landing: map,
    handoverBinding: map,
    publication: map,
    publisherOptions: map,
    frozenSource: z.literal(true),
  })
  .strict();

export function attachSourceBridge(
  root: string,
  environment: string,
  args: {
    id: string;
    connection: string;
    target: { provider: string; ingestion: Record<string, unknown> };
    bridge: z.infer<typeof sourceBridgeSchema>;
  },
  base: ReturnType<typeof preview>,
) {
  const w = editableProject(root),
    project = projectSchema.parse(w.reader.load());
  const spec = sourceBridgeSchema.parse(args.bridge);
  check(
    args.id.length <= 64,
    "LIMIT",
    "Use a bridge flow name of at most 64 characters",
  );
  auditSecrets(spec, "bridge");
  requireFlowTarget(project, args.target.provider);
  const consumer = project.providers.configurations[args.target.provider];
  const landing = project.providers.configurations[spec.provider];
  check(
    consumer && landing && args.target.provider !== spec.provider,
    "PROVIDER",
    "Choose distinct landing and ingestion configurations",
  );
  const packages = projectPackages(project);
  const selected = (configuration: typeof consumer) =>
    providerReference(
      root,
      configuredPackageReference(packages[configuration.package]),
    );
  const producer = selected(landing),
    downstream = selected(consumer);
  const native = producer.manifest.sources?.[spec.kind];
  check(
    native?.route === "native" && native.standards.includes("snapshot-land@v1"),
    "CAPABILITY",
    "Landing provider must declare this native snapshot source",
  );
  check(
    args.target.ingestion.standard === "snapshot-with-history@v1" &&
      ["snapshot-publication@v1", "snapshot-with-history@v1"].every((id) =>
        downstream.manifest.standards?.some((s) => s.id === id),
      ),
    "CAPABILITY",
    "Ingestion provider must support snapshot publication and history",
  );
  check(
    [producer, downstream].every((p) =>
      p.manifest.capabilities?.handovers.includes("files"),
    ),
    "CAPABILITY",
    "Both providers must declare file handovers",
  );
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  (addFormats as any)(ajv);
  check(
    native.bindingSchema &&
      ajv.compile(native.bindingSchema)(spec.sourceBinding),
    "CONNECTION",
    "Complete the native source binding required by the landing provider",
  );
  const schema = downstream.manifest.configurationSchema;
  const optionsSchema =
    typeof schema === "string"
      ? JSON.parse(
          readFileSync(
            fence(
              downstream.root,
              relative(
                downstream.root,
                resolve(dirname(downstream.file), schema),
              ),
            ),
            "utf8",
          ),
        )
      : schema;
  check(
    optionsSchema && ajv.compile(optionsSchema)(spec.publisherOptions),
    "PROVIDER",
    "Publication options do not satisfy the installed provider schema",
  );
  const names = {
    connection: `${args.id}_bridge`,
    publisher: `${args.id}_publisher`,
    source: `${args.id}_source`,
    files: `${args.id}_files`,
  };
  check(
    !project.connections[names.connection] &&
      !project.providers.configurations[names.publisher],
    "OWNER",
    "Bridge connection or publisher configuration already exists",
  );
  check(
    !project.flows.some((f: any) =>
      [args.id + "_land", args.id + "_publish"].includes(f.id),
    ),
    "OWNER",
    "Bridge leg names are already owned by another flow",
  );
  check(
    project.environments[environment],
    "ENVIRONMENT",
    "Choose an existing project environment",
  );
  const locate = (keys: string[]) => {
    let at = { file: w.projectFile, prefix: [] as (string | number)[] };
    for (const key of keys)
      at = w.location({ file: at.file, prefix: [...at.prefix, key] });
    return at;
  };
  const changed = new Set<string>();
  const put = (keys: string[], key: string, value: unknown) => {
    const at = locate(keys),
      doc = w.document(at.file);
    visit(doc, {
      Alias() {
        check(
          false,
          "AUTHORING",
          "Review shared YAML aliases before creating a bridge",
        );
      },
    });
    check(
      !doc.hasIn([...at.prefix, key]),
      "OWNER",
      "Bridge cannot overwrite an existing definition",
    );
    doc.setIn([...at.prefix, key], value);
    changed.add(at.file);
  };
  const envAt = locate(["environments", environment, "bindings"]);
  for (const other of Object.keys(project.environments).filter(
    (e) => e !== environment,
  )) {
    const at = locate(["environments", other, "bindings"]);
    check(
      at.file !== envAt.file ||
        canonical(at.prefix) !== canonical(envAt.prefix),
      "OWNER",
      "Environment bindings share storage; separate them before adding a bridge",
    );
  }
  const source = project.connections[args.connection];
  check(source, "CONNECTION", "Select the metadata source connection");
  put(["connections"], names.connection, {
    route: "bridge",
    kind: spec.kind,
    sourceId: source.sourceId,
    tenantId: source.tenantId,
    binding: names.source,
    settings: {},
    bridge: {
      provider: spec.provider,
      publisher: names.publisher,
      standard: "snapshot-land@v1",
      landing: spec.landing,
      handover: names.files,
      publication: spec.publication,
    },
  });
  put(["providers", "configurations"], names.publisher, {
    package: consumer.package,
    binding: consumer.binding,
    options: spec.publisherOptions,
  });
  put(
    ["environments", environment, "bindings"],
    names.source,
    spec.sourceBinding,
  );
  put(
    ["environments", environment, "bindings"],
    names.files,
    spec.handoverBinding,
  );
  const replacements = Object.fromEntries(
    base.changes.map((c) => [c.path, c.after]),
  );
  const registry = parseDocument(replacements["project.yaml"]);
  w.document(w.projectFile).set("flows", registry.get("flows", true));
  changed.add(w.projectFile);
  const flowPath = `flows/${args.id}/flow.yaml`,
    flow = parseDocument(replacements[flowPath]);
  flow.deleteIn(["defaults", "source"]);
  flow.setIn(["ingestion", "connection"], names.connection);
  replacements[flowPath] = flow.toString();
  for (const file of changed)
    replacements[relative(w.reader.root, file)] = w.document(file).toString();
  return preview(root, replacements, { ...base.inputs, ...w.reader.files });
}
