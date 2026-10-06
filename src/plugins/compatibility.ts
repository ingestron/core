import { pluginCompatibilityVersion } from "../version.js";
import { check } from "../core/errors.js";
/** All provider entry points use one legacy ABI check. App semver resets must
 * not make authoring work while planning or command dispatch rejects the package. */
export const hostFeatures = [
  "transformation-authoring-settings",
  "python-source-artifacts",
  "published-transformation-quality",
  "typed-transformation-outputs",
  "project-assembly",
  "connection-metadata-documents",
  "provider-execution",
  "source-checkpoint-migration",
  "provider-execution-resources",
  "provider-execution-acknowledgement",
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
  "quality-capabilities",
  "source-coverage",
  "flow-schedules",
  "connector-schedule-fencing",
  "connector-schedule-handover",
  "portable-scheduler",
  "portable-scheduler-worker",
  "resolved-schedule-boundaries",
  "flow-schedule-resource-claims",
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
    `Provider requires plugin compatibility ${minimum}; this host supports ${pluginCompatibilityVersion}`,
  );
}

/** Capability opt-ins must also declare the host protocol features they need. */
export function checkProviderCompatibility(manifest: {
  compatibility?: { minimumCli: string; requiredFeatures?: string[] };
  projectAssembly?: unknown;
  execution?: {
    resources?: unknown;
    acknowledgement?: unknown;
    actions?: string[];
  };
  quality?: unknown;
  authoring?: unknown;
  sources?: unknown;
  connectorRuntimes?: Record<string, unknown>;
  capabilities?: {
    schedules?: string[];
    artifactKinds: string[];
    delivery: boolean;
    handovers: string[];
    packContracts: Record<string, { version: string; activities: string[] }>;
    transformationLanguages?: ("sql" | "python")[];
    typedTransformationLanguages?: ("sql" | "python")[];
  };
}) {
  const required = manifest.compatibility?.requiredFeatures ?? [];
  check(
    !manifest.capabilities?.typedTransformationLanguages ||
      required.includes("typed-transformation-outputs"),
    "COMPATIBILITY",
    "Typed transformation outputs require typed-transformation-outputs",
  );
  check(
    !manifest.authoring ||
      required.includes("transformation-authoring-settings"),
    "COMPATIBILITY",
    "Transformation authoring requires transformation-authoring-settings",
  );
  check(
    !manifest.quality ||
      typeof manifest.quality !== "object" ||
      !Object.hasOwn(manifest.quality, "transformations") ||
      required.includes("published-transformation-quality"),
    "COMPATIBILITY",
    "Published transformation quality requires published-transformation-quality",
  );
  check(
    !manifest.execution || required.includes("provider-execution"),
    "COMPATIBILITY",
    "Execution providers must declare requiredFeatures provider-execution",
  );
  check(
    !manifest.execution?.resources ||
      required.includes("provider-execution-resources"),
    "COMPATIBILITY",
    "Execution resource declarations require provider-execution-resources",
  );
  check(
    !manifest.execution?.acknowledgement ||
      required.includes("provider-execution-acknowledgement"),
    "COMPATIBILITY",
    "Execution acknowledgement requires provider-execution-acknowledgement",
  );
  check(
    !manifest.execution?.actions?.some((action) =>
      ["checkpoint_preview", "checkpoint_apply"].includes(action),
    ) ||
      (required.includes("source-checkpoint-migration") &&
        !!manifest.execution.acknowledgement),
    "COMPATIBILITY",
    "Checkpoint maintenance requires source-checkpoint-migration and durable acknowledgement",
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
  if (
    Object.values(manifest.connectorRuntimes ?? {}).some(
      (runtime) =>
        runtime !== null &&
        typeof runtime === "object" &&
        Object.hasOwn(runtime, "scheduling"),
    )
  )
    check(
      required.includes("connector-schedule-handover"),
      "COMPATIBILITY",
      "Connector scheduling adapters must declare requiredFeatures: connector-schedule-handover",
    );
  if (
    (manifest.projectAssembly !== null &&
      typeof manifest.projectAssembly === "object" &&
      Object.hasOwn(manifest.projectAssembly, "metadataDocuments")) ||
    Object.values(manifest.connectorRuntimes ?? {}).some(
      (runtime) =>
        runtime !== null &&
        typeof runtime === "object" &&
        Object.hasOwn(runtime, "metadataDocuments"),
    )
  )
    check(
      required.includes("connection-metadata-documents"),
      "COMPATIBILITY",
      "Indexed connection metadata requires connection-metadata-documents",
    );
  if (manifest.quality)
    check(
      required.includes("quality-capabilities"),
      "COMPATIBILITY",
      "Provider must declare requiredFeatures: quality-capabilities",
    );
  if (manifest.sources)
    check(
      required.includes("source-coverage"),
      "COMPATIBILITY",
      "Provider must declare requiredFeatures: source-coverage",
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
    ...(c.transformationLanguages?.includes("python")
      ? ["python-source-artifacts"]
      : []),
    ...(c.schedules?.length ? ["flow-schedules"] : []),
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
