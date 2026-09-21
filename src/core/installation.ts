import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
let directory = dirname(fileURLToPath(import.meta.url));
while (
  !existsSync(join(directory, "package.json")) ||
  !["@ingestron-io/core"].includes(
    JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name,
  )
) {
  const parent = dirname(directory);
  if (parent === directory)
    throw new Error("Cannot locate the Ingestron core installation");
  directory = parent;
}
export const installationRoot = directory;
export const assetPath = (path: string) =>
  join(installationRoot, "dist/assets", path);
export const compiledPath = (path: string) =>
  join(installationRoot, "dist", path);
