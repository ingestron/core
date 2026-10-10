/** Reviewed offline presentation assets; source extraction and deployment stay separate. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { z } from "zod";
import { stringify } from "yaml";
import { Configuration } from "./config.js";
import { check, digest, Problem } from "./errors.js";
import { fence, packageYaml, resolvePackage } from "./packages.js";
import { browseProviders } from "./installed-plugins.js";
import { pluginCommands, runProviderCommand } from "./provider-commands.js";
import { reportPackSchema } from "./report-pack-schema.js";
import { validateModelPack } from "./model-pack-schema.js";
import { preview } from "./authoring.js";
import { providerArtifactFiles } from "./development.js";
import { auditSecrets } from "./planner.js";
import { identifier } from "./workflows.js";

const sentence = z.string().trim().min(1).max(160);
const lineage = z
  .object({
    source: sentence,
    mapping: sentence,
    execution: sentence,
    snapshotLabel: sentence,
    synthetic: z.boolean(),
    checks: z.array(z.string().min(1).max(180)).max(8),
    limitations: z.array(z.string().min(1).max(200)).max(8),
  })
  .strict();
export const presentationReviewSchema = z
  .object({
    name: identifier,
    release: identifier,
    provider: identifier,
    reportPack: z.string().min(1).max(500),
    receipt: z
      .string()
      .max(300)
      .regex(
        /^snapshots\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/){1,4}receipt\.json$/,
      ),
    command: z
      .enum(["report build", "report delivery"])
      .default("report build"),
    branding: z
      .object({
        company: sentence,
        primary: z.string().regex(/^#[a-fA-F0-9]{6}$/),
        accent: z.string().regex(/^#[a-fA-F0-9]{6}$/),
      })
      .strict(),
    lineage,
  })
  .strict();
export const presentationReceiptSchema = z
  .object({
    apiVersion: z.string().min(1).max(100),
    status: z.literal("Succeeded"),
    version: z.string().min(1).max(100),
    sourceSnapshotId: z.string().min(1).max(200),
    synthetic: z.boolean().optional(),
    files: z
      .array(
        z
          .object({
            table: z.string().min(1).max(100),
            path: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.parquet$/),
            rows: z.number().int().nonnegative(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            schema: z.array(z.unknown()).max(1000),
          })
          .passthrough(),
      )
      .min(1)
      .max(100),
  })
  .passthrough();
function snapshot(root: string, path: string, verify = false) {
  const reader = new Configuration(root, {});
  const receipt = presentationReceiptSchema.parse(
    JSON.parse(reader.text(path)),
  );
  auditSecrets(receipt, "receipt");
  check(
    new Set(receipt.files.map((f) => f.path)).size === receipt.files.length &&
      new Set(receipt.files.map((f) => f.table)).size === receipt.files.length,
    "RECEIPT",
    "Receipt repeats a table or file",
  );
  let bytes = 0;
  for (const item of receipt.files) {
    const local = relative(
      reader.root,
      resolve(dirname(reader.path(path)), item.path),
    );
    const file = reader.path(local);
    const size = statSync(file).size;
    bytes += size;
    check(
      bytes <= 64 * 1024 * 1024,
      "LIMIT",
      "Local presentation review supports at most 64 MiB per snapshot",
    );
    if (verify) {
      const actual = digest(readFileSync(file));
      check(
        actual === item.sha256,
        "RECEIPT",
        `Snapshot hash differs for ${item.path}`,
      );
      reader.files[local] = actual;
    }
  }
  return { reader, receipt, bytes };
}
/** Only conventional, project-confined snapshot and presentation locations are enumerated. */
function filesBelow(
  root: string,
  directory: string,
  filename: string,
  maxDepth: number,
) {
  const found: string[] = [];
  let entries = 0;
  const walk = (path: string, depth: number) => {
    const directory = fence(root, path);
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      check(
        ++entries <= 2000,
        "LIMIT",
        "Presentation inventory exceeds 2000 entries",
      );
      if (
        entry.isSymbolicLink() ||
        !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(entry.name)
      )
        continue;
      const name = path + "/" + entry.name;
      if (entry.isDirectory() && depth < maxDepth) walk(name, depth + 1);
      else if (entry.isFile() && entry.name === filename) found.push(name);
    }
  };
  walk(directory, 0);
  return found;
}
export function inspectPresentations(root: string, environment: string) {
  const providers = pluginCommands(root, environment).bindings.flatMap((p) => {
    const commands = p.commands
      .filter(
        (c) =>
          c.reportPack && ["report build", "report delivery"].includes(c.name),
      )
      .map((c) => c.name);
    if (!commands.length) return [];
    const manifest = packageYaml(resolvePackage(root, p.reference).file);
    return [
      {
        id: p.configuration,
        provider: p.provider,
        platform: manifest.platform,
        version: p.version,
        commands,
      },
    ];
  });
  const packs = browseProviders(root, "", "report-pack").map((p) => {
    const pack = reportPackSchema.parse(
      packageYaml(resolvePackage(root, p.reference).file),
    );
    let ready = true;
    try {
      validateModelPack(packageYaml(resolvePackage(root, pack.model).file));
    } catch {
      ready = false;
    }
    return {
      reference: p.reference,
      id: p.id,
      version: p.version,
      description: p.description,
      platform: pack.platform,
      model: pack.model,
      ready,
    };
  });
  const notices: string[] = [];
  const snapshotPaths = filesBelow(root, "snapshots", "receipt.json", 4);
  check(
    snapshotPaths.length <= 100,
    "LIMIT",
    "Inspect at most 100 presentation snapshots",
  );
  check(
    snapshotPaths.reduce(
      (size, path) => size + statSync(fence(root, path)).size,
      0,
    ) <=
      16 * 1024 * 1024,
    "LIMIT",
    "Snapshot receipt inventory exceeds 16 MiB",
  );
  const snapshots = snapshotPaths.flatMap((path) => {
    try {
      const { receipt, bytes } = snapshot(root, path);
      return [
        {
          path,
          snapshot: receipt.sourceSnapshotId,
          version: receipt.version,
          synthetic: receipt.synthetic ?? null,
          tables: receipt.files.length,
          bytes,
        },
      ];
    } catch {
      notices.push(
        `Snapshot unavailable: ${path}. Check the successful receipt and local Parquet files.`,
      );
      return [];
    }
  });
  const saved = filesBelow(
    root,
    `presentations/${environment}`,
    "definition.yaml",
    1,
  ).flatMap((path) => {
    try {
      const reader = new Configuration(root, {}),
        raw = reader.load(path);
      const value = presentationReviewSchema.parse(raw.definition);
      check(
        raw.apiVersion === "ingestron.presentation/v1" &&
          raw.environment === environment,
        "PRESENTATION",
        "Different presentation environment",
      );
      return [
        {
          path,
          ...value,
          output: `presentations/${environment}/${value.name}/releases/${value.release}`,
        },
      ];
    } catch (e) {
      if (!(e instanceof Problem && e.code === "PRESENTATION"))
        notices.push(
          `Presentation unavailable: ${path}. Review its definition.`,
        );
      return [];
    }
  });
  return {
    apiVersion: "ingestron.presentations/v1",
    providers,
    packs,
    snapshots,
    saved,
    notices,
    evidence:
      "Local inventory; snapshot bytes are verified during generation review. No source execution or deployment.",
  };
}
export function reviewPresentation(
  root: string,
  environment: string,
  input: z.infer<typeof presentationReviewSchema>,
) {
  input = presentationReviewSchema.parse(input);
  const catalogue = inspectPresentations(root, environment);
  const provider = catalogue.providers.find(
    (p) => p.id === input.provider && p.commands.includes(input.command),
  );
  const pack = catalogue.packs.find((p) => p.reference === input.reportPack);
  check(
    provider && pack?.ready && pack.platform === provider.platform,
    "PRESENTATION",
    "Select a compatible report pack, installed model and configured presentation provider",
  );
  check(
    catalogue.snapshots.some((s) => s.path === input.receipt),
    "RECEIPT",
    "Choose an available project snapshot",
  );
  const { reader, receipt } = snapshot(root, input.receipt, true);
  check(
    receipt.synthetic !== true || input.lineage.synthetic,
    "LINEAGE",
    "A synthetic receipt must keep synthetic lineage",
  );
  const output = `presentations/${environment}/${input.name}/releases/${input.release}`;
  check(
    !existsSync(fence(root, output)),
    "OWNER",
    "Choose a new release name; existing presentation assets are preserved",
  );
  const generated = runProviderCommand(root, environment, {
    configuration: input.provider,
    command: input.command,
    input: {
      reportPack: input.reportPack,
      receipt,
      location: dirname(reader.path(input.receipt)),
      lineage: input.lineage,
      branding: input.branding,
    },
  });
  const files = providerArtifactFiles(root, generated, output);
  files[`presentations/${environment}/${input.name}/definition.yaml`] =
    stringify({
      apiVersion: "ingestron.presentation/v1",
      environment,
      definition: input,
    });
  files[output + "/ingestron-provenance.json"] =
    JSON.stringify(
      {
        apiVersion: "ingestron.presentation-provenance/v1",
        environment,
        definition: input,
        inputDigest: generated.inputDigest,
        providerCommit: generated.commit,
        reportLock: generated.reportLock,
        snapshotDigests: reader.files,
        verification:
          "Snapshot hashes match receipt; report schema is validated by the selected provider. No runtime or cloud execution.",
      },
      null,
      2,
    ) + "\n";
  // Bind every installed package byte used by generation to the reviewed proposal.
  const binding = pluginCommands(root, environment).bindings.find(
    (p) => p.configuration === input.provider,
  )!;
  for (const reference of [binding.reference, input.reportPack, pack.model]) {
    const source = resolvePackage(root, reference);
    for (const [name, sha256] of Object.entries(source.entry.files))
      reader.files[relative(reader.root, resolve(source.root, name))] = sha256;
  }
  check(
    Object.keys(reader.files).length <= 1001,
    "LIMIT",
    "Presentation inputs exceed the review limit",
  );
  return {
    proposal: preview(root, files, reader.files),
    output,
    snapshot: receipt.sourceSnapshotId,
    files: Object.keys(files).length,
    evidence:
      "Offline generated assets with verified snapshot hashes. Review and save before opening in the target application.",
  };
}
