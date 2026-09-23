import { check } from "./errors.js";
import type { Project } from "./schema.js";

export function projectPackages(project: Project) {
  for (const name of Object.keys(project.packages))
    check(
      !Object.hasOwn(project.providers.packages, name),
      "PACKAGE",
      `Package alias ${name} is declared twice`,
    );
  return { ...project.providers.packages, ...project.packages };
}
