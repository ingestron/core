import { installationRoot } from "./core/installation.js";
import { readFileSync } from "node:fs";
export const version: string = JSON.parse(
  readFileSync(installationRoot + "/package.json", "utf8"),
).version;

/** Legacy minimumCli values describe the existing plugin ABI, not the reset app
 * release number. Keep this compatibility level until manifests gain an explicit
 * protocol range; never raise it without installed-provider acceptance tests. */
export const pluginCompatibilityVersion = "4.2.0";
