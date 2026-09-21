import { installationRoot } from "./installation.js";
import { readFileSync, existsSync } from "node:fs";

import { resolve } from "node:path";
import { canonical, digest, check } from "./errors.js";
export function compilerFingerprint() {
  const root = installationRoot;
  const file = resolve(root, "dist/compiler-fingerprint.json");
  check(
    existsSync(file),
    "COMPILER",
    "Build core before planning (pnpm build)",
  );
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  for (const [name, hash] of Object.entries(manifest.files))
    check(
      digest(readFileSync(resolve(root, name))) === hash,
      "COMPILER",
      "Compiler installation changed; rebuild or reinstall the pinned package",
    );
  if (import.meta.url.endsWith(".ts"))
    for (const [name, hash] of Object.entries(manifest.sources))
      check(
        digest(readFileSync(resolve(root, name))) === hash,
        "COMPILER",
        "Source changed since compilation; run pnpm build before planning",
      );
  return digest(canonical(manifest));
}
