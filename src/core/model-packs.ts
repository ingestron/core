import { Configuration } from "./config.js";
import { resolvePackage, packageYaml } from "./packages.js";
import { validateModelPack } from "./model-pack-schema.js";
import { check } from "./errors.js";
import type { Project, Flow } from "./schema.js";
/** Read immutable model text, never evaluate it as configuration or plugin code. */
export function resolveModelContracts(
  reader: Configuration,
  project: Project,
  flows: Flow[],
) {
  const packs = Object.fromEntries(
    Object.entries(project.modelPacks).map(([alias, selection]) => {
      const local = selection.source.startsWith(".");
      const file = local
        ? reader.path(selection.source)
        : resolvePackage(
            reader.root,
            `${selection.source}@${selection.version}`,
          ).file;
      reader.text(file);
      if (!local) reader.text("packages.lock.yaml");
      const pack = validateModelPack(packageYaml(file));
      check(
        pack.version === selection.version ||
          (!local && /^[a-f0-9]{40}$/.test(selection.version)),
        "MODEL_PACK",
        `${alias}: model version differs from selector`,
      );
      return [alias, pack];
    }),
  );
  const resolveContract = (contract: Record<string, unknown>) => {
    if (!Object.hasOwn(contract, "$model")) return contract;
    check(
      Object.keys(contract).length === 1 && typeof contract.$model === "string",
      "MODEL_PACK",
      "Use only {$model: pack:dataset}; model overrides are not supported",
    );
    const parts = (contract.$model as string).split(":");
    check(
      parts.length === 2 && packs[parts[0]]?.contracts[parts[1]],
      "MODEL_PACK",
      `Unknown model ${contract.$model}`,
    );
    return structuredClone(packs[parts[0]].contracts[parts[1]]);
  };
  for (const flow of flows) {
    for (const table of Object.values(flow.tables ?? {}))
      table.contract = resolveContract(table.contract);
    for (const output of Object.values(flow.publishes))
      output.contract = resolveContract(output.contract);
  }
}
