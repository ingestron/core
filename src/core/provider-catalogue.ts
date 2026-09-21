/** Curated official identities, not a marketplace search or production-support
 * guarantee. Browsing works offline. Version discovery is an explicit, bounded
 * GitHub package-network operation; manifests are validated only at installation. */
import { assetPath } from "./installation.js";
import { readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { check, Problem } from "./errors.js";
export interface OfficialPlugin {
  id: string;
  name: string;
  repository: string;
  kind:
    "provider" | "connector" | "model-pack" | "activity-pack" | "report-pack";
  description: string;
  manifestPath: string;
  firstVersion?: string;
  tagPrefix?: string;
  upstream?: string;
  licence?: string;
  engines?: string[];
}
/** One registry drives browse, short installation aliases and version selection. */
export const officialPlugins: readonly OfficialPlugin[] = [
  {
    id: "faker",
    name: "Faker (synthetic data)",
    kind: "connector",
    repository: "ingestron-io/connectors",
    manifestPath: "connectors/faker/connector.yaml",
    tagPrefix: "faker-",
    firstVersion: "0.3.0",
    licence: "Elastic-2.0",
    engines: ["local", "adf-batch", "databricks"],
    description:
      "Airbyte synthetic full snapshots; local runtime verified, cloud assets prepared offline.",
  },
  {
    engines: ["local", "adf-batch", "databricks"],
    id: "postgres",
    name: "PostgreSQL",
    kind: "connector",
    repository: "ingestron-io/connectors",
    manifestPath: "connectors/postgres/connector.yaml",
    tagPrefix: "postgres-",
    firstVersion: "0.12.0",
    upstream: "singer-postgres-meltanolabs",
    licence: "Elastic-2.0",
    description:
      "Customer-operated full snapshots; local POSIX tested, ADF Batch preparation; Databricks driver assets; cloud acceptance open.",
  },
  {
    engines: ["local", "adf-batch", "databricks"],
    id: "github",
    name: "GitHub",
    kind: "connector",
    repository: "ingestron-io/connectors",
    manifestPath: "connectors/github/connector.yaml",
    tagPrefix: "github-",
    firstVersion: "1.31.0",
    upstream: "singer-github-meltanolabs",
    licence: "Apache-2.0",
    description:
      "Customer-operated full snapshots; mocked GitHub runtime tests, ADF Batch preparation; Databricks driver assets; cloud acceptance open.",
  },
  {
    id: "local",
    name: "Local execution",
    kind: "provider",
    repository: "ingestron-io/provider-local",
    manifestPath: "plugin/provider.yaml",
    firstVersion: "0.1.0",
    description:
      "Prepare customer-operated local connector snapshots without Azure or Databricks.",
  },
  {
    id: "streamlit",
    name: "Streamlit reporting",
    repository: "ingestron-io/provider-streamlit",
    kind: "provider",
    manifestPath: "plugin/provider.yaml",
    firstVersion: "0.1.0",
    description:
      "Generate read-only local Streamlit reports from completed common-model snapshots; private preview.",
  },
  {
    id: "finance-streamlit",
    name: "Finance for Streamlit",
    repository: "ingestron-io/model-packs",
    kind: "report-pack",
    manifestPath: "packs/finance-streamlit/pack.yaml",
    tagPrefix: "finance-streamlit-",
    firstVersion: "0.1.0",
    description:
      "Private finance presentation over reconciled common-model values.",
  },
  {
    id: "powerbi",
    name: "Power BI",
    repository: "ingestron-io/provider-powerbi",
    kind: "provider",
    description:
      "Private preview: branded Power BI projects from locked reporting contracts.",
    manifestPath: "plugin/provider.yaml",
    firstVersion: "0.1.0",
  },
  {
    id: "finance",
    name: "Common finance",
    repository: "ingestron-io/model-packs",
    kind: "model-pack",
    description: "Private common finance reporting contracts.",
    manifestPath: "packs/finance/pack.yaml",
    tagPrefix: "finance-model-",
    firstVersion: "0.1.0",
  },
  {
    id: "finance-report",
    name: "Common finance reporting",
    repository: "ingestron-io/model-packs",
    kind: "report-pack",
    description:
      "Private finance dashboard and statements over the common finance model.",
    manifestPath: "packs/finance-report/pack.yaml",
    tagPrefix: "finance-report-",
    firstVersion: "0.1.0",
  },
  {
    id: "adf",
    name: "Azure Data Factory",
    repository: "ingestron-io/provider-adf",
    kind: "provider",
    description:
      "Native ADF ingestion standards and metadata reader preparation.",
    manifestPath: "plugin/provider.yaml",
  },
  {
    id: "databricks",
    name: "Databricks",
    repository: "ingestron-io/provider-databricks",
    kind: "provider",
    description: "Native ingestion, history and SQL transformation standards.",
    manifestPath: "plugin/provider.yaml",
  },
  {
    id: "duckdb",
    name: "DuckDB",
    repository: "ingestron-io/provider-duckdb",
    kind: "provider",
    description:
      "Create-only local Parquet-to-table SQL projects; no cloud execution.",
    manifestPath: "plugin/provider.yaml",
  },
  {
    id: "northwind",
    name: "Northwind",
    repository: "ingestron-io/model-packs",
    kind: "model-pack",
    description:
      "Reusable Northwind table contracts, relationships and explicit tabular projections.",
    manifestPath: "packs/northwind/pack.yaml",
    firstVersion: "0.1.0",
  },
  {
    id: "xero",
    name: "Xero accounting",
    repository: "ingestron-io/model-packs",
    kind: "model-pack",
    description:
      "Tenant-scoped accounting model projections; no Xero connector or verified trial-account schema.",
    manifestPath: "packs/xero/pack.yaml",
    firstVersion: "0.1.0",
  },
  {
    id: "sql-snapshot",
    name: "SQL snapshot presets",
    repository: "ingestron-io/provider-adf",
    kind: "activity-pack",
    description:
      "Guarded snapshot defaults bound to the same exact ADF provider version.",
    manifestPath: "packs/sql-snapshot/pack.yaml",
    firstVersion: "2.3.0",
  },
];
export const officialProviders = officialPlugins.filter(
  (p) => p.kind === "provider",
);
export const pluginKindLabel = (kind: OfficialPlugin["kind"]) =>
  ({
    provider: "Provider",
    connector: "Connector",
    "model-pack": "Model pack",
    "report-pack": "Report pack",
    "activity-pack": "Activity preset pack",
  })[kind];
export function providerRepository(name: string): string {
  const repository =
    officialPlugins.find((p) => p.id === name)?.repository ?? name;
  check(
    /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(
      repository,
    ) && !repository.includes(".."),
    "PACKAGE",
    "Choose a package from plugin browse or a GitHub owner/repository",
  );
  return repository;
}
export function shortProvider(repository: string) {
  return (
    officialProviders.find((p) => p.repository === repository)?.id ?? repository
  );
}
/** Preserve explicit non-standard manifest paths and commit selectors. */
export function friendlyReference(reference: string): string {
  for (const plugin of officialPlugins) {
    const prefix = `${plugin.repository}/${plugin.manifestPath}`;
    if (reference === prefix || reference.startsWith(prefix + "@"))
      return friendlyReference(plugin.id + reference.slice(prefix.length));
  }
  const short = reference.replace(/\/plugin\/provider\.yaml(?=@|$)/, "");
  const at = short.lastIndexOf("@");
  const repository = at < 0 ? short : short.slice(0, at);
  const selector = at < 0 ? "" : short.slice(at + 1);
  const version = /^v?\d+\.\d+\.\d+$/.test(selector)
    ? `v${selector.replace(/^v/, "")}`
    : selector;
  return shortProvider(repository) + (selector ? `@${version}` : "");
}
let imported: any;
export function upstreamCatalogue(): any {
  return (imported ??= JSON.parse(
    readFileSync(assetPath("catalogue/meltano.json"), "utf8"),
  ));
}
export function browseProviders(
  query = "",
  kind?: string,
  filters: { engine?: string; installable?: boolean } = {},
) {
  check(
    !kind ||
      [
        "provider",
        "connector",
        "model-pack",
        "activity-pack",
        "report-pack",
      ].includes(kind),
    "INPUT",
    "Unknown plugin category",
  );
  check(
    !filters.engine ||
      ["local", "adf-batch", "databricks"].includes(filters.engine),
    "INPUT",
    "Unknown connector engine",
  );
  const prepared = new Set(
    officialPlugins.map((p) => p.upstream).filter(Boolean),
  );
  const entries = [
    ...officialPlugins.map((p) => ({
      ...p,
      kindLabel: pluginKindLabel(p.kind),
      official: true,
      engines:
        p.engines ?? (p.kind === "connector" ? ["local", "adf-batch"] : []),
      availability: "private-preview",
      installable: true,
      documentation: "https://docs.ingestron.io",
      licence:
        p.licence ??
        "Private preview; review exact-version package licences and third-party notices on installation",
      url: `https://github.com/${p.repository}`,
      install: `ingestron plugin install ${p.id}`,
      versions: `ingestron plugin versions ${p.id}`,
      evidence:
        p.kind === "connector"
          ? "Selected snapshot projections only; customer-operated use; runtime dependencies are prepared separately with exact locks."
          : "Package-specific compatibility",
    })),
    ...upstreamCatalogue()
      .entries.filter((p: any) => !prepared.has(p.id))
      .map((p: any) => ({
        id: p.id,
        name: `${p.name} (${p.variant})`,
        kind: "connector",
        kindLabel: "Connector",
        official: false,
        description: p.description,
        engines: [] as string[],
        availability: "catalogue-only",
        installable: false,
        documentation: p.documentation,
        licence: p.declaredLicence + " (upstream metadata; not verified)",
        url: p.repository ?? p.documentation,
        install: null,
        versions: null,
        evidence:
          "Upstream definition only. No approved exact runtime, licence evidence or Ingestron engine compatibility. Installation unavailable.",
      })),
  ];
  const needle = query.toLowerCase();
  return entries.filter(
    (p) =>
      (!kind || p.kind === kind) &&
      (!filters.installable || p.installable) &&
      (!filters.engine || p.engines.includes(filters.engine)) &&
      `${p.id} ${p.name} ${p.kind} ${p.kindLabel} ${p.description}`
        .toLowerCase()
        .includes(needle),
  );
}
export function pluginDetails(id: string) {
  const entry = browseProviders().find((p) => p.id === id);
  check(entry, "PACKAGE", "Unknown plugin; use plugin browse");
  const upstreamId = officialPlugins.find((p) => p.id === id)?.upstream ?? id;
  const upstream = upstreamCatalogue().entries.find(
    (p: any) => p.id === upstreamId,
  );
  return {
    ...entry,
    ...(upstream
      ? {
          upstream,
          catalogueCommit: upstreamCatalogue().commit,
          catalogueLicence: upstreamCatalogue().licence,
        }
      : {}),
  };
}
export function packageGitEnvironment() {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}
export function gitTags(repository: string, fromGit?: string) {
  providerRepository(repository);
  try {
    return execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=!gh auth git-credential",
        "ls-remote",
        "--tags",
        "--",
        fromGit
          ? realpathSync(fromGit)
          : `https://github.com/${repository}.git`,
      ],
      {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: packageGitEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    // Git stderr may include authentication diagnostics. Do not echo it into
    // terminal/JSON responses; callers get a stable, actionable diagnostic.
    throw new Problem(
      "PACKAGE",
      `Cannot read plugin versions from ${repository}`,
      undefined,
      undefined,
      "Check repository access and GitHub authentication (gh auth login), then retry. Private official previews require repository access.",
    );
  }
}
export function taggedVersions(text: string, prefix = "") {
  check(/^[a-z0-9-]*$/.test(prefix), "PACKAGE", "Invalid package tag prefix");
  const refs = new Map<string, string>();
  const lines = text.trim() ? text.trim().split("\n") : [];
  check(
    lines.length <= 10000,
    "LIMIT",
    "Provider tag listing exceeds 10,000 refs",
  );
  for (const line of lines) {
    if (prefix && !line.includes("refs/tags/" + prefix)) continue;
    const match =
      /^([a-f0-9]{40})\s+refs\/tags\/(v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(\^\{\})?$/.exec(
        prefix ? line.replace("refs/tags/" + prefix, "refs/tags/") : line,
      );
    if (match) refs.set(match[2] + (match[3] ?? ""), match[1]);
  }
  const versions = new Map<
    string,
    { version: string; tag: string; commit: string; ambiguous: boolean }
  >();
  for (const [tag, object] of refs) {
    if (tag.endsWith("^{}")) continue;
    const version = tag.replace(/^v/, ""),
      commit = refs.get(tag + "^{}") ?? object;
    const prior = versions.get(version);
    const ambiguous = !!prior && (prior.ambiguous || prior.commit !== commit);
    versions.set(version, {
      version,
      tag: prior && !tag.startsWith("v") ? prior.tag : prefix + tag,
      commit,
      ambiguous,
    });
  }
  return [...versions.values()].sort((a, b) => {
    const left = a.version.split(".").map(Number),
      right = b.version.split(".").map(Number);
    return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
  });
}
export function pluginForManifest(repository: string, path: string) {
  return officialPlugins.find(
    (p) => p.repository === repository && p.manifestPath === path,
  );
}
export function providerVersions(name: string, fromGit?: string) {
  const repository = providerRepository(name);
  const plugin = officialPlugins.find((p) => p.id === name);
  const identity = plugin?.id ?? shortProvider(repository);
  const atLeast = (version: string, minimum: string) => {
    const parts = version.split(".").map(Number),
      min = minimum.split(".").map(Number);
    for (let i = 0; i < 3; i++)
      if (parts[i] !== min[i]) return parts[i] > min[i];
    return true;
  };
  const versions = taggedVersions(
    gitTags(repository, fromGit),
    plugin?.tagPrefix,
  )
    .map((v) => ({ ...v, repository }))
    .filter(
      (v) => !plugin?.firstVersion || atLeast(v.version, plugin.firstVersion),
    )
    .map((v) => ({
      ...v,
      reference: `${identity}@v${v.version}`,
      selectable: !v.ambiguous,
      compatibility: "unchecked",
    }));
  return {
    provider: identity,
    ...(plugin ? { kind: plugin.kind } : {}),
    repository,
    official:
      !fromGit &&
      (!!plugin || officialProviders.some((p) => p.repository === repository)),
    source: fromGit ? "local-git" : "github",
    versions,
    evidence:
      "Git tags only; manifest and CLI compatibility are checked during installation",
  };
}
