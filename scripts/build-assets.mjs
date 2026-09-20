import { rmSync, mkdirSync, cpSync } from "node:fs";
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/assets", { recursive: true });
for (const name of ["schemas", "catalogue"])
  cpSync(name, "dist/assets/" + name, { recursive: true });
