import { rmSync, mkdirSync, cpSync } from "node:fs";
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/assets", { recursive: true });
cpSync("schemas", "dist/assets/schemas", { recursive: true });
