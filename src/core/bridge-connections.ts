/** Bridge routes (PB-064 phase 5).
 *
 * A connection with `route: bridge` is read natively by one provider (for
 * example ADF reaching a private SQL Server), published by a second (a
 * Databricks job verifies each landed snapshot and appends it to a delivery
 * index), and ingested by the flow's own provider. Core expands the flow into
 * the existing coordinated delivery — landing, publication, ingestion — so each
 * leg is planned, generated and reviewed by its own provider. Nothing is
 * inferred: every setting comes from the connection's bridge block.
 */
import { check, isMap } from "./errors.js";
import { flowSchema } from "./schema.js";

const clone = <T>(value: T): T => structuredClone(value);

/** The land and publish flows a bridge adds, and the rewritten consumer. */
export function expandBridgeFlows<F extends Record<string, any>>(
  projectId: string,
  connections: Record<string, any>,
  flows: F[],
): F[] {
  const out: F[] = [];
  for (const flow of flows) {
    const name = flow.ingestion?.connection;
    const connection = name ? connections[String(name)] : undefined;
    if (connection?.route !== "bridge") {
      out.push(flow);
      continue;
    }
    const bridge = connection.bridge;
    check(
      flow.kind === "ingestion" &&
        flow.tables &&
        Object.keys(flow.tables).length,
      "CONNECTION",
      `${flow.id}: a bridge connection feeds an ingestion flow with tables`,
    );
    check(
      flow.provider && flow.provider !== bridge.provider,
      "CONNECTION",
      `${flow.id}: name the ingesting provider on the flow; the bridge lands through ${bridge.provider}`,
    );
    check(
      !Object.keys(flow.requires ?? {}).length,
      "CONNECTION",
      `${flow.id}: a bridge flow receives its sources from the bridge; remove requires`,
    );
    const {
      connection: _c,
      requires: capabilities,
      execution,
      timeoutSeconds,
      ...ingestion
    } = flow.ingestion;
    check(
      execution === undefined && timeoutSeconds === undefined,
      "CONNECTION",
      `${flow.id}: execution and timeoutSeconds apply to portable connectors`,
    );
    const land = `${flow.id}_land`;
    const publish = `${flow.id}_publish`;
    const tables = Object.keys(flow.tables);
    const leg = (id: string, provider: string, body: Record<string, any>) =>
      ({
        // Parsed like an authored flow so every default is present.
        ...flowSchema.parse({
          apiVersion: flow.apiVersion,
          kind: "ingestion",
          id,
          provider,
          ...(flow.export ? { export: flow.export } : {}),
          ...body,
        }),
        // Marks generated legs for route listing; never part of authored YAML.
        bridgeLeg: { flow: flow.id, connection: String(name) },
      }) as unknown as F;
    out.push(
      leg(land, bridge.provider, {
        ingestion: {
          connection: String(name),
          standard: bridge.standard,
          target: clone(bridge.landing),
          handover: { binding: bridge.handover },
          ...(capabilities ? { requires: capabilities } : {}),
        },
        tables: Object.fromEntries(
          tables.map((t) => [
            t,
            {
              source: clone(flow.tables[t].source ?? {}),
              contract: clone(flow.tables[t].contract),
            },
          ]),
        ),
      }),
      leg(publish, bridge.publisher, {
        ingestion: {
          standard: "snapshot-publication@v1",
          ...clone(bridge.publication),
        },
        requires: Object.fromEntries(
          tables.map((t) => [
            `landing_${t}`,
            {
              dataset: `${projectId}.${land}.${t}.snapshot`,
              select: { mode: "same-run" },
              handover: "files",
            },
          ]),
        ),
        tables: Object.fromEntries(
          tables.map((t) => [
            t,
            {
              source: { from: `requires.landing_${t}` },
              contract: clone(flow.tables[t].contract),
            },
          ]),
        ),
      }),
    );
    for (const t of tables)
      check(
        isMap(flow.tables[t].contract),
        "CONNECTION",
        `${flow.id}.${t}: bridged tables need a reviewed contract`,
      );
    out.push({
      ...flow,
      ingestion,
      requires: Object.fromEntries(
        tables.map((t) => [
          `completed_${t}`,
          {
            dataset: `${projectId}.${publish}.${t}.completed`,
            select: { mode: "same-run" },
            handover: "files",
          },
        ]),
      ),
      tables: Object.fromEntries(
        tables.map((t) => {
          const { source: _s, ...rest } = flow.tables[t];
          return [t, { ...rest, source: { from: `requires.completed_${t}` } }];
        }),
      ),
      bridge: {
        connection: String(name),
        kind: String(connection.kind),
        provider: bridge.provider,
        publisher: bridge.publisher,
        standard: bridge.standard,
        legs: [land, publish],
      },
    } as F);
  }
  return out;
}
