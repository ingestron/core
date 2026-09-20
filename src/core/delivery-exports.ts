import { canonical, check, digest } from "./errors.js";
import type { Plan } from "./schema.js";

/** Partition compilation only. This never schedules jobs or asserts data exists. */
export function deliveryExports(plan: Plan) {
  const groups = new Map<string, Plan["nodes"]>();
  const owner = new Map<string, string>();
  for (const node of plan.nodes) {
    check(
      plan.selection.projectBuild || node.runtime?.capabilities?.delivery,
      "CAPABILITY",
      `Provider configuration ${node.runtime?.configuration} must opt in to delivery exports`,
    );
    check(
      node.runtime?.configuration,
      "PROVIDER",
      "Native node needs a provider configuration",
    );
    const id = plan.selection.projectBuild
      ? node.runtime.configuration
      : `${node.exportGroup ?? node.flow}/${node.runtime.configuration}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(node);
    owner.set(node.id, id);
  }
  const claims = new Map<string, string>();
  for (const [group, nodes] of groups)
    for (const node of nodes)
      for (const resource of node.resources ?? []) {
        const identity = canonical([
          node.platform,
          resource.scope,
          resource.kind,
          resource.name,
        ]);
        check(
          !claims.has(identity) || claims.get(identity) === group,
          "OWNER",
          `Native ${resource.kind} ${resource.name} is claimed by exports ${claims.get(identity)} and ${group}; use one export group`,
        );
        claims.set(identity, group);
      }
  const exports = [...groups].map(([id, nodes]) => {
    const ids = new Set(nodes.map((n) => n.id));
    const imports: {
      dataset: string;
      producer: string;
      kind: "files" | "relation";
      location: Record<string, unknown>;
      contract: Record<string, unknown>;
    }[] = [];
    for (const node of nodes)
      for (const dependency of node.needs) {
        if (ids.has(dependency)) continue;
        const flow = plan.flows.find((f) => f.id === node.flow)!;
        const requirements = Object.values(flow.requires).filter(
          (r) => plan.datasets[r.dataset]?.producer === dependency,
        );
        check(
          requirements.length,
          "HANDOVER",
          `Export ${id} requires an explicit handover for ${dependency}`,
        );
        for (const required of requirements) {
          check(
            required.handover,
            "HANDOVER",
            `Export ${id} requires an explicit handover for ${dependency}`,
          );
          const dataset = plan.datasets[required.dataset];
          if (!imports.some((i) => i.dataset === required.dataset))
            imports.push({
              dataset: required.dataset,
              producer: owner.get(dependency)!,
              kind: required.handover,
              location: dataset.location!,
              contract: dataset.contract,
            });
        }
      }
    imports.sort((a, b) =>
      a.dataset < b.dataset ? -1 : a.dataset > b.dataset ? 1 : 0,
    );
    const refs = new Set(
      nodes
        .flatMap((n) => [
          n.runtime?.rendererRef,
          n.runtime?.lifecycleRef,
          n.runtime?.outputSchemasRef,
          n.generation?.runtimeRef,
          n.generation?.codeRef,
        ])
        .filter(Boolean),
    );
    const bindings = new Set(
      nodes.flatMap((n) => [n.binding, n.source?.binding]).filter(Boolean),
    );
    for (const input of imports) bindings.add(input.location.binding);
    for (const dataset of Object.values(plan.datasets))
      if (
        ids.has(dataset.producer) &&
        typeof dataset.location?.binding === "string"
      )
        bindings.add(dataset.location.binding);
    const { digest: _digest, ...body } = plan;
    const partBody = {
      ...body,
      selection: {},
      nodes: nodes.map((n) => ({
        ...n,
        needs: n.needs.filter((d) => ids.has(d)),
      })),
      flows: plan.flows.filter((f) => nodes.some((n) => n.flow === f.id)),
      datasets: Object.fromEntries(
        Object.entries(plan.datasets).filter(
          ([key, d]) =>
            ids.has(d.producer) || imports.some((i) => i.dataset === key),
        ),
      ),
      bindings: Object.fromEntries(
        Object.entries(plan.bindings).filter(([key]) => bindings.has(key)),
      ),
      activitySources: Object.fromEntries(
        Object.entries(plan.activitySources).filter(([key]) => refs.has(key)),
      ),
      names: {
        nodes: Object.fromEntries(
          Object.entries(plan.names.nodes).filter(([key]) => ids.has(key)),
        ),
        jobs: Object.fromEntries(
          Object.entries(plan.names.jobs).filter(([key]) =>
            nodes.some((n) => n.flow === key),
          ),
        ),
      },
      recovery: plan.recovery.filter((r) =>
        nodes.some((n) => n.flow === r.flow),
      ),
      delivery: { exportId: id, imports },
    };
    const part: Plan = { ...partBody, digest: digest(canonical(partBody)) };
    return {
      id,
      directory: `exports/${id}`,
      needs: [...new Set(imports.map((i) => i.producer))].sort(),
      imports,
      resources: [
        ...new Map(
          nodes.flatMap((n) => n.resources ?? []).map((r) => [canonical(r), r]),
        ).values(),
      ],
      plan: part,
    };
  });
  const ordered: typeof exports = [],
    active = new Set<string>(),
    done = new Set<string>();
  const visit = (id: string) => {
    check(
      !active.has(id),
      "CYCLE",
      `Delivery export dependency cycle at ${id}`,
    );
    if (done.has(id)) return;
    const entry = exports.find((e) => e.id === id);
    check(entry, "HANDOVER", `Missing delivery export ${id}`);
    active.add(id);
    entry.needs.forEach(visit);
    active.delete(id);
    done.add(id);
    ordered.push(entry);
  };
  exports
    .map((e) => e.id)
    .sort()
    .forEach(visit);
  return ordered;
}
