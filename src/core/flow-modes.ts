import { z } from "zod";
import { relative } from "node:path";
import { parseDocument, visit } from "yaml";
import { editableProject, preview } from "./authoring.js";
import { projectSchema, flowSchema } from "./schema.js";
import { projectPackages } from "./project-packages.js";
import {
  configuredPackageReference,
  packageYaml,
  resolvePackage,
} from "./packages.js";
import { providerReference, providerAuthor } from "../plugins/authoring.js";
import { canonical, check, digest } from "./errors.js";
import { connectorPackageSchema } from "./connector-package.js";
const id = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/);
export const flowModesReadSchema = z.object({ flow: id }).strict();
export const flowModesReviewSchema = flowModesReadSchema
  .extend({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.string().min(1).max(160),
  })
  .strict();
function selected(root: string, flowId: string) {
  const w = editableProject(root),
    project = projectSchema.parse(w.reader.load()),
    flow = project.flows
      .map((f) => flowSchema.parse(f))
      .find((f) => f.id === flowId);
  check(flow?.kind === "ingestion", "FLOW", "Choose an ingestion flow");
  const configuration = flow.provider ?? project.defaults.provider!,
    config = project.providers.configurations[configuration];
  check(config, "PROVIDER", "Choose a configured destination");
  const packages = projectPackages(project),
    reference = resolvePackage(
      root,
      configuredPackageReference(packages[config.package]),
    ).reference,
    installed = providerReference(root, reference);
  const modes: { id: string; label: string; description: string }[] = [];
  let current = String(flow.ingestion?.standard ?? "snapshot");
  if (flow.ingestion?.connection) {
    const connection = project.connections[String(flow.ingestion.connection)];
    check(connection?.package, "CONNECTION", "Choose a portable connection");
    const connector = connectorPackageSchema.parse(
      packageYaml(
        resolvePackage(
          root,
          configuredPackageReference(packages[connection.package]),
        ).file,
      ),
    );
    const runtime =
      installed.manifest.connectorRuntimes?.[connector.runtime.contract];
    check(
      runtime && connector.execution[installed.manifest.platform],
      "CAPABILITY",
      "Destination does not support this source runtime",
    );
    modes.push({
      id: "snapshot",
      label: "Snapshot",
      description: "Read the selected objects as a complete source snapshot.",
    });
    const properties: any = runtime.executionSchema.properties;
    if (
      connector.source?.capabilities.includes("incremental") &&
      properties?.ingestion?.enum?.includes("incremental")
    )
      modes.push({
        id: "incremental",
        label: "Incremental",
        description:
          "Use the connector’s reviewed cursor and checkpoint settings. Configure cursor fields before the first run.",
      });
    current = (flow.ingestion.execution as any)?.ingestion ?? "snapshot";
  } else {
    for (const standard of installed.manifest.standards ?? [])
      if (
        installed.manifest.authoring?.flows?.ingestionStandards.includes(
          standard.id,
        )
      )
        modes.push({
          id: standard.id,
          label: standard.id,
          description: standard.description,
        });
  }
  return {
    w,
    project,
    flow,
    configuration,
    reference,
    installed,
    modes,
    current,
    revision: digest(canonical(w.reader.files)),
  };
}
export function readFlowModes(
  root: string,
  input: z.infer<typeof flowModesReadSchema>,
) {
  const s = selected(root, input.flow);
  return {
    apiVersion: "ingestron.flow-modes/v1",
    flow: input.flow,
    provider: s.configuration,
    platform: s.installed.manifest.platform,
    modes: s.modes,
    current: s.current,
    revision: s.revision,
  };
}
export function reviewFlowMode(
  root: string,
  input: z.infer<typeof flowModesReviewSchema>,
) {
  const s = selected(root, input.flow);
  check(
    !s.project.platformBindings?.[s.configuration],
    "OWNER",
    "Shared destination methods must be reviewed through the platform preference workflow",
  );
  check(
    s.revision === input.revision,
    "STALE",
    "Flow changed; reopen ingestion mode setup",
  );
  check(
    s.modes.some((m) => m.id === input.mode),
    "CAPABILITY",
    "Choose an ingestion mode supported by the installed source and destination",
  );
  const at = s.w.selectFlow(input.flow),
    doc = s.w.document(at.file);
  visit(doc, {
    Alias() {
      check(
        false,
        "OWNER",
        "Separate shared YAML aliases before changing ingestion mode",
      );
    },
  });
  let ingestion: any;
  if (s.flow.ingestion?.connection) {
    ingestion = structuredClone(s.flow.ingestion);
    ingestion.execution ??= {};
    if (input.mode === "snapshot") delete ingestion.execution.ingestion;
    else ingestion.execution.ingestion = input.mode;
  } else {
    const path = `flows/${input.flow}/flow.yaml`;
    const files = providerAuthor(
      root,
      s.reference,
      {
        operation: "flow",
        options: {
          id: input.flow,
          kind: "ingestion",
          provider: s.configuration,
          standard: input.mode,
        },
        configuration: s.configuration,
        project: s.project,
        environments: [],
      },
      (n) => n === path,
    );
    const template = parseDocument(files[path] ?? "", { uniqueKeys: true });
    check(
      !template.errors.length && !template.warnings.length,
      "PROVIDER",
      "Invalid ingestion template",
    );
    const authored = flowSchema.parse(template.toJS());
    check(
      authored.id === input.flow && authored.ingestion?.standard === input.mode,
      "PROVIDER",
      "Provider did not author the selected standard",
    );
    ingestion = authored.ingestion;
    if (s.flow.ingestion?.pipeline)
      ingestion.pipeline = s.flow.ingestion.pipeline;
    if (s.flow.ingestion?.target)
      ingestion.target = {
        ...(ingestion.target as object),
        ...(s.flow.ingestion.target as object),
      };
  }
  // Contract identities, table source mappings, query files and execution profiles remain unchanged.
  const target = s.w.location({
    file: at.file,
    prefix: [...at.prefix, "ingestion"],
  });
  const targetDoc = s.w.document(target.file);
  visit(targetDoc, {
    Alias() {
      check(
        false,
        "OWNER",
        "Separate shared YAML aliases before changing ingestion mode",
      );
    },
  });
  targetDoc.setIn(target.prefix, ingestion);
  return preview(
    root,
    { [relative(s.w.reader.root, target.file)]: targetDoc.toString() },
    s.w.reader.files,
    [s.reference],
  );
}
