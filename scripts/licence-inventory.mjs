import { execFileSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  mkdirSync,
  cpSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
const tree = JSON.parse(
  execFileSync("pnpm", ["list", "--prod", "--depth", "Infinity", "--json"], {
    encoding: "utf8",
  }),
);
const packages = new Map();
function visit(deps) {
  for (const dep of Object.values(deps ?? {})) {
    if (dep.path) {
      const pkg = JSON.parse(
        readFileSync(join(dep.path, "package.json"), "utf8"),
      );
      packages.set(`${pkg.name}@${pkg.version}`, { path: dep.path, pkg });
    }
    visit(dep.dependencies);
    visit(dep.optionalDependencies);
  }
}
for (const root of tree) {
  visit(root.dependencies);
  visit(root.optionalDependencies);
}
const inventory = [];
for (const [id, { path, pkg }] of [...packages].sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  const directory = "licensing/third-party/" + id.replaceAll("/", "__");
  mkdirSync(directory, { recursive: true });
  const notices = [];
  for (const name of readdirSync(path).filter((n) =>
    /^(licen[sc]e|copying|notice)([.-].*)?$/i.test(n),
  )) {
    const destination = join(directory, name);
    cpSync(join(path, name), destination, { recursive: true });
    try {
      notices.push({
        path: destination,
        sha256: createHash("sha256")
          .update(readFileSync(destination))
          .digest("hex"),
      });
    } catch {
      notices.push({ path: destination, kind: "directory" });
    }
  }
  inventory.push({
    name: pkg.name,
    version: pkg.version,
    declaredLicence: pkg.license ?? pkg.licenses ?? "UNKNOWN",
    notices,
    reviewRequired:
      !pkg.license || notices.length === 0 || pkg.license === "UNLICENSED",
  });
}
writeFileSync(
  "licensing/dependency-inventory.json",
  JSON.stringify(
    {
      schemaVersion: 1,
      scope:
        "Installed production dependency tree, package-root licence/notice files; not a legal clearance or complete source audit",
      packages: inventory,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `${inventory.length} production dependencies inventoried; ${inventory.filter((p) => p.reviewRequired).length} require explicit notice/licence review`,
);
