import { validateModelPack } from "./model-pack-schema.js";
import { parseDocument } from "yaml";
import { Configuration } from "./config.js";
import { preview } from "./authoring.js";
import { check } from "./errors.js";
import { projectSchema } from "./schema.js";
import {
  extensionPackSchema,
  packageYaml,
  resolvePackage,
  providerPackageSchema,
} from "./packages.js";
import { extensionActivities } from "./extension-packs.js";
import { checkProviderCompatibility } from "../plugins/compatibility.js";

export function configurePack(
  root: string,
  args: { reference: string; name: string; provider?: string },
) {
  const reader = new Configuration(root),
    doc = parseDocument(reader.text("project.yaml"));
  const source = resolvePackage(root, args.reference);
  const manifest = packageYaml(source.file);
  if (manifest.apiVersion === "ingestron.extension-pack/v2") {
    validateModelPack(manifest);
    check(
      !args.provider,
      "MODEL_PACK",
      "Model packs are independent of provider configurations; omit provider",
    );
    const project = projectSchema.parse(reader.load());
    check(
      !project.modelPacks[args.name],
      "MODEL_PACK",
      "Model pack alias already exists",
    );
    const split = args.reference.lastIndexOf("@");
    check(split > 0, "MODEL_PACK", "Select an exact installed model pack");
    doc.setIn(["modelPacks", args.name], {
      source: args.reference.slice(0, split),
      version: args.reference.slice(split + 1).replace(/^v(?=\d)/, ""),
    });
    return preview(root, { "project.yaml": doc.toString() });
  }
  check(
    manifest.apiVersion !== "ingestron.extension-pack/v3",
    "REPORT_PACK",
    "Report packs are selected by exact reference in report build input, not attached as activities",
  );
  extensionPackSchema.parse(manifest);
  check(
    args.provider,
    "PACK",
    "Activity preset packs require a provider configuration",
  );
  const project = projectSchema.parse(reader.load());
  const configuration = project.providers.configurations[args.provider];
  check(configuration, "PROVIDER", "Unknown provider configuration");
  check(
    !project.providers.packs[args.name],
    "PACK",
    "Pack name already exists",
  );
  const pkg = project.providers.packages[configuration.package];
  const file = pkg.source.startsWith(".")
    ? reader.path(pkg.source)
    : resolvePackage(root, `${pkg.source}@${pkg.version}`).file;
  const provider = providerPackageSchema.parse(packageYaml(file));
  checkProviderCompatibility(provider);
  const split = args.reference.lastIndexOf("@");
  check(split > 0, "PACK", "Use an exact installed pack reference");
  const selection = {
    source: args.reference.slice(0, split),
    version: args.reference.slice(split + 1).replace(/^v(?=\d)/, ""),
  };
  project.providers.packs[args.name] = selection;
  extensionActivities(reader, project, [args.name], provider);
  doc.setIn(["providers", "packs", args.name], selection);
  doc.setIn(
    ["providers", "configurations", args.provider, "packs"],
    [...configuration.packs, args.name],
  );
  return preview(root, { "project.yaml": doc.toString() });
}
export function configureFlow(
  root: string,
  args: {
    id: string;
    group?: string;
    input?: string;
    dataset?: string;
    handover?: "files" | "relation";
    table?: string;
  },
) {
  const reader = new Configuration(root),
    project = parseDocument(reader.text("project.yaml"));
  const entries = project.toJS().flows ?? [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i],
      file = entry.$resolve ? reader.path(entry.$resolve) : "project.yaml";
    const doc = entry.$resolve ? parseDocument(reader.text(file)) : project;
    const prefix: (string | number)[] = entry.$resolve ? [] : ["flows", i];
    if (doc.getIn([...prefix, "id"]) !== args.id) continue;
    if (args.group) doc.setIn([...prefix, "export"], args.group);
    else {
      check(
        args.input && args.dataset && args.handover,
        "HANDOVER",
        "Supply input, dataset and handover",
      );
      check(
        !doc.hasIn([...prefix, "requires", args.input]),
        "HANDOVER",
        "Input already exists",
      );
      doc.setIn([...prefix, "requires", args.input], {
        dataset: args.dataset,
        select: { mode: "same-run" },
        handover: args.handover,
      });
      if (args.table) {
        check(
          args.handover === "files" &&
            doc.hasIn([...prefix, "tables", args.table]),
          "HANDOVER",
          "Select an existing ingestion table for a file input",
        );
        doc.setIn([...prefix, "tables", args.table, "source"], {
          from: `requires.${args.input}`,
        });
      }
    }
    return preview(root, { [file]: doc.toString() });
  }
  throw new Error(`Unknown flow ${args.id}`);
}
