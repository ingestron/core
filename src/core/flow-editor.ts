import { parseDocument } from "yaml";
import { flowCreate } from "./workflows.js";
import { providerAuthor, providerReference } from "../plugins/authoring.js";
import { configuredPackageReference, resolvePackage } from "./packages.js";
import { projectPackages } from "./project-packages.js";
import { projectSchema } from "./schema.js";
import { relative } from "node:path";
import { visit } from "yaml";
import { z } from "zod";
import { editableProject, preview } from "./authoring.js";
import { canonical, check, digest } from "./errors.js";
import { flowSchema } from "./schema.js";
import { contractGovernance } from "./governance.js";
import { contractColumns } from "./contracts.js";
import {
  editableQualitySchema,
  readEditableQuality,
  applyEditableQuality,
  type EditableQuality,
} from "./quality-editor.js";
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/);
const key = z.string().regex(/^[a-f0-9]{64}$/);
const scalar = z.union([
  z.string().max(4000),
  z.number().finite(),
  z.boolean(),
]);
export const flowEditorReadSchema = z
  .object({ flow: identifier.optional() })
  .strict();
export const flowEditorReviewSchema = z
  .object({
    flow: identifier,
    revision: key,
    description: z.string().max(4000),
    values: z.record(key, scalar).default({}),
    sourceAdditions: z
      .record(
        z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]{0,79}$/)
          .refine(
            (name) =>
              !/password|secret|token|credential|connectionstring|__proto__|prototype|constructor/i.test(
                name,
              ),
            "Use the connection editor for credentials; reserved keys are not source settings",
          ),
        scalar,
      )
      .refine((value) => Object.keys(value).length <= 30)
      .optional(),
    logic: z.record(key, z.string().max(65536)).default({}),
    contracts: z
      .array(
        z
          .object({
            id: key,
            quality: editableQualitySchema.optional(),
            metadata: z
              .object({
                contractId: z.string().trim().min(1).max(160),
                name: z.string().trim().min(1).max(160),
                purpose: z.string().max(4000),
                owners: z.array(z.string().trim().min(1).max(160)).max(30),
              })
              .strict()
              .optional(),
            fields: z
              .array(
                z
                  .object({
                    original: z.string().optional(),
                    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,79}$/),
                    logicalType: z.string().min(1).max(80),
                    physicalType: z.string().min(1).max(80),
                    required: z.boolean(),
                    primaryKey: z.boolean(),
                  })
                  .strict(),
              )
              .min(1)
              .max(500),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();
type Location = { file: string; prefix: (string | number)[] };
/** Resolve source locations afresh; clients cannot supply paths or pointers. */
function editor(root: string, id: string) {
  const w = editableProject(root),
    selected = w.selectFlow(id),
    doc = w.document(selected.file);
  const raw: any = doc.getIn(selected.prefix, true);
  const flow: any = selected.prefix.length ? raw.toJSON() : doc.toJS();
  const values: {
    id: string;
    section: string;
    name: string;
    value: string | number | boolean;
  }[] = [];
  const logic: { id: string; name: string; language: string; text: string }[] =
    [];
  const contracts: {
    id: string;
    name: string;
    metadata: {
      contractId: string;
      name: string;
      purpose: string;
      owners: string[];
    };
    fields: any[];
    quality: EditableQuality;
  }[] = [];
  const targets = new Map<string, Location>(),
    files = new Map<string, string>();
  const writable = (location: Location) => {
    visit(w.document(location.file), {
      Alias() {
        check(
          false,
          "AUTHORING",
          "Edit shared YAML aliases in their source definition before using the flow editor",
        );
      },
    });
    return location;
  };
  const token = (location: Location) => {
    const id = digest(
      canonical({
        path: relative(w.reader.root, location.file),
        pointer: location.prefix,
      }),
    );
    targets.set(id, writable(location));
    return id;
  };
  const visitValues = (
    value: any,
    path: (string | number)[],
    section: string,
    names: string[] = [],
    depth = 0,
  ) => {
    check(
      depth < 16 && values.length < 500,
      "LIMIT",
      "Flow settings exceed the editor limit",
    );
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !value.$resolve
    ) {
      for (const [name, child] of Object.entries(value)) {
        if (/password|secret|token|credential|connectionstring/i.test(name))
          continue;
        if (
          (name === "sqlFile" || name === "pythonFile") &&
          typeof child === "string"
        ) {
          const file = w.reader.path(child, selected.file),
            text = w.reader.text(file);
          check(
            text.length <= 65536 && /\.(sql|py)$/.test(file),
            "LIMIT",
            "Logic must be a SQL/Python source file up to 64 KiB",
          );
          const id = digest(relative(w.reader.root, file));
          files.set(id, file);
          logic.push({
            id,
            name: names.join(" / "),
            language: name === "sqlFile" ? "sql" : "python",
            text,
          });
        } else if (
          !name.startsWith("$") &&
          !["from", "uses", "provider"].includes(name)
        )
          visitValues(
            child,
            [...path, name],
            section,
            [...names, name],
            depth + 1,
          );
      }
    } else if (["string", "number", "boolean"].includes(typeof value))
      values.push({
        id: token({
          file: selected.file,
          prefix: [...selected.prefix, ...path],
        }),
        section,
        name: names.join(" / "),
        value,
      });
  };
  visitValues(flow.requires ?? {}, ["requires"], "Inputs");
  for (let i = values.length - 1; i >= 0; i--)
    if (values[i].name.endsWith(" / mode")) {
      targets.delete(values[i].id);
      values.splice(i, 1);
    }
  visitValues(flow.defaults?.source ?? {}, ["defaults", "source"], "Source");
  visitValues(flow.ingestion ?? {}, ["ingestion"], "Ingestion settings");
  for (const [name, table] of Object.entries<any>(flow.tables ?? {}))
    visitValues(table.source ?? {}, ["tables", name, "source"], "Source", [
      name,
    ]);
  for (let index = 0; index < (flow.steps ?? []).length; index++)
    visitValues(
      flow.steps[index].with ?? {},
      ["steps", index, "with"],
      "Output settings",
      [flow.steps[index].id],
    );
  for (const [group, entries] of [
    ["tables", flow.tables ?? {}],
    ["publishes", flow.publishes ?? {}],
  ] as const) {
    for (const name of Object.keys(entries)) {
      if (!entries[name].contract) continue;
      const location = w.location({
        file: selected.file,
        prefix: [...selected.prefix, group, name, "contract"],
      });
      const contract: any = w
        .document(location.file)
        .getIn(location.prefix, true);
      const value = location.prefix.length
        ? contract?.toJSON()
        : w.document(location.file).toJS();
      contractColumns(value);
      check(
        value.schema[0].properties.length <= 500,
        "LIMIT",
        "Too many output fields",
      );
      contracts.push({
        id: token(location),
        name,
        quality: readEditableQuality(value),
        metadata: {
          contractId: value.id,
          name: value.name ?? value.id,
          purpose: value.description?.purpose ?? "",
          owners: contractGovernance(value).owners,
        },
        fields: value.schema[0].properties.map((f: any) => ({
          original: f.name,
          name: f.name,
          logicalType: f.logicalType,
          physicalType:
            f.physicalType ??
            (
              {
                string: "STRING",
                integer: "BIGINT",
                number: "DOUBLE",
                boolean: "BOOLEAN",
                date: "DATE",
                timestamp: "TIMESTAMP",
              } as any
            )[f.logicalType],
          required: f.required === true,
          primaryKey: f.primaryKey === true,
        })),
      });
    }
  }
  const project = w.reader.load();
  const allContracts = project.flows.flatMap((f: any) =>
    [
      ...Object.values<any>(f.tables ?? {}),
      ...Object.values<any>(f.publishes ?? {}),
    ].map((o) => o.contract),
  );
  const readiness = contracts.flatMap((c) => [
    {
      id: `${c.id}:identity`,
      ready:
        allContracts.filter((o: any) => o?.id === c.metadata.contractId)
          .length === 1,
      message: `${c.name} · Distinct identity`,
      panel: "contract",
    },
    {
      id: `${c.id}:purpose`,
      ready: !!c.metadata.purpose.trim(),
      message: `${c.name} · Business purpose`,
      panel: "contract",
    },
    {
      id: `${c.id}:owner`,
      ready: c.metadata.owners.length > 0,
      message: `${c.name} · Accountable owner`,
      panel: "contract",
    },
  ]);
  writable(selected);
  return {
    w,
    selected,
    targets,
    files,
    snapshot: {
      id: flow.id,
      kind: flow.kind,
      provider: flow.provider ?? "",
      description: flow.description ?? "",
      revision: digest(canonical(w.reader.files)),
      values,
      logic,
      contracts,
      readiness,
    },
  };
}
export function readFlowEditor(root: string, flow?: string) {
  const w = editableProject(root),
    project = w.reader.load();
  check(project.flows.length <= 1000, "LIMIT", "Too many flows");
  const datasets = project.flows.flatMap((f: any) => [
    ...Object.keys(f.tables ?? {}).map(
      (name) => `${project.id}.${f.id}.${name}.current`,
    ),
    ...Object.keys(f.publishes ?? {}).map(
      (name) => `${project.id}.${f.id}.${name}`,
    ),
  ]);
  return {
    apiVersion: "ingestron.flow-editor/v1",
    flows: project.flows.map((f: any) => ({
      id: f.id,
      kind: f.kind,
      description: f.description ?? "",
      provider: f.provider ?? project.defaults?.provider ?? "",
    })),
    datasets,
    providers: Object.entries<any>(project.providers?.configurations ?? {}).map(
      ([id, config]) => {
        try {
          const reference = configuredPackageReference(
            projectPackages(projectSchema.parse(project))[config.package],
          );
          const { manifest } = providerReference(
            root,
            resolvePackage(root, reference).reference,
          );
          const schema: any = manifest.authoring?.transformationSettingsSchema;
          let inputDatasets: string[] | undefined;
          if (
            manifest.authoring?.flows?.transformationInputs === "provider/v1"
          ) {
            const files = providerAuthor(
              root,
              reference,
              { operation: "flow_inputs", project, configuration: id },
              (name) => name === "inputs.json",
            );
            const result = z
              .object({
                apiVersion: z.literal("ingestron.flow-inputs/v1"),
                datasets: z.array(z.string().max(500)).max(10000),
              })
              .strict()
              .parse(JSON.parse(files["inputs.json"] ?? "null"));
            check(
              new Set(result.datasets).size === result.datasets.length &&
                result.datasets.every((dataset) => datasets.includes(dataset)),
              "PROVIDER",
              "Provider returned unknown or duplicate transformation inputs",
            );
            inputDatasets = result.datasets;
          }
          return {
            id,
            ...(inputDatasets ? { inputDatasets } : {}),
            available: !!manifest.lifecycle && !!manifest.authoring?.flows,
            kinds: manifest.authoring?.flows?.kinds ?? [],
            prerequisites: manifest.authoring?.flows?.prerequisites ?? [],
            standards: (manifest.standards ?? []).filter((s) =>
              manifest.authoring?.flows?.ingestionStandards.includes(s.id),
            ),
            settings: Object.entries<any>(schema?.properties ?? {})
              .filter(([, p]) => p.type === "string")
              .map(([name, p]) => ({
                name,
                label: p.title ?? name,
                hint: p.description ?? "",
                required: schema.required?.includes(name) ?? false,
              })),
          };
        } catch {
          return {
            id,
            available: false,
            kinds: [],
            prerequisites: [],
            standards: [],
            settings: [],
          };
        }
      },
    ),
    ...(flow ? { selected: editor(root, flow).snapshot } : {}),
  };
}
export function reviewFlowEditor(
  root: string,
  args: z.infer<typeof flowEditorReviewSchema>,
) {
  const { w, selected, targets, files, snapshot } = editor(root, args.flow);
  check(
    snapshot.revision === args.revision,
    "STALE",
    "Flow inputs changed; reopen the flow before reviewing",
  );
  const changed = new Set<string>();
  const set = (location: Location, value: unknown) => {
    w.document(location.file).setIn(location.prefix, value);
    changed.add(location.file);
  };
  const additions = flowEditorReviewSchema.shape.sourceAdditions.parse(
    args.sourceAdditions,
  );
  if (additions && Object.keys(additions).length) {
    const document = w.document(selected.file);
    const flow: any = document.getIn(selected.prefix, true)?.toJSON();
    const source = flow?.defaults?.source;
    check(
      snapshot.kind === "ingestion" &&
        source &&
        typeof source === "object" &&
        !Array.isArray(source) &&
        !source.$resolve,
      "AUTHORING",
      "Add source settings only to a local ingestion source definition",
    );
    visit(document, {
      Alias() {
        check(
          false,
          "AUTHORING",
          "Edit shared YAML aliases in their source definition before adding settings",
        );
      },
    });
    for (const [name, value] of Object.entries(additions)) {
      check(
        !Object.hasOwn(source, name),
        "AUTHORING",
        "Edit existing source settings in their current fields",
      );
      set(
        {
          file: selected.file,
          prefix: [...selected.prefix, "defaults", "source", name],
        },
        value,
      );
    }
  }
  if (args.description !== snapshot.description)
    set(
      { file: selected.file, prefix: [...selected.prefix, "description"] },
      args.description,
    );
  for (const [id, value] of Object.entries(args.values)) {
    const field = snapshot.values.find((v) => v.id === id);
    check(
      field && typeof field.value === typeof value,
      "AUTHORING",
      "Unknown field or changed field type",
    );
    if (field.value !== value) set(targets.get(id)!, value);
  }
  const replacements: Record<string, string> = {};
  for (const [id, value] of Object.entries(args.logic)) {
    check(files.has(id), "AUTHORING", "Unknown logic document");
    if (value !== snapshot.logic.find((v) => v.id === id)!.text)
      replacements[relative(w.reader.root, files.get(id)!)] = value;
  }
  check(
    new Set(args.contracts.map((c) => c.id)).size === args.contracts.length,
    "AUTHORING",
    "Choose each output contract once",
  );
  for (const update of args.contracts) {
    const original = snapshot.contracts.find((c) => c.id === update.id);
    check(original, "AUTHORING", "Unknown output contract");
    if (
      canonical(original.fields) === canonical(update.fields) &&
      (!update.quality ||
        canonical(original.quality) === canonical(update.quality)) &&
      (!update.metadata ||
        canonical(original.metadata) === canonical(update.metadata))
    )
      continue;
    const target = targets.get(update.id)!;
    const node: any = w.document(target.file).getIn(target.prefix, true);
    const value = target.prefix.length
        ? node.toJSON()
        : w.document(target.file).toJS(),
      old = value.schema[0].properties;
    const originals = update.fields.flatMap((f) =>
      f.original ? [f.original] : [],
    );
    check(
      new Set(originals).size === originals.length,
      "AUTHORING",
      "Choose each original field once",
    );
    const properties = update.fields.map(({ original: name, ...field }) => {
      const previous = name ? old.find((f: any) => f.name === name) : undefined;
      check(!name || previous, "AUTHORING", "Unknown original output field");
      return { ...previous, ...field };
    });
    const updated = structuredClone(value);
    updated.schema[0].properties =
      canonical(original.fields) === canonical(update.fields)
        ? structuredClone(old)
        : properties;
    if (update.metadata) {
      const m = update.metadata;
      if (m.contractId !== original.metadata.contractId) {
        const existing = w.reader
          .load()
          .flows.flatMap((f: any) => [
            ...Object.values<any>(f.tables ?? {}),
            ...Object.values<any>(f.publishes ?? {}),
          ]);
        check(
          !existing.some((o: any) => o.contract?.id === m.contractId),
          "CONTRACT_ID",
          "Another output already uses this contract identity",
        );
        check(
          !args.contracts.some(
            (c) =>
              c.id !== update.id && c.metadata?.contractId === m.contractId,
          ),
          "CONTRACT_ID",
          "Choose distinct contract identities",
        );
      }
      updated.id = m.contractId;
      updated.name = m.name;
      updated.description = { ...updated.description, purpose: m.purpose };
      if (canonical(m.owners) !== canonical(original.metadata.owners)) {
        check(
          new Set(m.owners).size === m.owners.length,
          "GOVERNANCE",
          "Choose each owner once",
        );
        const members = Array.isArray(updated.team)
          ? updated.team
          : (updated.team?.members ?? []);
        // Preserve other roles, historical members and retained owner metadata.
        const current = new Set(original.metadata.owners);
        const retained = members.filter(
          (member: any) =>
            !(
              /owner/i.test(member.role ?? "") && current.has(member.username)
            ) || m.owners.includes(member.username),
        );
        for (const username of m.owners)
          if (!current.has(username))
            retained.push({ username, role: "owner" });
        updated.team = Array.isArray(updated.team)
          ? retained
          : { ...updated.team, members: retained };
      }
      for (const name of ["id", "name", "description", "team"])
        if (
          updated[name] !== undefined &&
          canonical(updated[name]) !== canonical(value[name] ?? null)
        )
          set(
            { file: target.file, prefix: [...target.prefix, name] },
            updated[name],
          );
    }
    if (update.quality) {
      applyEditableQuality(updated, update.quality, update.fields);
      for (const [path, rules, before] of [
        [
          ["schema", 0, "quality"],
          updated.schema[0].quality,
          value.schema[0].quality,
        ],
      ] as const)
        if (canonical(rules) !== canonical(before ?? []))
          set(
            { file: target.file, prefix: [...target.prefix, ...path] },
            rules,
          );
    }
    contractColumns(updated);
    if (canonical(old) !== canonical(updated.schema[0].properties))
      set(
        {
          file: target.file,
          prefix: [...target.prefix, "schema", 0, "properties"],
        },
        updated.schema[0].properties,
      );
  }
  for (const file of changed)
    replacements[relative(w.reader.root, file)] = w.document(file).toString();
  const flowNode: any = w.document(selected.file).getIn(selected.prefix, true);
  flowSchema.parse(
    selected.prefix.length
      ? flowNode.toJSON()
      : w.document(selected.file).toJS(),
  );
  return preview(root, replacements, w.reader.files);
}

