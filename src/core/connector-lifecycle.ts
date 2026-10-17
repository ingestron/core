/** Reviewed connector lifecycle; clients never edit package locks or registrations. */
import { existsSync, readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { z } from "zod";
import { Configuration } from "./config.js";
import { projectSchema } from "./schema.js";
import { auditSecrets } from "./planner.js";
import { connectorPackageSchema } from "./connector-package.js";
import { projectPackages } from "./project-packages.js";
import { resolveConnectionSettings } from "./connection-settings.js";
import { packageEditor, packagePath, identifier } from "./workflows.js";
import {
  packageYaml,
  configuredPackageReference,
  resolvePackage,
  fence,
} from "./packages.js";
import { preview, apply } from "./authoring.js";
import {
  portableConnectorInputs,
  portableConnectorConsumers,
  type ConnectorConsumer,
} from "./connector-impact.js";
import { check, canonical, digest } from "./errors.js";
import {
  inspectPackageLibrary,
  reviewPackageInstall,
  applyPackageInstall,
} from "./package-library.js";

export const connectorChangeSchema = z
  .object({
    action: z.enum(["install", "reinstall", "upgrade", "remove"]),
    reference: z.string().min(1).max(500),
    registration: identifier.optional(),
    tagPrefix: z
      .string()
      .max(100)
      .regex(/^[a-z0-9-]*$/)
      .optional(),
    fromGit: z.string().optional(),
  })
  .strict();
const requestSchema = connectorChangeSchema.omit({ fromGit: true });
export const connectorApplySchema = z
  .object({
    proposal: z
      .object({
        request: requestSchema,
        revision: z.string().regex(/^[a-f0-9]{64}$/),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    fromGit: z.string().optional(),
  })
  .strict();

export function connectorUsage(root: string, reference: string) {
  const reader = new Configuration(root, {}),
    project = reader.parse(projectSchema, reader.load());
  const selected = resolvePackage(root, reference);
  const registrations = Object.entries(projectPackages(project))
    .filter(
      ([, p]) =>
        resolvePackage(root, configuredPackageReference(p)).reference ===
        selected.reference,
    )
    .map(([name]) => name);
  const usedBy: string[] = [];
  const friendly = inspectPackageLibraryId(root, reference);
  const visit = (value: unknown, path: string[]) => {
    if (typeof value === "string") {
      if (
        (path.at(-1) === "package" && registrations.includes(value)) ||
        value === reference ||
        value === friendly
      )
        usedBy.push(path.join("."));
    } else if (value && typeof value === "object")
      Object.entries(value).forEach(([key, item]) =>
        visit(item, [...path, key]),
      );
  };
  // Declaration maps are removed, but all resolved consumers (including environments) stay.
  const { packages: _p, providers, ...rest } = project;
  visit({ ...rest, providers: { ...providers, packages: undefined } }, []);
  const split = selected.reference.lastIndexOf("@");
  const manifest = connectorPackageSchema.parse(packageYaml(selected.file));
  const inputs = portableConnectorInputs(root);
  for (const id of new Set([selected.reference.slice(0, split), manifest.id]))
    usedBy.push(
      ...portableConnectorConsumers(inputs, [], {
        id,
        version: manifest.version,
      }).map((c) => c.name),
    );
  return { registrations, usedBy: [...new Set(usedBy)] };
}
function inspectPackageLibraryId(root: string, reference: string) {
  const selected = inspectPackageLibrary(root).packages.find(
    (p) => p.reference === resolvePackage(root, reference).reference,
  );
  return selected ? `${selected.id}@${selected.version}` : reference;
}

function isNewerVersion(target: string, current: string) {
  const a = target.split(".").map(Number),
    b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

export function reviewConnectorChange(
  root: string,
  input: z.infer<typeof connectorChangeSchema>,
) {
  const args = connectorChangeSchema.parse(input);
  const revision = preview(root, {}).revision;
  const library = inspectPackageLibrary(root);
  const selected = library.packages.find((p) => p.reference === args.reference);
  const { fromGit: _origin, ...request } = args;
  const dependencies = portableConnectorInputs(root);
  const consumers: ConnectorConsumer[] = [];
  let currentVersion: string | undefined;
  let currentManifest: string | undefined;
  let install: ReturnType<typeof reviewPackageInstall> | undefined;
  let configuration = preview(root, {});
  let registration = args.registration;
  let name = "",
    version = "",
    usedBy: string[] = [];
  const editor = packageEditor(root),
    raw = editor.project.toJS();
  const reader = new Configuration(root, {}),
    project = reader.parse(projectSchema, reader.load());
  auditSecrets(project.connections, "connections");
  auditSecrets(project.environments, "environments");
  if (args.action === "remove") {
    check(
      selected?.kind === "connector",
      "PACKAGE",
      "Choose an installed connector version",
    );
    const usage = connectorUsage(root, args.reference);
    usedBy = usage.usedBy;
    check(
      !usedBy.length,
      "IN_USE",
      `Connector is used by ${usedBy.join(", ")}. Reassign those connections before removal.`,
    );
    check(
      !raw.packages?.$resolve,
      "REFERENCE",
      "Edit the referenced package declarations before removing this connector",
    );
    for (const alias of usage.registrations)
      editor.project.deleteIn(packagePath(raw, alias));
    const lock = parseDocument(
      readFileSync(fence(root, "packages.lock.yaml"), "utf8"),
    );
    lock.deleteIn(["packages", args.reference]);
    configuration = editor.finish({
      "project.yaml": editor.project.toString(),
      "packages.lock.yaml": lock.toString(),
    });
    name = selected.id;
    version = selected.version;
  } else {
    check(
      args.action !== "reinstall" || selected?.kind === "connector",
      "PACKAGE",
      "Choose an installed connector to reinstall",
    );
    install = reviewPackageInstall(root, {
      reference: args.reference,
      ...(args.tagPrefix ? { tagPrefix: args.tagPrefix } : {}),
      ...(args.fromGit ? { fromGit: args.fromGit } : {}),
    });
    check(
      install.proposal.kind === "connector",
      "PACKAGE",
      "Choose a connector package",
    );
    const manifest = connectorPackageSchema.parse(install.connector);
    name = manifest.id;
    version = manifest.version;
    if (args.action === "reinstall") {
      check(
        install.proposal.commit === selected!.commit,
        "STALE",
        "This version tag changed. Select the original commit before reinstalling.",
      );
    } else {
      const aliases = projectPackages(project);
      if (args.action === "upgrade") {
        check(
          registration && aliases[registration],
          "PACKAGE",
          "Choose the connector registration to upgrade",
        );
        const old = resolvePackage(
          root,
          configuredPackageReference(aliases[registration]),
        );
        const existing = library.packages.find(
          (p) => p.reference === old.reference,
        );
        const target = install.proposal.reference.slice(
          0,
          install.proposal.reference.lastIndexOf("@"),
        );
        check(
          existing?.id === name &&
            old.reference.slice(0, old.reference.lastIndexOf("@")) === target,
          "PACKAGE",
          "Upgrade must keep the same connector source",
        );
        check(
          isNewerVersion(version, existing!.version),
          "PACKAGE",
          "Choose a newer version, or use Reinstall for the current version",
        );
        currentVersion = existing!.version;
        currentManifest = readFileSync(old.file, "utf8");
        const connections = Object.entries(project.connections)
          .filter(([, c]) => c.package === registration)
          .map(([id]) => id);
        consumers.push(
          ...portableConnectorConsumers(dependencies, connections),
        );
        const visit = (value: unknown, path: string[]) => {
          if (typeof value === "string" && connections.includes(value))
            consumers.push({
              kind: "Configured consumer",
              name: path.join("."),
              environment: path[0] === "environments" ? path[1]! : "All",
              effect:
                "Binding retained; target compatibility and execution not assessed",
            });
          else if (value && typeof value === "object")
            Object.entries(value).forEach(([k, v]) => visit(v, [...path, k]));
        };
        const {
          connections: _connections,
          packages: _packages,
          providers: _providers,
          ...consumerConfig
        } = project;
        visit(consumerConfig, []);
        for (const [id, connection] of Object.entries(project.connections))
          if (connection.package === registration) {
            usedBy.push(id);
            for (const environment of Object.keys(project.environments)) {
              try {
                resolveConnectionSettings(
                  reader,
                  project,
                  environment,
                  connection,
                  manifest.definition.settingsSchema,
                );
                consumers.push({
                  kind: "Source settings",
                  name: id,
                  environment,
                  effect:
                    "Compatible with candidate schema; settings unchanged",
                });
              } catch {
                check(
                  false,
                  "CONNECTION",
                  `Connection ${id} in ${environment} is incompatible with this version. Update its settings before upgrading.`,
                );
              }
            }
          }
      } else {
        check(
          !selected,
          "PACKAGE",
          "This version is already installed; use Reinstall or Set up connection",
        );
        const base = name.replace(/-/g, "_");
        registration = registration ?? base;
        if (!args.registration) {
          let n = 2;
          while (aliases[registration]) registration = `${base}_${n++}`;
        }
        check(
          !aliases[registration],
          "CONFLICT",
          "Connector registration already exists",
        );
      }
      editor.project.setIn(packagePath(raw, registration!), args.reference);
      configuration = editor.finish({
        "project.yaml": editor.project.toString(),
      });
    }
  }
  const files = [
    ...configuration.changes,
    ...(install && install.lockFile.before !== install.lockFile.after
      ? [install.lockFile]
      : []),
  ];
  const fingerprint = digest(
    canonical({
      request,
      revision,
      install: install?.proposal,
      lockAfter: install?.lockFile.after,
      configuration,
      registration,
      dependencies: dependencies.fingerprint,
      consumers,
    }),
  );
  return {
    proposal: { request, revision, fingerprint },
    name,
    version,
    registration,
    usedBy,
    files,
    dependencies: dependencies.fingerprint,
    comparisonFiles:
      currentManifest && install
        ? [
            {
              path: "connector-manifest.yaml",
              before: currentManifest,
              after: install.manifestText,
            },
          ]
        : [],
    impact:
      args.action === "upgrade"
        ? {
            currentVersion,
            candidateVersion: version,
            consumers,
            settings: "schema-checked",
            metadata: "retained-unverified",
            definitions: "preserved",
            candidateInstalled: !!selected,
          }
        : undefined,
    install: install?.proposal,
    lockAfter: install?.lockFile.after,
    licence: install?.licence,
  };
}

export function applyConnectorChange(
  root: string,
  input: z.infer<typeof connectorApplySchema>,
) {
  const args = connectorApplySchema.parse(input);
  check(
    preview(root, {}).revision === args.proposal.revision,
    "STALE",
    "Project changed; review this connector action again",
  );
  const reviewed = reviewConnectorChange(root, {
    ...args.proposal.request,
    ...(args.fromGit ? { fromGit: args.fromGit } : {}),
  });
  check(
    reviewed.proposal.fingerprint === args.proposal.fingerprint,
    "STALE",
    "Connector or project changed; review again",
  );
  if (reviewed.install)
    applyPackageInstall(root, {
      proposal: reviewed.install,
      ...(args.fromGit ? { fromGit: args.fromGit } : {}),
    });
  try {
    // Check the whole inventory again: additions, removals and edits invalidate review.
    check(
      portableConnectorInputs(root).fingerprint === reviewed.dependencies,
      "STALE",
      "Portable definitions, discovery or working copies changed; review again",
    );
    if (reviewed.install)
      check(
        readFileSync(fence(root, "packages.lock.yaml"), "utf8") ===
          reviewed.lockAfter,
        "STALE",
        "Installed package lock differs from review",
      );
    const configurationFiles = reviewed.files.filter(
      (f) => !reviewed.install || f.path !== "packages.lock.yaml",
    );
    for (const file of configurationFiles)
      check(
        (existsSync(fence(root, file.path))
          ? readFileSync(fence(root, file.path), "utf8")
          : null) === file.before,
        "STALE",
        "Project changed after installation; review again",
      );
    if (configurationFiles.length)
      apply(
        root,
        preview(
          root,
          Object.fromEntries(configurationFiles.map((f) => [f.path, f.after])),
          reviewedInputs(root, reviewed.dependencies),
        ),
      );
  } catch (error) {
    if (!reviewed.install) throw error;
    // The verified cache/lock may be installed while the registration is unchanged.
    // Never attempt an implicit downgrade or overwrite an intervening authoring edit.
    return {
      changed: false,
      action: args.proposal.request.action,
      reference: args.proposal.request.reference,
      registration: reviewed.registration,
      outcome: "installed-not-applied",
      recovery:
        "Candidate installed, but registration was not confirmed. Refresh the connector inventory and review again. Saved ingestion settings are preserved.",
    };
  }
  return {
    changed: true,
    action: args.proposal.request.action,
    reference: args.proposal.request.reference,
    registration: reviewed.registration,
  };
}

function reviewedInputs(root: string, expected: string) {
  const inputs = portableConnectorInputs(root);
  check(
    inputs.fingerprint === expected,
    "STALE",
    "Portable consumers changed; review again",
  );
  return inputs.files;
}
export function inspectConnectorLibrary(root: string) {
  const library = inspectPackageLibrary(root);
  return {
    ...library,
    packages: library.packages.map((p) =>
      p.kind === "connector"
        ? { ...p, ...connectorUsage(root, p.reference) }
        : p,
    ),
  };
}
