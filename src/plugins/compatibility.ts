import { pluginCompatibilityVersion } from "../version.js";
import { check } from "../core/errors.js";
/** All provider entry points use one legacy ABI check. App semver resets must
 * not make authoring work while planning or command dispatch rejects the package. */
export const hostFeatures = [
  "project-assembly",
  "provider-execution",
  "connector-runtime-capabilities",
  "connector-runtime-assets",
  "project-connections",
  "odcs-connections",
  "report-packs",
  "native-project",
  "extension-packs",
  "delivery-exports",
  "relation-handovers",
  "export-groups",
  "model-inputs",
  "ingestion-presets",
];
export function checkPluginCompatibility(
  minimum?: string,
  requiredFeatures: string[] = [],
) {
  for (const feature of requiredFeatures)
    check(
      hostFeatures.includes(feature),
      "COMPATIBILITY",
      `Unsupported provider host feature ${feature}`,
    );
  if (!minimum) return;
  const current = pluginCompatibilityVersion.split(".").map(Number);
  const required = minimum.split(".").map(Number);
  check(
    (current
      .map((value, index) => value - required[index])
      .find((value) => value !== 0) ?? 0) >= 0,
    "COMPATIBILITY",
    `Provider requires plugin compatibility ${minimum}; this CLI supports ${pluginCompatibilityVersion}`,
  );
}

/** Capability opt-ins must also declare the host protocol features they need. */
export function checkProviderCompatibility(manifest: {
  compatibility?: { minimumCli: string; requiredFeatures?: string[] };
  projectAssembly?: unknown;
  execution?: unknown;
  connectorRuntimes?: Record<string, unknown>;
  capabilities?: {
    artifactKinds: string[];
    delivery: boolean;
    handovers: string[];
    packContracts: Record<string, { version: string; activities: string[] }>;
  };
}) {
  const required = manifest.compatibility?.requiredFeatures ?? [];
  check(
    !manifest.execution || required.includes("provider-execution"),
    "COMPATIBILITY",
    "Execution providers must declare requiredFeatures provider-execution",
  );
  checkPluginCompatibility(manifest.compatibility?.minimumCli, required);
  if (
    manifest.connectorRuntimes &&
    Object.keys(manifest.connectorRuntimes).length
  )
    check(
      required.includes("connector-runtime-capabilities"),
      "COMPATIBILITY",
      "Provider must declare requiredFeatures: connector-runtime-capabilities",
    );
  if (manifest.projectAssembly)
    check(
      required.includes("project-assembly"),
      "COMPATIBILITY",
      "Provider must declare requiredFeatures: project-assembly",
    );
  const c = manifest.capabilities;
  if (!c) return;
  const needed = [
    ...(c.artifactKinds.some(
      (k) => !["native-notebook", "native-pipeline"].includes(k),
    )
      ? ["native-project"]
      : []),
    ...(c.delivery ? ["delivery-exports"] : []),
    ...(c.handovers.includes("relation") ? ["relation-handovers"] : []),
    ...(Object.keys(c.packContracts).length ? ["extension-packs"] : []),
  ];
  for (const feature of needed)
    check(
      required.includes(feature),
      "COMPATIBILITY",
      `Provider must declare requiredFeatures: ${feature}`,
    );
}
