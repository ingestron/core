/** Reviewed composition of provider-owned file authoring. No connector credentials cross this boundary. */
import { relative, dirname } from "node:path";
import { existsSync } from "node:fs";
import { stringify, visit } from "yaml";
import { z } from "zod";
import { editableProject, preview } from "./authoring.js";
import { canonical, check, digest } from "./errors.js";
import { projectSchema, flowSchema } from "./schema.js";
import { projectPackages } from "./project-packages.js";
import {
  configuredPackageReference,
  resolvePackage,
  packageYaml,
  fence,
} from "./packages.js";
import { connectorPackageSchema } from "./connector-package.js";
import { resolveConnectionSettings } from "./connection-settings.js";
import { providerReference, providerAuthor } from "../plugins/authoring.js";
import { auditSecrets } from "./planner.js";
const id = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,65}$/);
export const fileHandoffReadSchema = z.object({ flow: id }).strict();
export const fileHandoffReviewSchema = fileHandoffReadSchema
  .extend({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    producer: id,
    consumer: id,
    immutableFiles: z.literal(true),
  })
  .strict();
function state(root: string, environment: string, flowId: string) {
  const w = editableProject(root),
    project = projectSchema.parse(w.reader.load());
  const flow = project.flows
    .map((f) => flowSchema.parse(f))
    .find((f) => f.id === flowId);
  check(
    flow?.kind === "ingestion" && flow.ingestion?.connection,
    "CAPABILITY",
    "Choose a saved source ingestion flow",
  );
  const packages = projectPackages(project),
    connection = project.connections[String(flow.ingestion.connection)];
  check(
    connection?.package &&
      !["native", "bridge"].includes(connection.route ?? ""),
    "CONNECTION",
    "Choose a portable source",
  );
  const connector = connectorPackageSchema.parse(
    packageYaml(
      resolvePackage(
        root,
        configuredPackageReference(packages[connection.package]),
      ).file,
    ),
  );
  check(
    connector.source?.kind === "azure-blob" || connector.id === "azure-blob",
    "CAPABILITY",
    "This handoff currently supports reviewed Azure Blob files",
  );
  const settings = resolveConnectionSettings(
    w.reader,
    project,
    environment,
    connection,
    connector.definition.settingsSchema,
  );
  const tables = Object.entries(flow.tables ?? {}).map(([name, t]) => ({
    id: name,
    path: t.source.path,
    format: t.source.format,
    contract: t.contract,
  }));
  check(
    tables.length > 0 &&
      tables.length <= 100 &&
      tables.every(
        (t) =>
          typeof t.path === "string" &&
          ["json", "csv"].includes(String(t.format)),
      ),
    "CAPABILITY",
    "Choose saved JSON and CSV file selections",
  );
  const providers = Object.entries(project.providers.configurations).flatMap(
    ([name, c]) => {
      const reference = resolvePackage(
        root,
        configuredPackageReference(packages[c.package]),
      ).reference;
      const p = providerReference(root, reference);
      return p.manifest.fileHandoff
        ? [
            {
              id: name,
              reference,
              role: p.manifest.fileHandoff.role,
              platform: p.manifest.platform,
              deferred:
                project.destinationSetups?.[environment]?.[name]?.deferred ===
                true,
            },
          ]
        : [];
    },
  );
  return {
    w,
    project,
    flow,
    tables,
    settings,
    providers,
    revision: digest(canonical(w.reader.files)),
  };
}
export function readFileHandoff(
  root: string,
  environment: string,
  args: z.infer<typeof fileHandoffReadSchema>,
) {
  const s = state(root, environment, args.flow);
  return {
    apiVersion: "ingestron.file-handoff-editor/v1",
    flow: args.flow,
    revision: s.revision,
    tables: s.tables.map(({ id, path, format }) => ({ id, path, format })),
    providers: s.providers.map(({ reference, ...p }) => p),
    producerFlow: args.flow + "_land",
    consumerFlow: args.flow + "_delivery",
  };
}
export function reviewFileHandoff(
  root: string,
  environment: string,
  raw: z.infer<typeof fileHandoffReviewSchema>,
) {
  const args = fileHandoffReviewSchema.parse(raw),
    s = state(root, environment, args.flow);
  check(
    args.revision === s.revision,
    "STALE",
    "Selected files or destination definitions changed; reopen the handoff",
  );
  const producer = s.providers.find(
      (p) => p.id === args.producer && p.role === "producer",
    ),
    consumer = s.providers.find(
      (p) => p.id === args.consumer && p.role === "consumer",
    );
  check(
    producer && consumer && producer.id !== consumer.id,
    "CAPABILITY",
    "Choose compatible installed file handoff destinations",
  );
  check(
    producer.deferred && consumer.deferred,
    "DEFERRED",
    "Design handoffs require deferred destinations; complete native delivery preparation separately before deployment",
  );
  const binding = args.flow + "_files",
    names = [args.flow + "_land", args.flow + "_delivery"];
  check(
    !s.project.environments[environment].bindings[binding],
    "OWNER",
    "Handoff binding already exists",
  );
  const replacements: Record<string, string> = {};
  const author = (provider: typeof producer, name: string) => {
    check(
      !s.project.flows.some((f: any) => f.id === name) &&
        !existsSync(fence(root, `flows/${name}/flow.yaml`)),
      "OWNER",
      "Delivery flow already exists; open it to edit",
    );
    const result = providerAuthor(
      root,
      provider.reference,
      {
        operation: "file_handoff",
        options: {
          id: name,
          project: s.project.id,
          origin: args.flow,
          provider: provider.id,
          producerFlow: names[0],
          binding,
          container: (s.settings as Record<string, unknown>).container,
          tables: s.tables,
        },
      },
      (n) => n === "handoff.json",
    );
    const output = z
      .object({
        flow: flowSchema,
        bindings: z.record(z.string(), z.record(z.string(), z.unknown())),
      })
      .strict()
      .parse(JSON.parse(result["handoff.json"] ?? "null"));
    check(
      output.flow.id === name &&
        output.flow.provider === provider.id &&
        output.flow.kind === "ingestion",
      "PROVIDER",
      "Unexpected handoff template identity",
    );
    check(
      canonical(Object.keys(output.flow.tables ?? {}).sort()) ===
        canonical(s.tables.map((t) => t.id).sort()) &&
        s.tables.every(
          (t) =>
            canonical(output.flow.tables![t.id].contract) ===
            canonical(t.contract),
        ),
      "PROVIDER",
      "Handoff changed reviewed contracts or selections",
    );
    auditSecrets(output, "handoff");
    replacements[`flows/${name}/flow.yaml`] = stringify(output.flow);
    return output;
  };
  const landing = author(producer, names[0]),
    downstream = author(consumer, names[1]);
  check(
    Object.keys(landing.bindings).length === 1 &&
      landing.bindings[binding] &&
      !Object.keys(downstream.bindings).length,
    "PROVIDER",
    "Unexpected handoff bindings",
  );
  const mutate = (
    keys: string[],
    change: (doc: any, prefix: any[], file: string) => void,
  ) => {
    let at = { file: s.w.projectFile, prefix: [] as (string | number)[] };
    for (const key of keys)
      at = s.w.location({ file: at.file, prefix: [...at.prefix, key] });
    const doc = s.w.document(at.file);
    visit(doc, {
      Alias() {
        check(
          false,
          "OWNER",
          "Separate shared YAML aliases before creating a handoff",
        );
      },
    });
    change(doc, at.prefix, at.file);
    replacements[relative(s.w.reader.root, at.file)] = doc.toString();
  };
  mutate(["flows"], (doc, prefix, file) => {
    for (const name of names)
      doc.addIn(prefix, {
        $resolve: relative(
          dirname(file),
          fence(root, `flows/${name}/flow.yaml`),
        ),
      });
  });
  mutate(["environments", environment, "bindings"], (doc, prefix) =>
    doc.setIn([...prefix, binding], landing.bindings[binding]),
  );
  // Refresh documents if registry and bindings share one file.
  for (const file of Object.keys(replacements))
    if (!file.startsWith("flows/"))
      replacements[file] = s.w.document(fence(root, file)).toString();
  return preview(root, replacements, s.w.reader.files, [
    producer.reference,
    consumer.reference,
  ]);
}
