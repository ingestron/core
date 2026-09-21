import { z } from "zod";
import { validateContract } from "./contracts.js";
import { check, isMap } from "./errors.js";
const name = z.string().regex(/^[a-z][a-z0-9_-]*$/);
export const modelPackSchema = z
  .object({
    apiVersion: z.literal("ingestron.extension-pack/v2"),
    kind: z.literal("model"),
    id: name,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1),
    contracts: z
      .record(name, z.record(z.string(), z.unknown()))
      .refine(
        (v) => Object.keys(v).length > 0 && Object.keys(v).length <= 200,
        "Export 1–200 contracts",
      ),
    relationships: z
      .array(
        z
          .object({
            id: name,
            from: name,
            fields: z.array(z.string().min(1)).min(1),
            to: name,
            references: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .max(500)
      .default([]),
    provenance: z
      .object({
        sources: z.array(z.string().min(1)).min(1),
        retrieved: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        status: z.enum(["recorded-schema", "documented-projection"]),
        notes: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export function validateModelPack(raw: unknown) {
  const pack = modelPackSchema.parse(raw);
  const noDirectives = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(noDirectives);
    else if (isMap(v))
      for (const [key, value] of Object.entries(v)) {
        check(
          !key.startsWith("$"),
          "MODEL_PACK",
          "Model packs cannot contain configuration directives",
        );
        noDirectives(value);
      }
  };
  noDirectives(pack);
  const schemas: Record<string, any[]> = {};
  for (const [alias, contract] of Object.entries(pack.contracts)) {
    validateContract(contract);
    const schema = contract.schema as any[];
    check(
      schema?.length === 1 && schema[0].properties?.length,
      "MODEL_PACK",
      `${alias}: export one dataset with properties`,
    );
    const columns = schema[0].properties as any[];
    check(
      new Set(columns.map((c) => c.name)).size === columns.length,
      "MODEL_PACK",
      `${alias}: duplicate property`,
    );
    schemas[alias] = columns;
  }
  const ids = new Set<string>();
  for (const relation of pack.relationships) {
    check(!ids.has(relation.id), "MODEL_PACK", "Duplicate relationship id");
    ids.add(relation.id);
    check(
      schemas[relation.from] && schemas[relation.to],
      "MODEL_PACK",
      `${relation.id}: unknown dataset`,
    );
    check(
      relation.fields.length === relation.references.length &&
        new Set(relation.fields).size === relation.fields.length &&
        new Set(relation.references).size === relation.references.length,
      "MODEL_PACK",
      `${relation.id}: invalid relationship fields`,
    );
    const keys = schemas[relation.to]
      .filter((c) => c.primaryKey)
      .map((c) => c.name)
      .sort();
    check(
      JSON.stringify(keys) === JSON.stringify([...relation.references].sort()),
      "MODEL_PACK",
      `${relation.id}: reference the complete target primary key`,
    );
    relation.fields.forEach((field, index) => {
      const from = schemas[relation.from].find((c) => c.name === field);
      const to = schemas[relation.to].find(
        (c) => c.name === relation.references[index],
      );
      check(
        from &&
          to &&
          from.logicalType === to.logicalType &&
          from.physicalType === to.physicalType,
        "MODEL_PACK",
        `${relation.id}: missing or incompatible relationship field`,
      );
    });
  }
  return pack;
}
