/** Portable metadata is reusable offline; source access remains an explicit operation. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { parseDocument, stringify } from "yaml";
import type { z } from "zod";
import { Configuration } from "./config.js";
import { projectSchema } from "./schema.js";
import { projectPackages } from "./project-packages.js";
import { fence } from "./packages.js";
import { canonical, check, digest } from "./errors.js";
import { preview, apply } from "./authoring.js";
import { checkIngestionContract } from "./ingestion-definition.js";
import { discoverySnapshotSchema } from "./ingestion-definition-schema.js";
import {
  discoveryBundleSchema,
  discoveryReadSchema,
  discoveryReviewSchema,
  discoverySaveSchema,
  discoveryApplySchema,
} from "./portable-discovery-schema.js";
import {
  sourceAccessDefinition,
  sourceAccessResponseSchema,
} from "./source-access.js";
import type { Context } from "./operations.js";
export * from "./portable-discovery-schema.js";
type Snapshot = z.infer<typeof discoverySnapshotSchema>;
const limit = 2 * 1024 * 1024;
function parse(text: string) {
  check(
    Buffer.byteLength(text) <= limit,
    "LIMIT",
    "Discovery file exceeds 2 MiB",
  );
  const doc = parseDocument(text, { uniqueKeys: true });
  check(
    !doc.errors.length,
    "DISCOVERY",
    "Invalid JSON/YAML discovery file or duplicate keys",
  );
  return doc.toJS({ maxAliasCount: 0 });
}
function read(root: string, path: string) {
  const file = fence(root, path);
  check(statSync(file).size <= limit, "LIMIT", "Discovery file exceeds 2 MiB");
  return readFileSync(file, "utf8");
}
function state(context: Context, connection: string) {
  const reader = new Configuration(context.root);
  const project = reader.parse(projectSchema, reader.load());
  const environment = context.environment ?? "dev";
  check(
    project.environments[environment],
    "ENVIRONMENT",
    "Unknown discovery environment",
  );
  const source = project.connections[connection];
  check(
    source?.package,
    "CONNECTION",
    "Choose a source connection with an exact connector package",
  );
  const pkg = projectPackages(project)[source.package!];
  check(pkg, "PACKAGE", "Unknown source connector package");
  const connector = { id: pkg.source, version: pkg.version };
  // All configuration and lock bytes bind an import review, without needing a runtime or network.
  const lock = existsSync(fence(context.root, "packages.lock.yaml"))
    ? digest(readFileSync(fence(context.root, "packages.lock.yaml")))
    : null;
  const binding = digest(
    canonical({ files: reader.files, connection, environment, lock }),
  );
  const folder = `discovery/${environment}/${connection}`;
  const names = existsSync(fence(context.root, folder))
    ? readdirSync(fence(context.root, folder))
        .filter((n) => /^[A-Za-z_][A-Za-z0-9_-]{0,79}\.yaml$/.test(n))
        .sort()
    : [];
  check(
    names.length <= 1000,
    "LIMIT",
    "Archive older discovery snapshots before continuing",
  );
  let bytes = 0;
  const entries = names.map((n) => {
    const path = `${folder}/${n}`;
    bytes += statSync(fence(context.root, path)).size;
    check(
      bytes <= 16 * 1024 * 1024,
      "LIMIT",
      "Discovery inventory exceeds 16 MiB",
    );
    const raw = read(context.root, path),
      stored = parse(raw);
    check(
      stored?.apiVersion === "ingestron.saved-discovery/v1" &&
        /^[a-f0-9]{64}$/.test(stored.binding),
      "DISCOVERY",
      "Invalid saved discovery envelope",
    );
    const snapshot = discoverySnapshotSchema.parse(stored.snapshot);
    check(
      snapshot.id + ".yaml" === n &&
        snapshot.source === connection &&
        snapshot.environment === environment,
      "IDENTITY",
      "Saved snapshot identity does not match its location",
    );
    checkIngestionContract(snapshot);
    return {
      snapshot,
      path,
      sha256: digest(raw),
      current: stored.binding === binding,
    };
  });
  return {
    project: project.id,
    environment,
    connection,
    connector,
    binding,
    folder,
    entries,
    revision: digest(
      canonical({ binding, files: entries.map((e) => [e.path, e.sha256]) }),
    ),
  };
}
export function readDiscovery(
  context: Context,
  input: z.infer<typeof discoveryReadSchema>,
) {
  const s = state(context, input.connection);
  const selected = input.snapshot
    ? s.entries.find((e) => e.snapshot.id === input.snapshot)
    : undefined;
  check(
    !input.snapshot || selected,
    "NOT_FOUND",
    "Saved discovery snapshot not found",
  );
  return {
    apiVersion: "ingestron.discovery-inventory/v1",
    project: s.project,
    environment: s.environment,
    connection: s.connection,
    connector: s.connector,
    revision: s.revision,
    snapshots: s.entries.map((e) => ({
      id: e.snapshot.id,
      collectedAt: e.snapshot.collectedAt,
      objects: e.snapshot.objects.length,
      coverage: e.snapshot.coverage,
      provenance: e.snapshot.provenance,
      current: e.current,
      sha256: e.sha256,
    })),
    ...(selected ? { snapshot: selected.snapshot } : {}),
  };
}
function validateReferences(snapshot: Snapshot) {
  checkIngestionContract(snapshot);
  for (const o of snapshot.objects) {
    const paths = new Set(o.fields.map((f) => f.path));
    for (const refs of [o.keys, o.partitions, o.cursors])
      if (refs)
        check(
          new Set(refs).size === refs.length && refs.every((f) => paths.has(f)),
          "REFERENCE",
          "Discovery hints refer to duplicate or unknown fields",
        );
  }
}
function reviewSave(
  context: Context,
  input: z.infer<typeof discoverySaveSchema>,
) {
  const s = state(context, input.connection),
    snapshot = input.snapshot;
  check(
    s.revision === input.revision,
    "STALE",
    "Source or saved discovery changed; reload and review again",
  );
  check(
    snapshot.source === input.connection &&
      (!snapshot.environment || snapshot.environment === s.environment),
    "IDENTITY",
    "Discovery belongs to another source or environment",
  );
  check(
    snapshot.connector.id === s.connector.id &&
      snapshot.connector.version === s.connector.version,
    "CONNECTOR",
    "Discovery connector identity or version differs from this source",
  );
  check(
    !s.entries.some((e) => e.snapshot.id === snapshot.id),
    "DUPLICATE",
    "Snapshot ID already exists; preserve it and choose a new discovery ID",
  );
  validateReferences(snapshot);
  const normalised = discoverySnapshotSchema.parse({
    ...snapshot,
    environment: s.environment,
  });
  const path = `${s.folder}/${snapshot.id}.yaml`;
  const contents = stringify({
    apiVersion: "ingestron.saved-discovery/v1",
    binding: s.binding,
    snapshot: normalised,
  });
  check(
    Buffer.byteLength(contents) <= limit,
    "LIMIT",
    "Saved discovery exceeds 2 MiB; split the discovery scope",
  );
  const proposal = preview(context.root, { [path]: contents });
  return { input: { ...input, snapshot: normalised }, proposal };
}
export function reviewDiscovery(
  context: Context,
  input: z.infer<typeof discoveryReviewSchema>,
) {
  let snapshot: Snapshot,
    samples: z.infer<typeof discoveryBundleSchema>["samples"];
  if (input.document) {
    const raw = parse(input.document);
    if (raw?.apiVersion === "ingestron.discovery-bundle/v1") {
      const bundle = discoveryBundleSchema.parse(raw);
      snapshot = bundle.snapshot;
      samples = bundle.samples;
      check(
        !samples?.length || input.allowSamples,
        "PERMISSION",
        "This file includes samples. Explicitly allow sample preview or upload metadata only",
      );
      for (const sample of samples ?? []) {
        const object = snapshot.objects.find((o) => o.id === sample.object);
        check(
          object &&
            new Set(sample.columns).size === sample.columns.length &&
            sample.columns.every((c) =>
              object.fields.some((f) => f.path === c),
            ) &&
            sample.rows.every((r) => r.length === sample.columns.length),
          "SAMPLE",
          "Sample columns, rows or object do not match the discovery schema",
        );
      }
      check(
        new Set(samples?.map((s) => s.object)).size === (samples?.length ?? 0),
        "DUPLICATE",
        "Duplicate sample object",
      );
    } else snapshot = discoverySnapshotSchema.parse(raw);
  } else {
    const s = state(context, input.connection);
    const def = sourceAccessDefinition(context, {
      connection: input.connection,
    });
    check(
      !def.unsupported,
      "CAPABILITY",
      "Live metadata is unavailable; upload a discovery file",
    );
    const objects = new Map<string, Snapshot["objects"][number]>();
    let at = "";
    for (const id of input.receipts!) {
      const receipt = parse(
        read(context.root, `.ingestron/source-access/${id}.json`),
      );
      check(
        receipt.apiVersion === "ingestron.source-access-receipt/v1" &&
          receipt.id === id &&
          receipt.connection === input.connection &&
          receipt.environment === s.environment &&
          receipt.fingerprint === def.fingerprint &&
          receipt.action === "metadata" &&
          receipt.status === "succeeded",
        "STALE",
        "Metadata receipt no longer matches this source; discover again or upload metadata",
      );
      const result = sourceAccessResponseSchema.parse(receipt.result);
      check(
        result.action === "metadata" && result.status === "succeeded",
        "DISCOVERY",
        "Choose successful metadata receipts",
      );
      at = at > receipt.startedAt ? at : receipt.startedAt;
      for (const t of result.tables) {
        const object: Snapshot["objects"][number] = {
          id: t.id,
          name: t.name,
          kind:
            t.kind === "file"
              ? "file-group"
              : t.kind === "object"
                ? "unknown"
                : t.kind,
          locator: t.source as any,
          metadataComplete: t.sampling ? false : undefined,
          inference: t.sampling,
          fields: (t.columns ?? []).map((c) => ({
            path: c.name,
            logicalType: c.supported === false ? "unknown" : c.type,
            nativeType: c.sourceType,
            precision: c.precision,
            scale: c.scale,
            nullable: c.nullable,
            origin: t.sampling ? "inferred" : "declared",
          })),
          keys: (t.columns ?? []).filter((c) => c.key).map((c) => c.name),
        };
        check(
          !objects.has(t.id) ||
            canonical(objects.get(t.id)) === canonical(object),
          "CONFLICT",
          "Selected receipts disagree about an object; choose one current receipt",
        );
        objects.set(t.id, object);
      }
    }
    snapshot = discoverySnapshotSchema.parse({
      apiVersion: "ingestron.discovery-snapshot/v1",
      id: `live_${digest(canonical(input.receipts)).slice(0, 24)}`,
      source: input.connection,
      environment: s.environment,
      connector: s.connector,
      collectedAt: at,
      coverage: {
        scope: "Selected metadata receipts",
        complete: false,
        reason: "Selected objects only; absence does not imply deletion",
      },
      provenance: {
        method: "mixed",
        producer: "ingestron.source-access/v1",
        notes:
          "Field origins distinguish declared and bounded inferred metadata",
      },
      objects: [...objects.values()],
    });
  }
  const reviewed = reviewSave(context, {
    connection: input.connection,
    revision: input.revision,
    snapshot,
  });
  return {
    apiVersion: "ingestron.discovery-review/v1",
    ...reviewed,
    ...(samples?.length ? { samples } : {}),
  };
}
export function applyDiscovery(
  context: Context,
  input: z.infer<typeof discoveryApplySchema>,
) {
  const reviewed = reviewSave(context, input.input);
  check(
    reviewed.proposal.id === input.proposalId,
    "STALE",
    "Discovery review changed; review again",
  );
  apply(context.root, reviewed.proposal);
  return readDiscovery(context, {
    connection: input.input.connection,
    snapshot: input.input.snapshot.id,
  });
}
