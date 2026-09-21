import { Configuration } from "./config.js";
import { check } from "./errors.js";
import {
  extensionPackSchema,
  packageYaml,
  resolvePackage,
  providerPackageSchema,
  fence,
} from "./packages.js";
import type { Project } from "./schema.js";

/** Resolve explicit direct packs only. Every input is fingerprinted by the host. */
export function extensionActivities(
  reader: Configuration,
  project: Project,
  names: string[],
  provider: ReturnType<typeof providerPackageSchema.parse>,
) {
  const result: Record<
    string,
    { uses: string; with: Record<string, unknown> }
  > = {};
  check(
    new Set(names).size === names.length,
    "PACK",
    "Duplicate configured extension pack",
  );
  for (const name of names) {
    const selection = project.providers.packs[name];
    check(selection, "PACK", `Unknown extension pack ${name}`);
    const source = selection.source.startsWith(".")
      ? {
          file: reader.path(
            fence(reader.root, selection.source.replace(/^\.\//, "")),
          ),
        }
      : resolvePackage(reader.root, `${selection.source}@${selection.version}`);
    const pack = extensionPackSchema.parse(packageYaml(source.file));
    reader.text(source.file);
    if (!selection.source.startsWith(".")) reader.text("packages.lock.yaml");
    check(
      selection.version === pack.version ||
        (/^[a-f0-9]{40}$/.test(selection.version) &&
          !selection.source.startsWith(".")),
      "PACK",
      `Pack ${name} version differs from selector`,
    );
    check(
      pack.extends.provider === provider.id &&
        pack.extends.version === provider.version &&
        pack.extends.platform === provider.platform,
      "PACK",
      `Pack ${name} requires ${pack.extends.provider}@${pack.extends.version} on ${pack.extends.platform}`,
    );
    check(
      provider.capabilities?.packContracts[pack.extends.contract]?.version ===
        pack.extends.contractVersion,
      "PACK",
      `Pack ${name} requires unsupported extension contract ${pack.extends.contract}@${pack.extends.contractVersion}`,
    );
    for (const [alias, activity] of Object.entries(pack.activities)) {
      check(
        provider.capabilities!.packContracts[
          pack.extends.contract
        ].activities.includes(activity.uses),
        "PACK",
        `Pack ${name} activity ${activity.uses} is outside extension contract ${pack.extends.contract}`,
      );
      check(
        Object.hasOwn(provider.activities, activity.uses),
        "PACK",
        `Pack ${name} references unknown provider activity ${activity.uses}`,
      );
      result[`${name}:${alias}`] = activity;
    }
  }
  return result;
}
