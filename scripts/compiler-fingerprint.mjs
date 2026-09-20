import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";
const root = process.cwd(),
  hash = (value) => createHash("sha256").update(value).digest("hex");
const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        !["__pycache__", ".ruff_cache", ".DS_Store"].includes(entry.name) &&
        !/\.py[co]$/.test(entry.name),
    )
    .flatMap((entry) =>
      entry.isDirectory()
        ? walk(resolve(directory, entry.name))
        : [resolve(directory, entry.name)],
    );
const inventory = (paths) =>
  Object.fromEntries(
    paths
      .sort()
      .map((file) => [relative(root, file), hash(readFileSync(file))]),
  );
writeFileSync(
  "dist/compiler-fingerprint.json",
  JSON.stringify(
    {
      files: inventory([
        ...walk("dist/core").filter((file) => file.endsWith(".js")),
        ...walk("dist/plugins").filter((file) => file.endsWith(".js")),
        ...walk("dist/sdk").filter((file) => file.endsWith(".js")),
        resolve("dist/version.js"),
        ...walk("dist/assets"),
      ]),
      sources: inventory([
        ...walk("src/core"),
        ...walk("src/plugins"),
        ...walk("src/sdk"),
        "src/version.ts",
        "scripts/build-assets.mjs",
      ]),
    },
    null,
    2,
  ) + "\n",
);
