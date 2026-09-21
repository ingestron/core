/** First-party adapter helpers; version-lock adapters to this package. */
export { Configuration } from "../core/config.js";
export { fence, packageYaml, resolvePackage } from "../core/packages.js";
export { check, Problem } from "../core/errors.js";
export { friendlyReference } from "../core/package-references.js";

export { installPackage, installedProviders } from "../core/packages.js";
export { digest, canonical } from "../core/errors.js";
export { planProject, inspectProject } from "../core/planner.js";
export {
  renderProject,
  writeOutput,
  validateOutput,
} from "../core/generate.js";
export { checkPluginCompatibility } from "../plugins/compatibility.js";
export {
  canonicalPackageReference,
  packageLock,
  extensionPackSchema,
} from "../core/packages.js";
export {
  taggedVersions,
  providerVersions,
} from "../core/package-references.js";
export { initialise, addFlow, addTable, apply } from "../core/authoring.js";
export { contractColumns } from "../core/contracts.js";

export { browseProviders, pluginKindLabel } from "../core/installed-plugins.js";
