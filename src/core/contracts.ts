import { assetPath } from "./installation.js";
import { readFileSync } from "node:fs";
import { Ajv2019 } from "ajv/dist/2019.js";
import addFormats from "ajv-formats";
import { check } from "./errors.js";
const ajv = new Ajv2019({ allErrors: true, strict: false });
(addFormats as any)(ajv);
const validator = ajv.compile(
  JSON.parse(readFileSync(assetPath("schemas/odcs-3.1.0.json"), "utf8")),
);
export function validateContract(
  contract: Record<string, any>,
  file?: string,
): void {
  check(
    contract.apiVersion === "v3.1.0",
    "ODCS",
    "Use pinned ODCS v3.1.0; other versions are not silently converted",
    file,
  );
  check(
    validator(contract),
    "ODCS",
    ajv.errorsText(validator.errors, { separator: "; " }),
    file,
  );
}
export interface Column {
  name: string;
  type: string;
  required: boolean;
  key: boolean;
}
export function contractColumns(
  contract: Record<string, any>,
  file?: string,
): Column[] {
  validateContract(contract, file);
  check(
    contract.schema?.length === 1 && contract.schema[0].properties?.length,
    "ODCS",
    "A dataset contract must contain one table schema with columns",
    file,
  );
  const names = new Set<string>();
  return contract.schema[0].properties.map((p: any) => {
    const name = p.physicalName ?? p.name;
    check(
      typeof name === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        !names.has(name),
      "ODCS",
      `Invalid or duplicate column ${name}`,
      file,
    );
    names.add(name);
    const type = (
      p.physicalType ??
      (
        {
          string: "STRING",
          integer: "BIGINT",
          number: "DOUBLE",
          boolean: "BOOLEAN",
          date: "DATE",
          timestamp: "TIMESTAMP",
        } as any
      )[p.logicalType]
    )?.toUpperCase();
    check(
      typeof type === "string" &&
        /^(STRING|BIGINT|INT|INTEGER|SMALLINT|DOUBLE|FLOAT|BOOLEAN|DATE|TIMESTAMP|BINARY|DECIMAL\(\d{1,2},\s*\d{1,2}\))$/.test(
          type,
        ),
      "ODCS",
      `Unsupported native type ${type} for ${name}`,
      file,
    );
    if (type.startsWith("DECIMAL")) {
      const [precision, scale] = type.match(/\d+/g)!.map(Number);
      check(
        precision >= 1 && precision <= 38 && scale <= precision,
        "ODCS",
        `Invalid decimal type ${type}`,
      );
    }
    return {
      name,
      type,
      required: p.required === true,
      key: p.primaryKey === true,
    };
  });
}
