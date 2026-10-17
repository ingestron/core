/** Read-only engineering inventory. No credentials, source rows or execution. */
import { inspectProject } from "./planner.js";
import { qualityCoverage } from "./project-build.js";
import { contractRules, coverageSummary } from "./quality.js";
import { projectPackages } from "./project-packages.js";
import {
  configuredPackageReference,
  resolvePackage,
  packageYaml,
} from "./packages.js";
import { check, Problem } from "./errors.js";

export function inspectEngineering(root: string, environment: string) {
  const state = inspectProject(root, environment, { draft: true });
  const project = state.project;
  check(
    state.flows.length <= 1000,
    "LIMIT",
    "Engineering inventory exceeds 1000 flows",
  );
  const issues: { area: string; subject: string; code: string }[] = [];
  const issue = (area: string, subject: string, error: unknown) =>
    issues.push({
      area,
      subject,
      code:
        error instanceof Problem && /^[A-Z_]{1,64}$/.test(error.code)
          ? error.code
          : "UNAVAILABLE",
    });
  const packages = Object.entries(projectPackages(project)).map(([id, pkg]) => {
    try {
      const locked = resolvePackage(root, configuredPackageReference(pkg));
      const manifest = packageYaml(locked.file);
      return {
        id,
        version: String(manifest.version ?? pkg.version),
        installed: true,
        kind: String(manifest.apiVersion ?? "unknown"),
        name: String(manifest.id ?? manifest.name ?? id),
        capabilities: Array.isArray(manifest.authoring?.flows?.kinds)
          ? manifest.authoring.flows.kinds.filter(
              (k: unknown) => typeof k === "string",
            )
          : [],
      };
    } catch (error) {
      issue("packages", id, error);
      return {
        id,
        version: pkg.version,
        installed: false,
        kind: "unknown",
        name: id,
        capabilities: [] as string[],
      };
    }
  });
  const connections = Object.entries(project.connections).map(([id, c]) => ({
    id,
    sourceId: c.sourceId,
    connector: c.connector ?? c.kind ?? c.package ?? "unconfigured",
    package: c.package ?? "",
    route: c.route ?? "portable",
    binding: c.binding ?? "",
    flows: state.flows
      .filter((f) => f.ingestion?.connection === id)
      .map((f) => f.id),
  }));
  const outputs = state.flows.flatMap((flow) =>
    [
      ...Object.entries<any>(flow.tables ?? {}).map(([name, table]) => ({
        name,
        table,
        published: false,
      })),
      ...Object.entries<any>(flow.publishes ?? {}).map(([name, table]) => ({
        name,
        table,
        published: true,
      })),
    ].map(({ name, table, published }) => {
      const contract = table.contract;
      let rules = 0;
      try {
        if (contract) rules = contractRules(contract).length;
      } catch (error) {
        issue("quality", `${flow.id}/${name}`, error);
      }
      return {
        flow: flow.id,
        kind: flow.kind,
        name,
        published,
        contract: String(contract?.id ?? ""),
        status: String(contract?.status ?? "undefined"),
        fields: (contract?.schema ?? []).reduce(
          (sum: number, schema: any) => sum + (schema.properties?.length ?? 0),
          0,
        ),
        rules,
      };
    }),
  );
  const coverage = state.flows.flatMap((flow) => {
    try {
      check(
        flow.provider ?? project.defaults.provider,
        "PROVIDER",
        "Assign a target to inspect quality coverage",
      );
      return qualityCoverage(root, state, [flow] as any);
    } catch (error) {
      issue("quality", flow.id, error);
      return [];
    }
  });
  return {
    apiVersion: "ingestron.engineering-workbench/v1" as const,
    project: project.id,
    environment,
    evidence: "offline" as const,
    packages,
    connections,
    outputs,
    flows: state.flows.map((f) => ({
      id: f.id,
      kind: f.kind,
      description: f.description ?? "",
      provider: f.provider ?? project.defaults.provider ?? "",
      scheduled: !!f.schedule,
    })),
    quality: {
      complete: !issues.some((i) => i.area === "quality"),
      summary: coverageSummary(coverage),
      rules: coverage.map((r) => ({
        id: r.id,
        contract: r.contract,
        flow: r.flow,
        field: r.column ?? "",
        metric: r.metric ?? r.type,
        mode: r.mode,
        outcome: r.outcome,
        platform: r.platform,
      })),
    },
    issues,
  };
}
