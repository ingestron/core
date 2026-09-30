import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkRoutes,
  connectionRoutes,
  connectorSourceSchema,
  providerSourcesSchema,
  staleReference,
  type Route,
} from "../../src/core/sources.js";

export const reference = (extra: any = {}) => ({
  docs: "https://example.invalid/docs",
  vendorStatus: "ga",
  licence: "Apache-2.0",
  cost: { model: "none" },
  access: { model: "free" },
  network: ["public"],
  maturity: "preview",
  verified: "2026-09-30",
  ...extra,
});
const portable: Route = {
  route: "portable",
  configuration: "local",
  platform: "local",
  package: "sql-server@1.4.0",
  capabilities: ["snapshot", "discovery"],
};
const native = (configuration: string, cost = "included"): Route => ({
  route: "native",
  configuration,
  platform: configuration,
  standards: ["snapshot-land@v1"],
  capabilities: ["snapshot", "incremental"],
  reference: reference({ cost: { model: cost } }) as any,
});

test("reference records and source declarations are validated", () => {
  assert.doesNotThrow(() =>
    connectorSourceSchema.parse({
      kind: "sql-server",
      capabilities: ["snapshot", "discovery"],
      reference: reference(),
    }),
  );
  for (const bad of [
    { maturity: "beta" },
    { verified: "30/09/2026" },
    { cost: { model: "cheap" } },
    { network: [] },
    { docs: "not a url" },
  ])
    assert.throws(() =>
      connectorSourceSchema.parse({
        kind: "sql-server",
        capabilities: ["snapshot"],
        reference: reference(bad),
      }),
    );
  assert.throws(() =>
    providerSourcesSchema.parse({
      "sql-server": {
        route: "portable",
        standards: ["x@v1"],
        capabilities: ["snapshot"],
        reference: reference(),
      },
    }),
  );
});

test("routes list natives, never propose separately billed ones, and flag missing capabilities", () => {
  const entry = connectionRoutes({
    flow: "sales",
    connection: "erp",
    kind: "sql-server",
    selected: portable,
    natives: [native("dbx", "separately-billed"), native("adf")],
    requires: ["incremental"],
  });
  assert.equal(entry.routes.length, 3);
  assert.equal(entry.alternative?.configuration, "adf");
  assert.deepEqual(entry.missing, ["incremental"]);
  assert.throws(() => checkRoutes([entry]), /cannot supply incremental/);
  const billedOnly = connectionRoutes({
    flow: "sales",
    connection: "erp",
    kind: "sql-server",
    selected: portable,
    natives: [native("dbx", "separately-billed")],
  });
  assert.equal(billedOnly.alternative, undefined);
  assert.doesNotThrow(() => checkRoutes([billedOnly]));
});

test("stale reference records are reported after 180 days", () => {
  const r = reference() as any;
  assert.equal(staleReference(r, new Date("2027-03-01T00:00:00Z")), false);
  assert.equal(staleReference(r, new Date("2027-04-15T00:00:00Z")), true);
  assert.equal(staleReference(undefined), false);
});

test("providers declaring sources must require the host feature", async () => {
  const { checkProviderCompatibility } =
    await import("../../src/plugins/compatibility.js");
  const manifest = (requiredFeatures: string[]) => ({
    compatibility: { minimumCli: "4.2.0", requiredFeatures },
    sources: {},
  });
  assert.throws(
    () => checkProviderCompatibility(manifest([])),
    /source-coverage/,
  );
  assert.doesNotThrow(() =>
    checkProviderCompatibility(manifest(["source-coverage"])),
  );
});
