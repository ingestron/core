/** Source kinds, routes and reference records (PB-064 / PD-157).
 *
 * A connection reads one source kind. Connector packages supply the portable
 * route; provider manifests declare native routes per kind. Every route carries
 * one reference record so users compare documentation, status, licence, cost,
 * access and maturity in one format. Nothing here selects a route silently.
 */
import { z } from "zod";
import { check } from "./errors.js";

export const sourceCapabilities = [
  "snapshot",
  "incremental",
  "cdc",
  "deletes",
  "discovery",
] as const;
export type SourceCapability = (typeof sourceCapabilities)[number];
export const maturityLevels = ["preview", "verified", "qualified"] as const;

const kind = z.string().regex(/^[a-z][a-z0-9-]*$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const url = z.string().url();

export const referenceRecordSchema = z
  .object({
    docs: url,
    vendorStatus: z.enum(["ga", "preview", "beta", "not-applicable"]),
    licence: z.string().min(1),
    cost: z
      .object({
        model: z.enum(["none", "included", "separately-billed"]),
        pricing: url.optional(),
        note: z.string().min(1).optional(),
      })
      .strict(),
    access: z
      .object({
        model: z.enum([
          "none",
          "free",
          "free-tier",
          "trial",
          "subscription",
          "platform",
        ]),
        url: url.optional(),
        note: z.string().min(1).optional(),
      })
      .strict(),
    auth: z.array(z.string().min(1)).default([]),
    network: z
      .array(z.enum(["local", "public", "private-network", "on-premises"]))
      .min(1),
    maturity: z.enum(maturityLevels),
    verified: isoDate,
    note: z.string().min(1).optional(),
  })
  .strict();
export type ReferenceRecord = z.infer<typeof referenceRecordSchema>;

const capabilitiesSchema = z.array(z.enum(sourceCapabilities)).min(1);

/** Connector manifests: the source kind a package reads, as a portable route. */
export const connectorSourceSchema = z
  .object({
    kind,
    capabilities: capabilitiesSchema,
    reference: referenceRecordSchema,
  })
  .strict();

/** Provider manifests: native routes by source kind. */
export const providerSourcesSchema = z.record(
  kind,
  z
    .object({
      route: z.literal("native"),
      standards: z.array(z.string().regex(/^[a-z0-9-]+@v\d+$/)).min(1),
      capabilities: capabilitiesSchema,
      reference: referenceRecordSchema,
      /** JSON Schema for the environment binding a native connection uses. */
      bindingSchema: z.record(z.string(), z.unknown()).optional(),
      /** The standard's source settings, with {{binding.*}} and {{connection.*}}
       * placeholders; table source settings are merged over it. */
      source: z.record(z.string(), z.unknown()).optional(),
    })
    .strict()
    .refine((r) => !r.source === !r.bindingSchema, {
      message: "Declare source and bindingSchema together",
    }),
);

export interface Route {
  route: "portable" | "native";
  configuration: string;
  platform: string;
  package?: string;
  standards?: string[];
  capabilities: SourceCapability[];
  reference?: ReferenceRecord;
}

export interface ConnectionRoutes {
  flow: string;
  connection: string;
  kind: string;
  selected: Route;
  /** Native routes on configured providers; never separately billed. */
  alternative?: Route;
  routes: Route[];
  missing: SourceCapability[];
}

const billed = (r: Route) => r.reference?.cost.model === "separately-billed";

/** Routes for one connection flow: its selected portable route and the native
 * routes other configured providers declare for the same source kind. */
export function connectionRoutes(input: {
  flow: string;
  connection: string;
  kind: string;
  selected: Route;
  natives: Route[];
  requires?: SourceCapability[];
}): ConnectionRoutes {
  const routes = [input.selected, ...input.natives];
  const missing = (input.requires ?? []).filter(
    (c) => !input.selected.capabilities.includes(c),
  );
  const alternative = input.natives
    .filter((r) => !billed(r))
    .sort(
      (a, b) =>
        Number(b.configuration === input.selected.configuration) -
        Number(a.configuration === input.selected.configuration),
    )[0];
  return {
    flow: input.flow,
    connection: input.connection,
    kind: input.kind,
    selected: input.selected,
    ...(alternative ? { alternative } : {}),
    routes,
    missing,
  };
}

/** A flow that requires a capability its route cannot supply is rejected. */
export function checkRoutes(entries: ConnectionRoutes[]): void {
  const blocked = entries.filter((e) => e.missing.length);
  check(
    !blocked.length,
    "CAPABILITY",
    blocked
      .map(
        (e) =>
          `${e.flow}: connection ${e.connection} (${e.kind}) cannot supply ${e.missing.join(", ")} through ${e.selected.route} ${e.selected.package ?? e.selected.configuration}`,
      )
      .join("; "),
  );
}

/** Reference records older than this many days are reported as stale. */
export const staleAfterDays = 180;
export function staleReference(
  reference: ReferenceRecord | undefined,
  today = new Date(),
): boolean {
  if (!reference) return false;
  const age =
    (today.getTime() - new Date(reference.verified + "T00:00:00Z").getTime()) /
    86_400_000;
  return age > staleAfterDays;
}
