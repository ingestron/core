import { z } from "zod";
import { check } from "./errors.js";
import { contractRules } from "./quality.js";

export const editableQualitySchema = z
  .object({
    table: z.string().max(65536),
    fields: z.record(z.string().max(80), z.string().max(65536)),
  })
  .strict();
export type EditableQuality = z.infer<typeof editableQualitySchema>;

/** Keep all ODCS rule attributes, including custom engine configuration. */
export function readEditableQuality(contract: any): EditableQuality {
  const encode = (rules: unknown) => {
    const value = JSON.stringify(rules ?? [], null, 2);
    check(
      value.length <= 65536,
      "LIMIT",
      "Quality rules exceed the editor limit",
    );
    return value;
  };
  return {
    table: encode(contract.schema[0].quality),
    fields: Object.fromEntries(
      contract.schema[0].properties.map((f: any) => [
        f.name,
        encode(f.quality),
      ]),
    ),
  };
}

export function applyEditableQuality(
  updated: any,
  quality: EditableQuality,
  fields: { original?: string; name: string }[],
) {
  const decode = (text: string) => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      check(false, "QUALITY", "Enter a valid quality rule array");
    }
    check(
      Array.isArray(value) &&
        value.length <= 100 &&
        value.every(
          (rule) => rule && typeof rule === "object" && !Array.isArray(rule),
        ),
      "QUALITY",
      "Quality rules must be an array of at most 100 objects",
    );
    return value;
  };
  check(
    Object.keys(quality.fields).length <= 500,
    "LIMIT",
    "Too many field quality definitions",
  );
  for (const name of Object.keys(quality.fields))
    check(
      fields.some((f) => (f.original ?? f.name) === name),
      "QUALITY",
      "Quality rules refer to a removed or unknown field",
    );
  updated.schema[0].quality = decode(quality.table);
  for (const [i, field] of fields.entries()) {
    const rules = quality.fields[field.original ?? field.name];
    if (rules !== undefined) {
      const decoded = decode(rules);
      if (
        decoded.length ||
        updated.schema[0].properties[i].quality !== undefined
      )
        updated.schema[0].properties[i].quality = decoded;
    }
  }
  const rules = contractRules(updated);
  const identities = rules.map((rule) => rule.id);
  check(
    new Set(identities).size === identities.length,
    "QUALITY",
    "Choose a distinct identity for each quality rule in this contract",
  );
}
