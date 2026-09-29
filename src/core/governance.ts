/** Data product ownership and rule inventory read from ODCS v3.1.0 contracts. */
import { check } from "./errors.js";

export interface DataProduct {
  contract: string;
  name?: string;
  version?: string;
  status?: string;
  team?: string;
  owners: string[];
  stewards: string[];
  /** Quality rules recorded in the contract; enforcement arrives in PB-063 phase 3. */
  qualityRules: number;
  enforcedQualityRules: number;
  flows: string[];
}

const today = () => new Date().toISOString().slice(0, 10);

// ODCS v3 uses `team: { members: [...] }`; the deprecated v2 array form is still valid.
function members(contract: Record<string, any>): Record<string, any>[] {
  const list = Array.isArray(contract.team)
    ? contract.team
    : Array.isArray(contract.team?.members)
      ? contract.team.members
      : [];
  return list.filter(
    (m: any) =>
      m &&
      typeof m.username === "string" &&
      !(typeof m.dateOut === "string" && m.dateOut <= today()),
  );
}

const withRole = (list: Record<string, any>[], pattern: RegExp) =>
  [
    ...new Set(
      list
        .filter((m) => typeof m.role === "string" && pattern.test(m.role))
        .map((m) => m.username as string),
    ),
  ].sort();

function countQuality(contract: Record<string, any>): number {
  const rules = (value: any) => (Array.isArray(value) ? value.length : 0);
  let count = rules(contract.quality);
  for (const object of Array.isArray(contract.schema) ? contract.schema : []) {
    count += rules(object?.quality);
    for (const property of Array.isArray(object?.properties)
      ? object.properties
      : [])
      count += rules(property?.quality);
  }
  return count;
}

export function contractGovernance(
  contract: Record<string, any>,
): Omit<DataProduct, "flows"> {
  const list = members(contract);
  return {
    contract: String(contract.id ?? contract.name ?? "unnamed"),
    ...(contract.name ? { name: String(contract.name) } : {}),
    ...(contract.version ? { version: String(contract.version) } : {}),
    ...(contract.status ? { status: String(contract.status) } : {}),
    ...(typeof contract.team?.name === "string"
      ? { team: contract.team.name }
      : {}),
    owners: withRole(list, /owner/i),
    stewards: withRole(list, /steward/i),
    qualityRules: countQuality(contract),
    enforcedQualityRules: 0,
  };
}

/** An active contract is a published agreement, so it must name its owner. */
export function checkContractGovernance(
  contract: Record<string, any>,
  file?: string,
): void {
  if (contract.status !== "active") return;
  check(
    contractGovernance(contract).owners.length > 0,
    "GOVERNANCE",
    "An active contract must name an owner: add a team member whose role contains 'owner'",
    file,
  );
}

/** Data products used by the given flows, one entry per contract identity. */
export function dataProducts(
  flows: { id: string; tables?: Record<string, any> }[],
): DataProduct[] {
  const products = new Map<string, DataProduct>();
  for (const flow of flows)
    for (const table of Object.values(flow.tables ?? {})) {
      const contract = table?.contract;
      if (!contract || typeof contract !== "object") continue;
      const product = contractGovernance(contract);
      const key = `${product.contract}@${product.version ?? ""}`;
      const existing = products.get(key);
      if (existing) {
        if (!existing.flows.includes(flow.id)) existing.flows.push(flow.id);
      } else products.set(key, { ...product, flows: [flow.id] });
    }
  return [...products.values()]
    .map((p) => ({ ...p, flows: p.flows.sort() }))
    .sort((a, b) => a.contract.localeCompare(b.contract));
}
