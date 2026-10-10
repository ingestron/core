/** Authoring catalogue. Provider support is an offline source audit, never installed/cloud qualification. */
export interface GenerationOption {
  id: string;
  label: string;
  support: "provider" | "planned";
  description: string;
  mapping?: string;
  capability?: string;
  /** Explicit standard identities; never derived from labels or display mappings. */
  standards?: string[];
}
export interface GenerationSetting {
  id: string;
  label: string;
  group: string;
  description: string;
  options: GenerationOption[];
}
const option = (
  id: string,
  label: string,
  support: GenerationOption["support"],
  description: string,
  mapping?: string,
  capability?: string,
  standards?: string[],
): GenerationOption => ({
  id,
  label,
  support,
  description,
  ...(mapping ? { mapping } : {}),
  ...(capability ? { capability } : {}),
  ...(standards ? { standards } : {}),
});
const setting = (
  id: string,
  label: string,
  group: string,
  description: string,
  options: GenerationOption[],
): GenerationSetting => ({ id, label, group, description, options });
const dbStreaming = option(
  "streaming-table",
  "Streaming table",
  "provider",
  "Lakeflow streaming target; source delivery and change semantics must be reviewed.",
  "lakeflow-ingest@v1",
  "lakeflow",
);
const dbView = option(
  "materialized-view",
  "Materialized view",
  "provider",
  "Typed SQL or Python transformation refreshed by Lakeflow.",
  "materialized-view@v1",
  "lakeflow",
);
const sqlView = option(
  "sql-view",
  "SQL view",
  "planned",
  "Reusable query without persisted results; general view authoring is planned.",
);
const fabricView = option(
  "materialized-lake-view",
  "Materialized lake view",
  "planned",
  "Fabric-native declarative transformation; Ingestron generator integration is planned.",
);
const common = [
  setting(
    "qualityFailure",
    "Unsupported quality checks",
    "Generation policies",
    "Choose whether unsupported contract checks prevent generation.",
    [
      option(
        "block",
        "Block generation",
        "provider",
        "Require a provider implementation for every requested check.",
        "defaults.quality.unsupported=block",
      ),
      option(
        "report",
        "Report unsupported checks",
        "provider",
        "Keep unsupported checks visible in the generated quality report.",
        "defaults.quality.unsupported=report",
      ),
    ],
  ),
  setting(
    "schemaEvolution",
    "Schema changes",
    "Generation policies",
    "Define how generated pipelines should handle source schema changes.",
    [
      option(
        "reviewed",
        "Reviewed contracts only",
        "provider",
        "Use explicit reviewed contract columns; incompatible input fails validation.",
        "reviewed contract schema",
      ),
      option(
        "additive",
        "Allow additive columns",
        "planned",
        "Automatic additive schema evolution requires a dedicated adapter.",
      ),
    ],
  ),
  setting(
    "overrides",
    "Project overrides",
    "Generation policies",
    "Record how exceptions to shared standards should be handled.",
    [
      option(
        "review",
        "Require a reviewed exception",
        "planned",
        "Exception approval and automatic enforcement are planned.",
      ),
      option(
        "deny",
        "Do not allow overrides",
        "planned",
        "Locked inheritance across project definitions is planned.",
      ),
    ],
  ),
];
export const generationCatalogue: Record<string, GenerationSetting[]> = {
  databricks: [
    setting(
      "ingestion",
      "Ingestion method",
      "Data layers",
      "Select a preferred route; connectivity and the source contract determine eligibility.",
      [
        option(
          "auto-loader",
          "Auto Loader",
          "provider",
          "Ingest files from supported cloud storage under the selected delivery standard.",
          "append-only@v1 / snapshot-with-history@v1 / change-feed-with-history@v1",
          "lakeflow",
          [
            "append-only@v1",
            "snapshot-with-history@v1",
            "change-feed-with-history@v1",
          ],
        ),
        option(
          "lakeflow-connect",
          "Lakeflow Connect",
          "provider",
          "Managed source ingestion for provider-declared connectors. Source-specific setup remains required.",
          "provider source catalogue / flow.ingestion",
          "lakeflow",
          [
            "query-ingestion@v1",
            "sharepoint-ingestion@v1",
            "saas-ingestion@v1",
          ],
        ),
        option(
          "adf-bridge",
          "ADF landing → Databricks",
          "provider",
          "Use a verified ADF landing route for sources Databricks cannot reach.",
          "snapshot-to-databricks@v1 / snapshot-with-history@v1",
        ),
        option(
          "streaming-connector",
          "Lakeflow streaming connector",
          "planned",
          "Managed message-bus ingestion; Studio binding is planned.",
        ),
      ],
    ),
    setting("bronze", "Bronze assets", "Data layers", "Raw ingestion output.", [
      dbStreaming,
    ]),
    setting(
      "silver",
      "Silver assets",
      "Data layers",
      "Cleaned and conformed datasets.",
      [
        dbView,
        option(
          "streaming-transformation",
          "Streaming transformation",
          "planned",
          "Streaming transformation authoring and window semantics are planned.",
          undefined,
          "lakeflow",
        ),
      ],
    ),
    setting(
      "gold",
      "Gold assets",
      "Data layers",
      "Published data products and serving objects.",
      [dbView, sqlView],
    ),
    setting(
      "changes",
      "Change handling",
      "Processing",
      "Use only the pattern supported by the source's delivery contract.",
      [
        option(
          "append",
          "Append only",
          "provider",
          "Immutable deliveries; no updates or deletes.",
          "append-only@v1",
          "lakeflow",
          ["append-only@v1"],
        ),
        option(
          "snapshot-history",
          "Snapshots with history",
          "provider",
          "Complete snapshots, stable keys and retained deliveries; AUTO CDC FROM SNAPSHOT.",
          "snapshot-with-history@v1",
          "lakeflow",
          ["snapshot-with-history@v1"],
        ),
        option(
          "cdc-history",
          "Change feed with history",
          "provider",
          "Baseline plus full-row ordered change events; AUTO CDC.",
          "change-feed-with-history@v1",
          "lakeflow",
          ["change-feed-with-history@v1"],
        ),
      ],
    ),
    setting(
      "optimisation",
      "Table optimisation",
      "Processing",
      "Specify a prospective storage optimisation policy.",
      [
        option(
          "liquid-clustering",
          "Liquid clustering",
          "planned",
          "Native clustering settings and eligibility checks are planned.",
        ),
        option(
          "automatic-clustering",
          "Automatic liquid clustering",
          "planned",
          "Automatic key selection requires supported workspace and compute capabilities.",
        ),
      ],
    ),
    ...common,
  ],
  fabric: [
    setting(
      "ingestion",
      "Ingestion method",
      "Data layers",
      "Choose a preferred Fabric ingestion asset.",
      [
        option(
          "copy-job",
          "Copy job",
          "provider",
          "Provider supports bounded Azure SQL snapshot and watermark ingestion.",
          "copy-job-snapshot@v1 / copy-job-watermark-append@v1",
          "data-factory",
          ["copy-job-snapshot@v1", "copy-job-watermark-append@v1"],
        ),
        option(
          "copy-pipeline",
          "Data Factory pipeline",
          "provider",
          "Snapshot copy with supported quality checks.",
          "pipeline-quality-snapshot@v1",
          "data-factory",
          ["pipeline-quality-snapshot@v1"],
        ),
        option(
          "mirroring",
          "Mirroring",
          "planned",
          "Continuous source replication; provider authoring is planned.",
        ),
        option(
          "eventstream",
          "Eventstream",
          "planned",
          "Streaming ingestion; provider authoring is planned.",
        ),
      ],
    ),
    setting("bronze", "Bronze assets", "Data layers", "Raw landing objects.", [
      option(
        "lakehouse-table",
        "Lakehouse table",
        "provider",
        "Explicitly owned destination table for supported Copy jobs.",
        "Copy job destination",
        "lakehouse",
      ),
    ]),
    setting(
      "silver",
      "Silver assets",
      "Data layers",
      "Cleaned and conformed datasets.",
      [
        fabricView,
        option(
          "notebook",
          "Spark notebook",
          "planned",
          "Transformation notebook generation is planned.",
          undefined,
          "notebooks",
        ),
      ],
    ),
    setting(
      "gold",
      "Gold assets",
      "Data layers",
      "Published data products and serving objects.",
      [
        fabricView,
        sqlView,
        option(
          "warehouse-table",
          "Warehouse table",
          "planned",
          "Warehouse transformation authoring is planned.",
          undefined,
          "warehouse",
        ),
      ],
    ),
    setting(
      "serving",
      "Presentation model",
      "Presentation",
      "Select the prospective consumer-facing model.",
      [
        option(
          "direct-lake",
          "Direct Lake semantic model",
          "planned",
          "Semantic model and relationship generation are planned.",
          undefined,
          "semantic-models",
        ),
      ],
    ),
    ...common,
  ],
  adf: [
    setting(
      "ingestion",
      "Ingestion method",
      "Data layers",
      "ADF moves data into an explicitly selected downstream platform.",
      [
        option(
          "snapshot-copy",
          "Snapshot Copy activity",
          "provider",
          "Copy a complete source delivery to a landing location.",
          "snapshot-land@v1",
          "copy-activity",
          ["snapshot-land@v1"],
        ),
        option(
          "watermark-copy",
          "Watermark Copy activity",
          "provider",
          "Bounded append ingestion for eligible ordered sources.",
          "watermark-append-land@v1",
          "copy-activity",
          ["watermark-append-land@v1"],
        ),
        option(
          "metadata-copy",
          "Metadata-driven Copy",
          "provider",
          "Reviewed source metadata drives a bounded snapshot copy.",
          "metadata-snapshot-land@v1",
          "copy-activity",
          ["metadata-snapshot-land@v1"],
        ),
      ],
    ),
    setting(
      "bronze",
      "Bronze delivery",
      "Data layers",
      "ADF orchestrates landing; it is not the table-storage platform.",
      [
        option(
          "file-landing",
          "Files in landing storage",
          "provider",
          "Publish complete reviewed deliveries for downstream ingestion.",
          "snapshot-land@v1",
          "copy-activity",
          ["snapshot-land@v1"],
        ),
      ],
    ),
    setting(
      "transformation",
      "Transformation handoff",
      "Data layers",
      "Choose where transformations will execute.",
      [
        option(
          "databricks",
          "Databricks handoff",
          "provider",
          "Verified publication and Databricks ingestion remain separate owned stages.",
          "snapshot-to-databricks@v1",
        ),
        option(
          "mapping-data-flow",
          "Mapping data flow",
          "planned",
          "ADF data-flow generation is planned.",
          undefined,
          "mapping-data-flows",
        ),
        option(
          "fabric",
          "Fabric handoff",
          "planned",
          "Cross-provider Fabric publication adapter is planned.",
        ),
      ],
    ),
    setting(
      "runtime",
      "Integration runtime",
      "Connectivity",
      "Runtime selection must satisfy the source network boundary.",
      [
        option(
          "azure",
          "Azure integration runtime",
          "provider",
          "Use a configured supported linked service/runtime.",
          "source linked-service binding",
          "azure-ir",
        ),
        option(
          "self-hosted",
          "Self-hosted integration runtime",
          "provider",
          "An existing customer-managed runtime bridges private sources.",
          "source linked-service binding",
          "self-hosted-ir",
        ),
        option(
          "managed-vnet",
          "Managed virtual network",
          "planned",
          "Runtime and private-endpoint provisioning is planned.",
          undefined,
          "managed-vnet",
        ),
      ],
    ),
    ...common,
  ],
};
export function reviewGeneration(target: {
  provider: string;
  generation?: Record<string, string>;
  capabilities: Record<string, string>;
}) {
  return (generationCatalogue[target.provider] ?? []).map((setting) => {
    const selected = target.generation?.[setting.id];
    const choice = setting.options.find((o) => o.id === selected);
    const blocked =
      !!choice?.capability &&
      target.capabilities[choice.capability] === "disabled";
    return {
      setting: setting.id,
      label: setting.label,
      selection: choice?.label ?? "Not selected",
      support: choice?.support ?? "unset",
      mapping: choice?.mapping ?? "",
      binding: "planned",
      blocked,
      reason: blocked
        ? `Enable ${choice!.capability} or choose another generation setting.`
        : choice?.support === "planned"
          ? "Generator integration is planned."
          : choice
            ? "Provider capability exists; project binding and source eligibility need review."
            : "Choose a shared default or leave the decision to the project.",
    };
  });
}
