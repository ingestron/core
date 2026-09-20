import { friendlyReference } from "../core/provider-catalogue.js";
import { readFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import {
  canonicalPackageReference,
  resolvePackage,
  providerPackageSchema,
  packageYaml,
  fence,
} from "../core/packages.js";
import { check, isMap } from "../core/errors.js";
import { executeProvider } from "./provider-renderer.js";
import { checkProviderCompatibility } from "./compatibility.js";
export function providerReference(root: string, reference: string) {
  const canonical = canonicalPackageReference(reference),
    at = canonical.lastIndexOf("@");
  const pkg = resolvePackage(root, canonical),
    manifest = providerPackageSchema.parse(packageYaml(pkg.file));
  checkProviderCompatibility(manifest);
  return {
    ...pkg,
    manifest,
    source: friendlyReference(canonical.slice(0, at)),
    version: canonical.slice(at + 1),
  };
}
export function providerAuthor(
  root: string,
  reference: string,
  input: Record<string, unknown>,
  allowed: (name: string) => boolean,
): Record<string, string> {
  const selected = providerReference(root, reference);
  check(
    selected.manifest.lifecycle,
    "PROVIDER",
    "This provider does not declare lifecycle authoring; select a migrated version",
  );
  const file = fence(
    selected.root,
    relative(
      selected.root,
      resolve(dirname(selected.file), selected.manifest.lifecycle.module),
    ),
  );
  const result: any = executeProvider(
    readFileSync(file, "utf8"),
    {
      apiVersion: "ingestron.provider-authoring/v1",
      ...input,
      provider: { source: selected.source, version: selected.version },
    },
    false,
    "author",
  );
  check(
    isMap(result.files) && Object.keys(result).length === 1,
    "PROVIDER",
    "Invalid authoring response",
  );
  for (const [name, value] of Object.entries(result.files)) {
    fence(root, name);
    check(
      allowed(name) && typeof value === "string" && value.length <= 1000000,
      "PROVIDER",
      `Invalid authored file ${name}`,
    );
  }
  return result.files;
}
