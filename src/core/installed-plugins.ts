/** Discover only packages present in the caller's integrity-checked lock/cache. */
import { check } from "./errors.js";
import {
  packageLock,
  packageYaml,
  resolvePackage,
  providerPackageSchema,
  extensionPackSchema,
} from "./packages.js";
import { connectorPackageSchema } from "./connector-package.js";
import { validateModelPack } from "./model-pack-schema.js";
import { reportPackSchema } from "./report-pack-schema.js";
export type PluginKind =
  "provider" | "connector" | "model-pack" | "activity-pack" | "report-pack";
export const pluginKindLabel = (kind: PluginKind) =>
  ({
    provider: "Provider",
    connector: "Connector",
    "model-pack": "Model pack",
    "activity-pack": "Activity preset pack",
    "report-pack": "Report pack",
  })[kind];
export function browseProviders(
  root: string,
  query = "",
  kind?: string,
  filters: { engine?: string; installable?: boolean } = {},
) {
  check(
    !kind ||
      Object.hasOwn(
        {
          provider: 1,
          connector: 1,
          "model-pack": 1,
          "activity-pack": 1,
          "report-pack": 1,
        },
        kind,
      ),
    "INPUT",
    "Unknown plugin category",
  );
  const needle = query.toLowerCase();
  const entries = Object.keys(packageLock(root).packages)
    .sort()
    .flatMap((reference) => {
      const source = resolvePackage(root, reference);
      const raw = packageYaml(source.file);
      let kind: PluginKind;
      let manifest: any;
      switch (raw.apiVersion) {
        case "ingestron.provider/v1":
          kind = "provider";
          manifest = providerPackageSchema.parse(raw);
          break;
        case "ingestron.connector/v1":
          kind = "connector";
          manifest = connectorPackageSchema.parse(raw);
          break;
        case "ingestron.extension-pack/v1":
          kind = "activity-pack";
          manifest = extensionPackSchema.parse(raw);
          break;
        case "ingestron.extension-pack/v2":
          kind = "model-pack";
          manifest = validateModelPack(raw);
          break;
        case "ingestron.extension-pack/v3":
          kind = "report-pack";
          manifest = reportPackSchema.parse(raw);
          break;
        default:
          return [];
      }
      const url = `https://github.com/${source.entry.repository}/tree/${source.entry.commit}`;
      return [
        {
          id: manifest.id as string,
          name: manifest.id as string,
          version: manifest.version as string,
          kind,
          kindLabel: pluginKindLabel(kind),
          reference,
          commit: source.entry.commit,
          repository: source.entry.repository,
          description: (manifest.description ?? "") as string,
          engines:
            kind === "connector"
              ? ([
                  ...new Set(
                    Object.values(manifest.execution).flatMap(
                      (e: any) => e.modes,
                    ),
                  ),
                ] as string[])
              : ([manifest.platform].filter(Boolean) as string[]),
          availability: "installed",
          installable: false,
          documentation: (manifest.documentation ?? url) as string,
          licence: (manifest.upstream?.licence ??
            "See the installed package licence files") as string,
          url,
          evidence:
            "Locked package metadata; capabilities are declared by the package, not verified target support.",
        },
      ];
    });
  return entries.filter(
    (p) =>
      (!kind || p.kind === kind) &&
      (!filters.engine || p.engines.includes(filters.engine)) &&
      (!filters.installable || p.installable) &&
      `${p.id} ${p.description} ${p.reference}`.toLowerCase().includes(needle),
  );
}
export function pluginDetails(root: string, id: string) {
  const entries = browseProviders(root).filter(
    (p) => p.id === id || p.reference === id,
  );
  check(
    entries.length > 0,
    "PACKAGE",
    "No installed package matches; inspect packages_list or install an explicit repository reference",
  );
  check(
    entries.length === 1,
    "PACKAGE",
    "Multiple installed packages match; select an exact reference",
  );
  return entries[0];
}
