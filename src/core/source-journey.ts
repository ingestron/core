/** Resume current metadata and contract selections without executing a source. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { z } from "zod";
import {
  sourceAccessDefinition,
  sourceAccessResponseSchema,
} from "./source-access.js";
import {
  fence,
  configuredPackageReference,
  resolvePackage,
  packageYaml,
} from "./packages.js";
import { projectPackages } from "./project-packages.js";
import { check } from "./errors.js";
import type { Context } from "./operations.js";

export const sourceJourneySchema = z
  .object({
    connection: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/),
    executor: z.string().optional(),
    receipt: z.string().uuid().optional(),
  })
  .strict();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function inspectSourceJourney(
  context: Context,
  args: z.infer<typeof sourceJourneySchema>,
) {
  const def = sourceAccessDefinition(context, args);
  let bytesRead = 0;
  const read = (path: string) => {
    const file = fence(context.root, path);
    const bytes = statSync(file).size;
    bytesRead += bytes;
    check(
      bytesRead <= 32 * 1024 * 1024,
      "LIMIT",
      "Archive old discovery records before continuing",
    );
    check(
      bytes <= 4 * 1024 * 1024,
      "LIMIT",
      "Saved discovery exceeds supported bounds",
    );
    return JSON.parse(readFileSync(file, "utf8"));
  };
  const matches = (v: any) =>
    v.connection === args.connection &&
    v.environment === def.environment &&
    v.fingerprint === def.fingerprint;
  const folder = ".ingestron/source-access";
  const records: any[] = [];
  if (existsSync(fence(context.root, folder))) {
    const files = readdirSync(fence(context.root, folder)).filter(
      (n) => n.endsWith(".json") && uuid.test(n.slice(0, -5)),
    );
    check(
      files.length <= 10000,
      "LIMIT",
      "Archive old discovery receipts before continuing",
    );
    for (const file of files) {
      const r = read(`${folder}/${file}`);
      if (
        r.apiVersion === "ingestron.source-access-receipt/v1" &&
        matches(r) &&
        r.action === "metadata" &&
        r.status === "succeeded" &&
        r.result?.status === "succeeded" &&
        Array.isArray(r.result.tables) &&
        r.result.tables.length <= 200 &&
        r.id === file.slice(0, -5)
      )
        records.push(r);
    }
  }
  records.sort((a, b) =>
    String(b.startedAt).localeCompare(String(a.startedAt)),
  );
  const selected = args.receipt
    ? records.find((r) => r.id === args.receipt)
    : records[0];
  check(
    !args.receipt || selected,
    "STALE",
    "Choose a current metadata receipt for this connection and environment",
  );
  if (selected)
    selected.result = sourceAccessResponseSchema.parse(selected.result);
  const drafts: any[] = [];
  const draftRoot = `contracts/discovery/${def.environment}/${args.connection}`;
  if (selected && existsSync(fence(context.root, draftRoot))) {
    const folders = readdirSync(fence(context.root, draftRoot)).filter((n) =>
      uuid.test(n),
    );
    check(
      folders.length <= 1000,
      "LIMIT",
      "Archive old discovery drafts before continuing",
    );
    for (const folder of folders) {
      const path = `${draftRoot}/${folder}/selection.json`;
      if (!existsSync(fence(context.root, path))) continue;
      const s = read(path);
      if (
        s.apiVersion !== "ingestron.source-selection/v1" ||
        !matches(s) ||
        s.receipt !== selected.id ||
        !Array.isArray(s.tables)
      )
        continue;
      for (const t of s.tables) {
        if (
          typeof t.name !== "string" ||
          typeof t.id !== "string" ||
          typeof t.file !== "string" ||
          !Number.isInteger(t.fields) ||
          t.fields < 0 ||
          t.fields > 100000 ||
          !/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(t.name) ||
          t.file !== `${draftRoot}/${folder}/${t.name}.odcs.yaml` ||
          !selected.result.tables.some((o: any) => o.id === t.id) ||
          !existsSync(fence(context.root, t.file))
        )
          continue;
        drafts.push({ id: t.id, name: t.name, file: t.file, fields: t.fields });
      }
    }
  }
  const packages = projectPackages(def.project);
  const providers = Object.entries<any>(
    def.project.providers.configurations,
  ).flatMap(([id, config]) => {
    try {
      const manifest = packageYaml(
        resolvePackage(
          context.root,
          configuredPackageReference(packages[config.package]),
        ).file,
      );
      if (
        manifest.platform !== "local" &&
        !manifest.authoring?.flows?.kinds?.includes("ingestion")
      )
        return [];
      return [
        {
          id,
          platform: manifest.platform,
          standards: manifest.standards ?? [],
        },
      ];
    } catch {
      return [];
    }
  });
  return {
    apiVersion: "ingestron.source-journey/v1",
    receipt: selected?.id ?? "",
    receipts: records.slice(0, 100).map((r) => ({
      id: r.id,
      at: r.startedAt,
      objects: r.result.tables.length,
    })),
    tables: selected?.result.tables ?? [],
    drafts,
    providers,
  };
}
