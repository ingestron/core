/** Versioned suggestions for reviewed shared intent, never discovered tenant capabilities. */
type Defaults = {
  id: string;
  label: string;
  description: string;
  generation: Record<string, string>;
  capabilities: Record<string, "enabled" | "disabled">;
};
export const platformProfileSets: Record<string, Defaults[]> = {
  databricks: [
    {
      id: "lakeflow",
      label: "Lakeflow data layers",
      description:
        "Streaming bronze and materialised silver/gold. Choose ingestion and change handling after reviewing each source.",
      generation: {
        bronze: "streaming-table",
        silver: "materialized-view",
        gold: "materialized-view",
      },
      capabilities: {
        "unity-catalog": "enabled",
        "delta-tables": "enabled",
        lakeflow: "enabled",
        jobs: "enabled",
        bundles: "enabled",
      },
    },
  ],
  adf: [
    {
      id: "landing",
      label: "Copy and land data",
      description:
        "File landing with Copy activities. Select networking and integration runtimes after checking source connectivity.",
      generation: { bronze: "file-landing" },
      capabilities: {
        "copy-activity": "enabled",
        "git-integration": "enabled",
        monitoring: "enabled",
      },
    },
  ],
  fabric: [
    {
      id: "lakehouse",
      label: "Lakehouse data layers",
      description:
        "Record a lakehouse preference. Fabric generation support and tenant settings still require review.",
      generation: { bronze: "lakehouse-table" },
      capabilities: { "fabric-items": "enabled", lakehouse: "enabled" },
    },
  ],
};
export const profileGovernanceDefaults = {
  generation: { qualityFailure: "block", schemaEvolution: "reviewed" },
  policies: {
    "owner-required": "enabled",
    "quality-required": "enabled",
    "review-required": "enabled",
    "secret-references": "enabled",
    "retention-required": "enabled",
    "classification-required": "enabled",
  },
} as const;
