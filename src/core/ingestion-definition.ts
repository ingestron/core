import { portableConnectorInputs } from "./connector-impact.js";
import { validatePortableQuality, protectQuality } from "./portable-quality.js";
/** Portable authoring only. Target bindings, generation and execution have separate owners. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";
import { preview, apply, type Proposal } from "./authoring.js";
import { Configuration } from "./config.js";
import { projectSchema } from "./schema.js";
import { auditSecrets } from "./planner.js";
import { fence } from "./packages.js";
import { canonical, check, digest } from "./errors.js";

export * from "./ingestion-definition-schema.js";
import {
  ingestionDefinitionSchema,
  ingestionHandoffSchema,
  ingestionContractSchema,
  ingestionReadSchema,
  ingestionReviewSchema,
  ingestionApplySchema,
  ingestionEditorReadSchema,
  ingestionAdoptSchema,
  ingestionDraftWriteSchema,
  ingestionDraftSchema,
  ingestionDiscoveryUpdateSchema,
} from "./ingestion-definition-schema.js";
function unique(values: string[], label: string) {
  check(
    new Set(values).size === values.length,
    "DUPLICATE",
    `Duplicate ${label}`,
  );
}
export function checkIngestionContract(
  value: z.infer<typeof ingestionContractSchema>["value"],
  allowFindings = false,
) {
  check(
    Buffer.byteLength(JSON.stringify(value)) <= 8 * 1024 * 1024,
    "LIMIT",
    "Portable authoring document exceeds 8 MiB",
  );
  auditSecrets(value, "definition");
  const doc =
    value.apiVersion === "ingestron.ingestion-draft/v1"
      ? value.definition
      : value;
  if ("objects" in doc) {
    unique(
      doc.objects.map((o) => o.id),
      "object identity",
    );
    for (const object of doc.objects) {
      unique(
        object.fields.map((f) => f.path),
        "field path",
      );
      if ("mapping" in object) {
        unique(
          object.mapping.map((m) => m.source),
          "mapped source field",
        );
        unique(
          [
            ...object.mapping.map((m) => m.output),
            ...object.metadata.map((m) => m.name),
          ],
          "output column",
        );
        const available = new Set(object.fields.map((f) => f.path));
        check(
          allowFindings || object.mapping.every((m) => available.has(m.source)),
          "REFERENCE",
          "Mapping refers to an unknown field",
        );
        check(
          allowFindings ||
            !object.governance ||
            object.governance.masking.every((m) => available.has(m.field)),
          "REFERENCE",
          "Masking refers to an unknown field",
        );
        unique(
          (object.governance?.masking ?? []).map((m) => m.field),
          "masked field",
        );
        check(
          (object.governance?.masking ?? []).every(
            (m) => !m.required || m.enabled !== false,
          ),
          "REFERENCE",
          "Required masking cannot be disabled",
        );
        check(
          object.metadata.every(
            (m) =>
              m.logicalType ===
              (m.value.kind === "observed-at" ? "timestamp" : "string"),
          ),
          "REFERENCE",
          "Metadata type does not match its value",
        );
        check(
          object.metadata.every(
            (m) =>
              m.value.kind !== "source-path" || object.kind === "file-group",
          ),
          "CAPABILITY",
          "Source path metadata requires a file group",
        );
      }
    }
  }
  const quality = "status" in doc ? validatePortableQuality(doc) : undefined;
  check(
    allowFindings || !quality || quality.valid,
    "QUALITY",
    quality?.issues
      .map((i) => `${i.object}${i.rule ? ` / ${i.rule}` : ""}: ${i.message}`)
      .slice(0, 20)
      .join("; ") ?? "Invalid quality definition",
  );
  if ("status" in doc && doc.status === "reviewed")
    check(
      !definitionFindings(doc).length,
      "QUALITY",
      "Resolve portable findings before marking reviewed",
    );
  return {
    apiVersion: "ingestron.ingestion-contract-check/v1",
    valid: true,
    scope: "structure-and-references",
    qualitySemantics: quality
      ? "portable-conditions-checked"
      : "not-applicable",
    qualityWarnings: quality?.warnings ?? [],
    platformSupport: "not-checked",
  };
}
function state(root: string) {
  const reader = new Configuration(root);
  const project = reader.parse(projectSchema, reader.load());
  const directory = fence(root, "ingestions");
  const names = existsSync(directory)
    ? readdirSync(directory)
        .filter((n) => /^[A-Za-z_][A-Za-z0-9_-]{0,79}\.yaml$/.test(n))
        .sort()
    : [];
  check(names.length <= 1000, "LIMIT", "Too many ingestion definitions");
  const files: Record<string, string> = {};
  let totalBytes = 0;
  const definitions = names.map((name) => {
    const path = `ingestions/${name}`,
      file = fence(root, path);
    check(
      statSync(file).size <= 8 * 1024 * 1024,
      "LIMIT",
      "Ingestion definition exceeds 8 MiB",
    );
    totalBytes += statSync(file).size;
    check(
      totalBytes <= 16 * 1024 * 1024,
      "LIMIT",
      "Ingestion inventory exceeds 16 MiB",
    );
    const raw = readFileSync(file, "utf8");
    const yaml = parseDocument(raw, { uniqueKeys: true });
    check(!yaml.errors.length, "YAML", "Invalid ingestion definition", path);
    const definition = ingestionDefinitionSchema.parse(
      yaml.toJS({ maxAliasCount: 0 }),
    );
    check(
      definition.id + ".yaml" === name,
      "IDENTITY",
      "Definition identity does not match its file",
      path,
    );
    checkIngestionContract(definition, definition.status === "draft");
    files[path] = digest(raw);
    return { definition, path, sha256: files[path] };
  });
  return {
    project: project.id,
    definitions,
    revision: digest(canonical({ project: reader.files, definitions: files })),
  };
}
export function readIngestionDefinitions(
  root: string,
  input: z.infer<typeof ingestionReadSchema>,
) {
  const s = state(root);
  check(
    !input.id || s.definitions.some((d) => d.definition.id === input.id),
    "NOT_FOUND",
    "Ingestion definition not found",
  );
  return {
    apiVersion: "ingestron.ingestion-inventory/v1",
    ...s,
    definitions: input.id
      ? s.definitions.filter((d) => d.definition.id === input.id)
      : s.definitions,
  };
}
export function reviewIngestionDefinition(
  root: string,
  input: z.infer<typeof ingestionReviewSchema>,
  environment = "dev",
) {
  const s = state(root);
  check(
    s.revision === input.revision,
    "STALE",
    "Definitions changed; reload and review again",
  );
  check(
    !input.create ||
      !s.definitions.some((d) => d.definition.id === input.definition.id),
    "DUPLICATE",
    "An ingestion with this identity already exists",
  );
  const previous = s.definitions.find(
    (d) => d.definition.id === input.definition.id,
  )?.definition;
  const original = input.duplicateFrom
    ? s.definitions.find((d) => d.definition.id === input.duplicateFrom)
        ?.definition
    : undefined;
  if (input.duplicateFrom) {
    check(
      input.create && original && input.definition.id !== original.id,
      "REFERENCE",
      "Choose a saved definition and a new identity to duplicate",
    );
    check(
      canonical(input.definition) ===
        canonical({
          ...original,
          id: input.definition.id,
          name: input.definition.name,
          status: "draft",
          archived: false,
        }),
      "REFERENCE",
      "A duplicate must preserve all saved settings and evidence",
    );
  }
  const lifecycle =
    !!previous && !!previous.archived !== !!input.definition.archived;
  check(
    !input.definition.archived || !!previous,
    "REFERENCE",
    "Create an active definition before archiving",
  );
  if (lifecycle || previous?.archived) {
    check(
      canonical({ ...previous, archived: !!input.definition.archived }) ===
        canonical({
          ...input.definition,
          archived: !!input.definition.archived,
        }),
      "REFERENCE",
      "Restore an archived definition before editing; archive changes only its availability",
    );
  }
  const dependencies = lifecycle
    ? portableConnectorInputs(root, ["ingestion-drafts", "ingestion-handoffs"])
    : undefined;
  if (lifecycle && input.definition.archived) {
    const consumers = dependencies!.documents.filter(({ path, value }) => {
      if (path.startsWith("ingestion-handoffs/")) {
        const handoff = ingestionHandoffSchema.parse(value);
        check(
          handoff.project === s.project,
          "REFERENCE",
          "Handoff belongs to another project",
          path,
        );
        return handoff.definition.id === input.definition.id;
      }
      return (
        ingestionDraftSchema.parse(value).definition.id === input.definition.id
      );
    });
    check(
      !consumers.length,
      "DEPENDENCY",
      "Resolve saved working copies and handoff references before archiving",
      consumers.map((c) => c.path).join(", "),
    );
  }
  protectQuality(
    s.definitions.find((d) => d.definition.id === input.definition.id)
      ?.definition,
    input.definition,
  );
  const findings = definitionFindings(input.definition);
  check(
    validatePortableQuality(input.definition).ruleSetsValid,
    "QUALITY",
    "Reusable rule-set versions must be valid before saving; saved versions are immutable",
  );
  checkIngestionContract(
    input.definition,
    input.saveWithFindings === true && input.definition.status === "draft",
  );
  check(
    input.definition.status !== "reviewed" || !findings.length,
    "QUALITY",
    "Resolve findings before saving a reviewed definition",
  );
  const validation = {
    valid: findings.length === 0,
    findings,
    scope: "portable-static",
    platformSupport: "not-checked",
    dataEvaluation: "not-performed",
  };
  const evidence =
    lifecycle || previous?.archived
      ? (dependencies?.files ?? {})
      : validateBinding(
          { root, environment },
          input.definition,
          input.adoptDiscovery,
          original,
        );
  const replacements: Record<string, string> = {};
  if (input.workingExpected !== undefined) {
    const working = draftState({ root, environment }, input.definition.id);
    check(
      working.expected === input.workingExpected,
      "STALE",
      "Working copy changed in another editor",
    );
    check(
      !working.draft || working.draft.baseRevision === s.revision,
      "STALE",
      "Discard the conflicting working copy before saving the current definition",
    );
    if (working.draft) replacements[working.path] = stringify(null);
  }
  const content = stringify(input.definition);
  check(
    Buffer.byteLength(content) <= 8 * 1024 * 1024,
    "LIMIT",
    "Saved definition exceeds 8 MiB",
  );
  const proposal = preview(
    root,
    {
      ...replacements,
      [`ingestions/${input.definition.id}.yaml`]: content,
    },
    evidence,
  );
  return { input, proposal, validation };
}
export function applyIngestionDefinition(
  root: string,
  input: z.infer<typeof ingestionApplySchema>,
  environment = "dev",
) {
  const reviewed = reviewIngestionDefinition(root, input.input, environment);
  check(
    reviewed.proposal.id === input.proposalId,
    "STALE",
    "Definition proposal changed; review again",
  );
  apply(root, reviewed.proposal as Proposal);
  return readIngestionDefinitions(root, { id: input.input.definition.id });
}

import { readDiscovery } from "./portable-discovery.js";
import type { Context } from "./operations.js";
import type { IngestionDefinition } from "./ingestion-definition-schema.js";
function validateBinding(
  context: Context,
  definition: IngestionDefinition,
  adopt?: { id: string; sha256: string },
  copiedFrom?: IngestionDefinition,
) {
  if (!definition.source && !definition.discovery && !definition.objects.length)
    return {};
  check(
    definition.source && definition.discovery,
    "REFERENCE",
    "Choose saved discovery for this definition",
  );
  const inventory = readDiscovery(context, {
    connection: definition.source!.id,
    snapshot: definition.discovery!.id,
  });
  const entry = inventory.snapshots.find(
    (s) => s.id === definition.discovery!.id,
  )!;
  check(
    entry.sha256 === definition.discovery!.sha256,
    "STALE",
    "Saved discovery changed",
  );
  check(
    canonical(inventory.snapshot!.connector) ===
      canonical(definition.source!.connector),
    "REFERENCE",
    "Connector identity differs from saved discovery",
  );
  const previous =
    copiedFrom ??
    state(context.root).definitions.find(
      (d) => d.definition.id === definition.id,
    )?.definition;
  const changed =
    previous?.discovery &&
    canonical(previous.discovery) !== canonical(definition.discovery);
  check(
    entry.current ||
      (previous?.discovery?.sha256 === entry.sha256 &&
        previous.source?.id === definition.source!.id),
    "STALE",
    "Refresh source discovery before adopting this snapshot",
  );
  if (previous?.discovery) {
    check(
      canonical(previous.source) === canonical(definition.source) ||
        (!!adopt &&
          changed &&
          previous.source?.id === definition.source!.id &&
          previous.source?.connector.id === definition.source!.connector.id &&
          canonical(definition.source!.connector) ===
            canonical(inventory.connector)),
      "REFERENCE",
      "Connector changes require the registered version and explicit discovery adoption",
    );
    check(
      !changed ||
        (adopt && canonical(adopt) === canonical(definition.discovery)),
      "REFERENCE",
      "Changing pinned discovery needs an explicit adoption review",
    );
  }
  for (const before of previous?.objects ?? []) {
    const after = definition.objects.find((o) => o.id === before.id);
    if (after)
      for (const mask of before.governance?.masking ?? [])
        if (mask.required)
          check(
            after.governance?.masking.some(
              (m) =>
                m.field === mask.field &&
                m.policy === mask.policy &&
                m.required &&
                m.enabled !== false,
            ),
            "REFERENCE",
            "Required masking cannot be removed or weakened",
          );
  }
  const evidence: Record<string, string> = {};
  const snapshots = new Map([[definition.discovery!.id, inventory]]);
  for (const o of definition.objects) {
    const pin = o.discovery ?? definition.discovery!;
    if (!snapshots.has(pin.id))
      snapshots.set(
        pin.id,
        readDiscovery(context, {
          connection: definition.source!.id,
          snapshot: pin.id,
        }),
      );
    const saved = snapshots.get(pin.id)!;
    const entry = saved.snapshots.find((s) => s.id === pin.id)!;
    check(entry.sha256 === pin.sha256, "STALE", "Retained discovery changed");
    check(
      saved.snapshot!.connector.id === definition.source!.connector.id,
      "REFERENCE",
      "Retained connector source differs",
    );
    const observed = saved.snapshot!.objects.find((item) => item.id === o.id);
    check(
      observed &&
        observed.kind === o.kind &&
        canonical(observed.fields) === canonical(o.fields),
      "REFERENCE",
      "Definition fields must match their saved discovery",
    );
    if (o.discovery && canonical(pin) !== canonical(definition.discovery)) {
      const old = previous?.objects.find((item) => item.id === o.id);
      check(
        old &&
          canonical(pin) === canonical(old.discovery ?? previous!.discovery),
        "REFERENCE",
        "Retained evidence must come from the existing object",
      );
    }
    evidence[
      `discovery/${context.environment ?? "dev"}/${definition.source!.id}/${pin.id}.yaml`
    ] = pin.sha256;
  }
  evidence[
    `discovery/${context.environment ?? "dev"}/${definition.source!.id}/${definition.discovery!.id}.yaml`
  ] = entry.sha256;
  return evidence;
}
function draftState(context: Context, id: string) {
  const reader = new Configuration(context.root);
  const project = reader.parse(projectSchema, reader.load());
  check(
    Object.hasOwn(project.environments, context.environment ?? "dev"),
    "ENVIRONMENT",
    "Unknown working-copy environment",
  );
  const path = `ingestion-drafts/${context.environment ?? "dev"}/${id}.yaml`;
  const file = fence(context.root, path);
  if (!existsSync(file)) return { path, expected: null, draft: null };
  check(
    statSync(file).size <= 8 * 1024 * 1024,
    "LIMIT",
    "Working copy exceeds 8 MiB",
  );
  const raw = readFileSync(file, "utf8");
  const yaml = parseDocument(raw, { uniqueKeys: true });
  check(!yaml.errors.length, "YAML", "Invalid working copy");
  const draft = ingestionDraftSchema
    .nullable()
    .parse(yaml.toJS({ maxAliasCount: 0 }));
  check(
    !draft ||
      (draft.project === state(context.root).project &&
        draft.definition.id === id),
    "IDENTITY",
    "Working copy identity differs",
  );
  return { path, expected: digest(raw), draft };
}
export function readIngestionEditor(
  context: Context,
  input: z.infer<typeof ingestionEditorReadSchema>,
) {
  const s = state(context.root);
  const reader = new Configuration(context.root);
  const project = reader.parse(projectSchema, reader.load());
  check(
    project.environments[context.environment ?? "dev"],
    "ENVIRONMENT",
    "Unknown environment",
  );
  const definition = input.id
    ? s.definitions.find((d) => d.definition.id === input.id)?.definition
    : undefined;
  const working = input.id ? draftState(context, input.id) : undefined;
  return {
    apiVersion: "ingestron.ingestion-editor/v1",
    project: s.project,
    revision: s.revision,
    sources: Object.entries(project.connections)
      .filter(([, c]) => c.package)
      .map(([id]) => id),
    ...(definition ? { definition } : {}),
    ...(working
      ? {
          working,
          conflict:
            !!working.draft && working.draft.baseRevision !== s.revision,
        }
      : {}),
    ...(input.connection
      ? {
          discovery: readDiscovery(context, {
            connection: input.connection,
            snapshot: input.snapshot,
          }),
        }
      : {}),
  };
}
export function adoptIngestionDiscovery(
  context: Context,
  input: z.infer<typeof ingestionAdoptSchema>,
) {
  unique(input.objects, "selected object");
  const discovery = readDiscovery(context, {
    connection: input.connection,
    snapshot: input.snapshot,
  });
  const objects = new Map(discovery.snapshot!.objects.map((o) => [o.id, o]));
  const previous = state(context.root).definitions.find(
    (d) => d.definition.id === input.id,
  )?.definition;
  const definition = ingestionDefinitionSchema.parse({
    apiVersion: "ingestron.ingestion-definition/v1",
    id: input.id,
    name: input.name,
    description: input.description,
    status: "draft",
    source: { id: input.connection, connector: discovery.snapshot!.connector },
    discovery: { id: input.snapshot, sha256: input.sha256 },
    objects: input.objects.map((id) => {
      const o = objects.get(id);
      check(o, "REFERENCE", "Unknown selected object");
      return (
        previous?.objects.find((old) => old.id === id) ?? {
          id,
          kind: o!.kind,
          fields: o!.fields,
          mapping: defaultMapping(o!.fields),
          metadata: [],
          quality: [],
        }
      );
    }),
  });
  validateBinding(context, definition);
  return { definition };
}
export function writeIngestionDraft(
  context: Context,
  input: z.infer<typeof ingestionDraftWriteSchema>,
) {
  const s = state(context.root),
    before = draftState(context, input.id);
  check(
    before.expected === input.expected,
    "STALE",
    "Working copy changed in another editor",
  );
  if (input.draft) {
    check(
      !s.definitions.find((d) => d.definition.id === input.id)?.definition
        .archived && !input.draft.definition.archived,
      "REFERENCE",
      "Restore the definition before saving a working copy",
    );
    check(
      input.draft.project === s.project &&
        input.draft.definition.id === input.id,
      "IDENTITY",
      "Working copy identity differs",
    );
    check(
      input.draft.baseRevision === s.revision,
      "STALE",
      "Definition changed; preserve this working copy and reload",
    );
    check(
      Buffer.byteLength(JSON.stringify(input.draft)) <= 8 * 1024 * 1024,
      "LIMIT",
      "Working copy exceeds 8 MiB",
    );
    auditSecrets(input.draft, "working-copy");
  }
  const content = stringify(input.draft);
  check(
    Buffer.byteLength(content) <= 8 * 1024 * 1024,
    "LIMIT",
    "Saved working copy exceeds 8 MiB",
  );
  apply(context.root, preview(context.root, { [before.path]: content }));
  return draftState(context, input.id);
}

function defaultMapping(fields: { path: string }[]) {
  const used = new Set<string>();
  return fields.map((f) => {
    let base = f.path.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
    if (!/^[A-Za-z_]/.test(base)) base = "field_" + base;
    if (!base) base = "field";
    let output = base,
      n = 2;
    while (used.has(output)) output = `${base}_${n++}`;
    used.add(output);
    return { source: f.path, output };
  });
}

/** Findings are authoring evidence, not a data-quality execution result. */
export function definitionFindings(definition: IngestionDefinition) {
  const findings: { object: string; section: string; message: string }[] = [];
  if (!definition.source || !definition.discovery || !definition.objects.length)
    findings.push({
      object: "",
      section: "schema",
      message:
        "Choose saved discovery and at least one object before marking this definition reviewed.",
    });
  for (const o of definition.objects) {
    const paths = new Set(o.fields.map((f) => f.path));
    for (const m of o.mapping)
      if (!paths.has(m.source))
        findings.push({
          object: o.id,
          section: "mapping",
          message: `Mapped source field ${m.source} is no longer observed. Its mapping has been retained; resolve it explicitly.`,
        });
    for (const m of o.governance?.masking ?? [])
      if (!paths.has(m.field))
        findings.push({
          object: o.id,
          section: "governance",
          message: `Masked field ${m.field} is no longer observed. Its policy has been retained.`,
        });
  }
  const quality = validatePortableQuality(definition);
  findings.push(
    ...quality.issues.map((i) => ({
      object: i.object,
      section: "quality",
      message: i.message,
    })),
  );
  return findings;
}
/** Pure proposal: no saved definition, snapshot or working copy is changed. */
export function previewIngestionDiscoveryUpdate(
  context: Context,
  input: z.infer<typeof ingestionDiscoveryUpdateSchema>,
) {
  const s = state(context.root);
  check(
    s.revision === input.revision,
    "STALE",
    "Definitions changed; reload before reviewing discovery",
  );
  const before = input.definition;
  check(
    before.source && before.discovery,
    "REFERENCE",
    "Choose an existing source and discovery first",
  );
  validateBinding(context, before);
  const next = readDiscovery(context, {
    connection: before.source!.id,
    snapshot: input.snapshot,
  });
  const entry = next.snapshots.find((s) => s.id === input.snapshot)!;
  check(
    entry.sha256 === input.sha256 && entry.current,
    "STALE",
    "Discovery changed or no longer matches the source",
  );
  check(
    next.snapshot!.connector.id === before.source!.connector.id &&
      canonical(next.snapshot!.connector) === canonical(next.connector),
    "REFERENCE",
    "Upgrade the registered connector before adopting its discovery",
  );
  check(
    canonical(before.discovery) !==
      canonical({ id: input.snapshot, sha256: input.sha256 }),
    "REFERENCE",
    "Choose a different snapshot",
  );
  const available = new Map(next.snapshot!.objects.map((o) => [o.id, o]));
  const changes: {
    object: string;
    status: string;
    added: string[];
    removed: string[];
    changed: string[];
  }[] = [];
  const definition: IngestionDefinition = {
    ...before,
    status: "draft",
    source: { id: before.source!.id, connector: next.snapshot!.connector },
    discovery: { id: input.snapshot, sha256: input.sha256 },
    objects: before.objects.map((old) => {
      const observed = available.get(old.id);
      const complete =
        observed &&
        (observed.metadataComplete === true ||
          (observed.metadataComplete !== false &&
            next.snapshot!.coverage.complete));
      if (!observed || !complete || observed.kind !== old.kind) {
        changes.push({
          object: old.id,
          status: !observed
            ? "Not observed — retained"
            : observed.kind !== old.kind
              ? "Kind changed — retained"
              : "Incomplete metadata — retained",
          added: [],
          removed: [],
          changed: [],
        });
        return { ...old, discovery: old.discovery ?? before.discovery };
      }
      const oldFields = new Map(old.fields.map((f) => [f.path, f]));
      const fields = new Map(observed.fields.map((f) => [f.path, f]));
      const added = [...fields.keys()].filter((f) => !oldFields.has(f));
      const removed = [...oldFields.keys()].filter((f) => !fields.has(f));
      const changed = [...fields.keys()].filter(
        (f) =>
          oldFields.has(f) &&
          canonical(fields.get(f)) !== canonical(oldFields.get(f)),
      );
      changes.push({
        object: old.id,
        status:
          added.length || removed.length || changed.length
            ? "Schema changed"
            : "Unchanged",
        added,
        removed,
        changed,
      });
      const { discovery: _, ...settings } = old;
      return { ...settings, fields: observed.fields };
    }),
  };
  protectQuality(
    s.definitions.find((d) => d.definition.id === before.id)?.definition,
    definition,
  );
  const inputs = validateBinding(context, definition, definition.discovery);
  const path = (pin: { id: string }) =>
    `discovery/${context.environment ?? "dev"}/${before.source!.id}/${pin.id}.yaml`;
  // Exact saved wrapper bytes, never a re-serialisation or sample payload.
  const files = [
    {
      path: `discovery/${before.source!.id}.yaml`,
      before: readFileSync(
        fence(context.root, path(before.discovery!)),
        "utf8",
      ),
      after: readFileSync(
        fence(context.root, path(definition.discovery!)),
        "utf8",
      ),
    },
  ];
  return {
    apiVersion: "ingestron.ingestion-discovery-update/v1",
    definition,
    changes,
    findings: definitionFindings(definition),
    availableObjects: next
      .snapshot!.objects.filter(
        (o) => !before.objects.some((old) => old.id === o.id),
      )
      .map((o) => o.id),
    coverage: next.snapshot!.coverage,
    files,
    inputs,
  };
}
