import {
  platformProfileSets,
  profileGovernanceDefaults,
} from "./platform-profile-defaults.js";
import { generationCatalogue } from "./platform-generation.js";
/** Curated desired configuration; no remote settings are read or changed. */
export const platformCatalogue = [
  {
    id: "fabric",
    name: "Microsoft Fabric",
    docs: "https://learn.microsoft.com/en-us/fabric/admin/tenant-settings-index",
    authentication: ["azure-cli", "service-principal", "managed-identity"],
    fields: ["tenantId", "clientId", "workspaceId", "capacityId", "region"],
    naming: {
      workspace: "{programme}_{environment}",
      lakehouse: "{project}_{layer}",
      schema: "{layer}",
      table: "{dataset}",
      pipeline: "{project}_{flow}",
    },
    capabilities: [
      [
        "fabric-items",
        "Create Fabric items",
        "Workloads",
        "Allow creation of Fabric items in the intended tenant scope.",
      ],
      [
        "lakehouse",
        "Lakehouse",
        "Workloads",
        "Use OneLake-backed lakehouses for managed data layers.",
      ],
      [
        "warehouse",
        "Warehouse",
        "Workloads",
        "Use Fabric Warehouse for SQL analytics.",
      ],
      [
        "data-factory",
        "Data Factory pipelines",
        "Workloads",
        "Use Fabric pipelines for data movement and orchestration.",
      ],
      [
        "notebooks",
        "Spark notebooks",
        "Workloads",
        "Use notebooks for engineering and transformation.",
      ],
      [
        "semantic-models",
        "Semantic models",
        "Workloads",
        "Publish models for reporting and consumption.",
      ],
      [
        "service-principal-api",
        "Service principals can use Fabric APIs",
        "Access",
        "Tenant administrators control the allowed security groups; individual APIs have additional identity support requirements.",
      ],
      [
        "external-sharing",
        "External sharing",
        "Access",
        "Record the intended boundary for external sharing.",
      ],
      [
        "sensitivity-labels",
        "Sensitivity labels",
        "Governance",
        "Use the organisation’s approved sensitivity classification.",
      ],
      [
        "git-integration",
        "Git integration",
        "Delivery",
        "Version supported workspace items through the configured Git integration.",
      ],
      [
        "deployment-pipelines",
        "Deployment pipelines",
        "Delivery",
        "Promote supported items through reviewed stages.",
      ],
    ],
  },
  {
    id: "databricks",
    name: "Databricks",
    docs: "https://docs.databricks.com/en/data-governance/unity-catalog/index.html",
    authentication: ["databricks-cli", "oauth-m2m", "managed-identity"],
    fields: [
      "workspaceUrl",
      "clientId",
      "accountId",
      "catalog",
      "schema",
      "region",
    ],
    naming: {
      workspace: "{programme}_{environment}",
      catalog: "{programme}_{environment}",
      schema: "{layer}",
      table: "{dataset}",
      job: "{project}_{flow}",
    },
    capabilities: [
      [
        "unity-catalog",
        "Unity Catalog",
        "Governance",
        "Use central governance for data and AI assets.",
      ],
      [
        "external-locations",
        "External locations",
        "Governance",
        "Use governed storage credentials and external locations.",
      ],
      [
        "delta-tables",
        "Delta tables",
        "Workloads",
        "Use Delta tables for managed data layers.",
      ],
      [
        "lakeflow",
        "Lakeflow pipelines",
        "Workloads",
        "Use declarative pipelines for ingestion and transformation.",
      ],
      [
        "jobs",
        "Lakeflow Jobs",
        "Workloads",
        "Schedule and orchestrate engineering work.",
      ],
      [
        "sql-warehouses",
        "SQL warehouses",
        "Workloads",
        "Serve SQL queries through an appropriate warehouse.",
      ],
      [
        "serverless",
        "Serverless compute",
        "Compute",
        "Record whether supported serverless workloads may be used.",
      ],
      [
        "compute-policies",
        "Compute policies",
        "Compute",
        "Constrain approved compute shapes and cost settings.",
      ],
      [
        "secret-scopes",
        "Secret scopes",
        "Access",
        "Reference existing Databricks secret scopes and keys.",
      ],
      [
        "workload-identity",
        "Workload identity",
        "Access",
        "Prefer managed or federated workload credentials where supported.",
      ],
      [
        "bundles",
        "Deployment bundles",
        "Delivery",
        "Version project resources and targets for repeatable deployment.",
      ],
    ],
  },
  {
    id: "adf",
    name: "Azure Data Factory",
    docs: "https://learn.microsoft.com/en-us/azure/data-factory/introduction",
    authentication: ["azure-cli", "service-principal", "managed-identity"],
    fields: [
      "tenantId",
      "clientId",
      "subscriptionId",
      "resourceGroup",
      "factoryName",
      "region",
    ],
    naming: {
      factory: "adf-{programme}-{environment}",
      pipeline: "pl_{project}_{flow}",
      dataset: "ds_{project}_{dataset}",
      linkedService: "ls_{source}",
      integrationRuntime: "ir_{programme}_{environment}",
    },
    capabilities: [
      [
        "copy-activity",
        "Copy activities",
        "Workloads",
        "Move data between supported source and sink connectors.",
      ],
      [
        "mapping-data-flows",
        "Mapping data flows",
        "Workloads",
        "Use managed Spark data flows where appropriate.",
      ],
      [
        "azure-ir",
        "Azure integration runtime",
        "Connectivity",
        "Use a managed integration runtime for supported connectivity.",
      ],
      [
        "self-hosted-ir",
        "Self-hosted integration runtime",
        "Connectivity",
        "Bridge private or on-premises sources through a customer-managed runtime.",
      ],
      [
        "managed-vnet",
        "Managed virtual network",
        "Connectivity",
        "Use managed virtual networking and approved private endpoints.",
      ],
      [
        "managed-identity",
        "Managed identity",
        "Access",
        "Use the factory identity for supported resource access.",
      ],
      [
        "key-vault",
        "Azure Key Vault",
        "Access",
        "Reference credentials from an approved vault linked service.",
      ],
      [
        "git-integration",
        "Git integration",
        "Delivery",
        "Version factory authoring assets in the configured repository.",
      ],
      [
        "triggers",
        "Scheduled triggers",
        "Delivery",
        "Enable reviewed scheduling and event triggers.",
      ],
      [
        "monitoring",
        "Monitoring and diagnostics",
        "Operations",
        "Record operational monitoring and diagnostic requirements.",
      ],
    ],
  },
].map((p) => ({
  ...p,
  profileDefaults: {
    version: 1,
    governance: profileGovernanceDefaults,
    workloads: [
      ...platformProfileSets[p.id]!,
      {
        id: "custom",
        label: "Decide workload later",
        description:
          "Start with naming and review policies; choose workload capabilities individually.",
        generation: {},
        capabilities: {},
      },
    ],
    naming: [
      { id: "shared", label: "Shared platform namespace", values: p.naming },
      {
        id: "project",
        label: "Project-prefixed assets",
        values: {
          ...p.naming,
          ...(p.id === "adf"
            ? { linkedService: "ls_{project}_{source}" }
            : { schema: "{project}_{layer}", table: "{dataset}" }),
        },
      },
    ],
  },
  generation: generationCatalogue[p.id]!,
  generationDefaults: {
    qualityFailure: "block",
    schemaEvolution: "reviewed",
    ...(p.id === "databricks"
      ? {
          bronze: "streaming-table",
          silver: "materialized-view",
          gold: "materialized-view",
        }
      : p.id === "fabric"
        ? { bronze: "lakehouse-table" }
        : { bronze: "file-landing" }),
  },
  capabilities: p.capabilities.map(([id, label, group, description]) => ({
    id: id!,
    label: label!,
    group: group!,
    description: description!,
  })),
  policies: [
    {
      id: "owner-required",
      label: "Named asset owner",
      description: "Every published asset has a responsible owner.",
    },
    {
      id: "quality-required",
      label: "Data quality checks",
      description: "Define acceptance checks for every data layer.",
    },
    {
      id: "review-required",
      label: "Review before promotion",
      description: "Require reviewed definitions before promoting changes.",
    },
    {
      id: "secret-references",
      label: "Secret references only",
      description:
        "Keep credentials out of shared definitions and generated assets.",
    },
    {
      id: "retention-required",
      label: "Retention defined",
      description:
        "Record retention and deletion requirements for each dataset.",
    },
    {
      id: "classification-required",
      label: "Data classification",
      description: "Classify datasets before sharing or publishing.",
    },
  ],
}));