export const flowEditorCreateSchema = z
  .object({
    id: identifier,
    kind: z.enum(["ingestion", "transformation"]),
    provider: identifier,
    standard: z.string().max(160).optional(),
    inputDataset: z.string().max(500).optional(),
    transformationSettings: z
      .record(identifier, z.string().max(4000))
      .optional(),
    output: identifier.optional(),
  })
  .strict();
export function createFlowEditor(
  root: string,
  environment: string,
  args: z.infer<typeof flowEditorCreateSchema>,
) {
  const { output, ...options } = args;
  check(
    args.kind === "ingestion" ? !!output : !output,
    "INPUT",
    "Choose an output dataset name for ingestion only",
  );
  const project = editableProject(root).reader.load();
  const contractId = `${project.id}.${args.id}.${output}`;
  if (args.kind === "ingestion")
    check(
      !project.flows.some((flow: any) =>
        [
          ...Object.values<any>(flow.tables ?? {}),
          ...Object.values<any>(flow.publishes ?? {}),
        ].some((entry: any) => entry.contract?.id === contractId),
      ),
      "CONTRACT_ID",
      "Another output already uses this contract identity",
    );
  const provider = readFlowEditor(root).providers.find(
    (p) => p.id === args.provider,
  );
  check(
    provider?.available && provider.kinds.includes(args.kind),
    "CAPABILITY",
    "Install a provider that declares support for this flow kind",
  );
  check(
    args.kind !== "ingestion" ||
      (!!args.standard &&
        provider.standards.some((s) => s.id === args.standard)),
    "CAPABILITY",
    "Choose a declared ingestion authoring standard",
  );
  const proposal = flowCreate(root, environment, options);
  if (args.kind === "transformation") return proposal;
  const file = `flows/${args.id}/flow.yaml`;
  const doc = parseDocument(
    proposal.changes.find((c: any) => c.path === file)!.after,
  );
  check(
    !doc.hasIn(["tables", output!]),
    "OWNER",
    "Provider already owns this output table",
  );
  // A visible starter contract; the editor exposes all fields for business review.
  const contract = {
    apiVersion: "v3.1.0",
    kind: "DataContract",
    id: contractId,
    name: output!,
    version: "1.0.0",
    status: "draft",
    schema: [
      {
        name: output!,
        logicalType: "object",
        physicalType: "table",
        properties: [
          {
            name: "id",
            logicalType: "string",
            physicalType: "STRING",
            required: true,
            primaryKey: true,
          },
        ],
      },
    ],
  };
  contractColumns(contract);
  doc.setIn(["tables", output!], { contract });
  return preview(
    root,
    Object.fromEntries(
      proposal.changes.map((c: any) => [
        c.path,
        c.path === file ? doc.toString() : c.after,
      ]),
    ),
    proposal.inputs,
    proposal.reviewedPackages,
  );
}
