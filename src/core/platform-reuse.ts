import { relative, resolve } from "node:path";
import { apply, preview, editableProject } from "./authoring.js";
import { withProgrammeWrite } from "./programme-transaction.js";
/** Platform-owned declarations, consumed only through explicit reviewed project changes. */
import { z } from "zod";
import { Configuration } from "./config.js";
import { projectSchema } from "./schema.js";
import { programmeSchema } from "./programme-schema.js";
import { programmeSourceSchema } from "./platform-binding.js";
import {
  programmeLimit,
  loadProgrammeStorage,
  programmeYamlFiles,
} from "./programme-storage.js";
import { readProgramme, saveProgramme } from "./programme.js";
import {
  sharedConnectionSchema,
  sharedPackageSchema,
} from "./platform-reuse-schema.js";
import { browseProviders } from "./installed-plugins.js";
import { projectPackages } from "./project-packages.js";
import {
  configuredPackageReference,
  resolvePackage,
  packageYaml,
} from "./packages.js";
import { connectorPackageSchema } from "./connector-package.js";
import {
  resolveConnectionSettings,
  connectionSecretNames,
} from "./connection-settings.js";
import { auditSecrets } from "./planner.js";
import { check, canonical, digest } from "./errors.js";
const id = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/);
export const platformReuseReadSchema = z
  .object({
    programme: programmeSourceSchema,
    project: z.string().min(1).max(160),
    platform: id,
  })
  .strict();
export const platformReuseReviewSchema = platformReuseReadSchema
  .extend({
    kind: z.enum(["package", "connection"]),
    id,
    name: z.string().trim().min(1).max(200),
    owner: z.string().trim().min(1).max(200),
    purpose: z.string().trim().max(2000),
    consumers: z.array(z.string().min(1).max(160)).min(1).max(100),
    update: z.boolean().default(false),
    reference: z.string().min(1).max(500).optional(),
    connection: id.optional(),
    sharedEnvironment: id.optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      r.kind === "package"
        ? !r.reference ||
          r.connection !== undefined ||
          r.sharedEnvironment !== undefined
        : !r.connection || !r.sharedEnvironment || r.reference !== undefined
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Select an exact package or source connection and shared environment",
      });
  });
export const platformReuseApplySchema = z
  .object({ programme: programmeSourceSchema, review: z.unknown() })
  .strict();
function state(
  root: string,
  environment: string,
  args: z.infer<typeof platformReuseReadSchema>,
) {
  const reader = new Configuration(root, {}),
    project = projectSchema.parse(reader.load());
  check(
    project.environments[environment],
    "ENVIRONMENT",
    "Choose a declared project environment",
  );
  const saved = readProgramme(args.programme.root, args.programme.id);
  check(saved.document, "PROGRAMME", "Save the registered programme first");
  const registered = saved.document.projects.find((p) => p.id === args.project);
  check(
    registered?.compilerId === project.id,
    "PROGRAMME",
    "Register this compiler project before sharing definitions",
  );
  const platform = saved.document.platforms?.find(
    (p) => p.id === args.platform,
  );
  check(platform, "PLATFORM", "Choose a registered platform");
  return {
    reader,
    project,
    saved,
    document: saved.document,
    registered,
    platform,
  };
}
export function inspectPlatformReuse(
  root: string,
  environment: string,
  args: z.infer<typeof platformReuseReadSchema>,
) {
  args = platformReuseReadSchema.parse(args);
  const s = state(root, environment, args);
  const installed = browseProviders(root);
  const connections = Object.entries(s.project.connections).flatMap(
    ([name, c]) => {
      if (!c.package || ["native", "bridge"].includes(c.route ?? "")) return [];
      const pkg = projectPackages(s.project)[c.package];
      if (!pkg) return [];
      return [
        {
          id: name,
          sourceId: c.sourceId,
          tenantId: c.tenantId,
          reference: configuredPackageReference(pkg),
        },
      ];
    },
  );
  return {
    apiVersion: "ingestron.platform-reuse/v1",
    platform: { id: s.platform.id, name: s.platform.name },
    belongs: s.registered.platformId === s.platform.id,
    consumers: s.document.projects
      .filter((p) => p.platformId === s.platform.id)
      .map((p) => ({ id: p.id, name: p.name })),
    packages: (s.platform.reuse?.packages ?? []).map((p) => ({
      ...p,
      installed: installed.some(
        (i) => i.reference === p.reference && i.commit === p.commit,
      ),
      permitted: p.consumers.includes(args.project),
    })),
    connections: (s.platform.reuse?.connections ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      owner: c.owner,
      purpose: c.purpose,
      reference: c.reference,
      commit: c.commit,
      sourceId: c.sourceId,
      tenantId: c.tenantId,
      consumers: c.consumers,
      permitted: c.consumers.includes(args.project),
      installed: installed.some(
        (p) => p.reference === c.reference && p.commit === c.commit,
      ),
      environments: Object.entries(c.environments).map(([name, v]) => ({
        name,
        secretNames: [...connectionSecretNames(v.settings)],
      })),
      digest: digest(canonical(c)),
    })),
    projectPackages: installed.map((p) => ({
      reference: p.reference,
      id: p.id,
      version: p.version,
      kind: p.kind,
      commit: p.commit,
    })),
    projectConnections: connections,
    bindings: Object.values(s.project.sharedConnections ?? {})
      .filter(
        (b) =>
          b.programmeId === args.programme.id && b.platformId === s.platform.id,
      )
      .map((b) => {
        const current = s.platform.reuse?.connections.find(
          (c) => c.id === b.sharedConnection,
        );
        const connection = s.project.connections[b.connection];
        const pkg = projectPackages(s.project)[b.packageAlias];
        return {
          connection: b.connection,
          projectEnvironment: b.projectEnvironment,
          sharedConnection: b.sharedConnection,
          sharedEnvironment: b.sharedEnvironment,
          stale: !current || digest(canonical(current)) !== b.sourceDigest,
          permitted:
            !!current?.consumers.includes(args.project) &&
            s.registered.platformId === s.platform.id,
          intact:
            !!connection &&
            !!pkg &&
            connection.package === b.packageAlias &&
            configuredPackageReference(pkg) === b.reference &&
            connection.binding === b.binding &&
            connection.sourceId === b.materialised.sourceId &&
            connection.tenantId === b.materialised.tenantId &&
            Object.keys(connection.settings).length === 0 &&
            canonical(
              s.project.environments[b.projectEnvironment]?.bindings[b.binding],
            ) === canonical(b.materialised.settings),
        };
      }),
    evidence:
      "Shared definitions and explicit consumer declarations; external source access is not granted or executed.",
  };
}
export function reviewPlatformReuse(
  root: string,
  environment: string,
  args: z.infer<typeof platformReuseReviewSchema>,
) {
  args = platformReuseReviewSchema.parse(args);
  const s = state(root, environment, args);
  check(
    s.registered.platformId === s.platform.id,
    "PLATFORM",
    "Select a project belonging to this shared platform before promoting its definitions",
  );
  const document = structuredClone(s.document);
  const platform = document.platforms!.find((p) => p.id === s.platform.id)!;
  platform.reuse ??= { packages: [], connections: [] };
  const common = {
    id: args.id,
    name: args.name,
    owner: args.owner,
    purpose: args.purpose,
    consumers: args.consumers,
  };
  if (args.kind === "package") {
    const selected = browseProviders(root).find(
      (p) => p.reference === args.reference,
    );
    check(selected, "PACKAGE", "Choose an exact installed package");
    const old = platform.reuse.packages.findIndex((p) => p.id === args.id);
    check(
      args.update ? old >= 0 : old < 0,
      "OWNER",
      "Choose a new shared package ID or explicitly update the existing definition",
    );
    const entry = sharedPackageSchema.parse({
      ...common,
      reference: selected.reference,
      commit: selected.commit,
      kind: selected.kind,
      packageId: selected.id,
      version: selected.version,
    });
    if (old >= 0) platform.reuse.packages[old] = entry;
    else platform.reuse.packages.push(entry);
  } else {
    const c = s.project.connections[args.connection!];
    check(
      c?.package && !["native", "bridge"].includes(c.route ?? ""),
      "CONNECTION",
      "Choose a portable connector connection",
    );
    const pkg = projectPackages(s.project)[c.package];
    check(pkg, "PACKAGE", "Choose its configured package");
    const reference = configuredPackageReference(pkg),
      source = resolvePackage(root, reference);
    const manifest = connectorPackageSchema.parse(packageYaml(source.file));
    check(
      manifest.upstream.licenceStatus === "evidenced",
      "LICENCE",
      "Connector licence evidence is unresolved",
    );
    const old = platform.reuse.connections.findIndex((p) => p.id === args.id);
    check(
      args.update ? old >= 0 : old < 0,
      "OWNER",
      "Choose a new shared connection ID or explicitly update the existing definition",
    );
    const settings = resolveConnectionSettings(
      s.reader,
      s.project,
      environment,
      c,
      manifest.definition.settingsSchema,
    );
    auditSecrets(settings, "settings");
    const entry = sharedConnectionSchema.parse({
      ...common,
      reference,
      commit: source.entry.commit,
      sourceId: c.sourceId,
      tenantId: c.tenantId,
      environments: {
        ...(old >= 0 ? platform.reuse.connections[old].environments : {}),
        [args.sharedEnvironment!]: { settings },
      },
    });
    // A connector upgrade must still validate all saved environment variants.
    for (const variant of Object.values(entry.environments))
      resolveConnectionSettings(
        s.reader,
        s.project,
        environment,
        {
          package: c.package,
          sourceId: entry.sourceId,
          tenantId: entry.tenantId,
          settings: variant.settings,
        },
        manifest.definition.settingsSchema,
      );
    if (old >= 0) platform.reuse.connections[old] = entry;
    else platform.reuse.connections.push(entry);
  }
  const valid = programmeSchema.parse(document),
    storage = loadProgrammeStorage(args.programme.root, args.programme.id);
  check(
    storage.digest === s.saved.digest,
    "STALE",
    "Programme changed during review",
  );
  const files =
    storage.format === "yaml"
      ? programmeYamlFiles(valid, storage)
      : { "programme.json": JSON.stringify(valid, null, 2) + "\n" };
  check(
    Object.values(files).reduce((n, raw) => n + Buffer.byteLength(raw), 0) <=
      programmeLimit,
    "LIMIT",
    "Programme document exceeds 512 KiB",
  );
  const changes = Object.entries(files)
    .filter(([path, after]) => storage.files[path] !== after)
    .map(([path, after]) => ({
      path,
      before: storage.files[path] ?? null,
      after,
    }));
  return {
    apiVersion: "ingestron.platform-reuse-review/v1",
    request: args,
    environment,
    sourceDigest: s.saved.digest,
    document: valid,
    files: changes,
    evidence:
      "Save a platform-owned declaration; no installation, source execution or deployment.",
  };
}
export function applyPlatformReuse(
  root: string,
  programme: z.infer<typeof programmeSourceSchema>,
  review: unknown,
) {
  const parsed = z
    .object({
      apiVersion: z.literal("ingestron.platform-reuse-review/v1"),
      request: platformReuseReviewSchema,
      environment: id,
    })
    .passthrough()
    .parse(review);
  check(
    canonical(parsed.request.programme) === canonical(programme),
    "PROPOSAL",
    "Shared definition review belongs to another programme",
  );
  const fresh = reviewPlatformReuse(root, parsed.environment, parsed.request);
  check(
    canonical(fresh) === canonical(review),
    "STALE",
    "Project or platform changed after review; review the shared definition again",
  );
  const result = saveProgramme(
    programme.root,
    programme.id,
    fresh.sourceDigest,
    fresh.document,
  );
  return { saved: true, digest: result.digest, id: parsed.request.id };
}

export const sharedConnectionReviewSchema = platformReuseReadSchema
  .extend({
    sharedConnection: id,
    sharedEnvironment: id,
    connection: id.refine(
      (v) => v.length <= 71,
      "Connection name must leave room for its shared binding suffix",
    ),
  })
  .strict();
export const sharedConnectionApplySchema = z
  .object({ programme: programmeSourceSchema, review: z.unknown() })
  .strict();
export function reviewSharedConnection(
  root: string,
  environment: string,
  args: z.infer<typeof sharedConnectionReviewSchema>,
) {
  args = sharedConnectionReviewSchema.parse(args);
  const s = state(root, environment, args);
  const shared = s.platform.reuse?.connections.find(
    (c) => c.id === args.sharedConnection,
  );
  check(
    shared &&
      s.registered.platformId === s.platform.id &&
      shared.consumers.includes(args.project),
    "CONSUMER",
    "This project is not a permitted consumer of the shared connection",
  );
  const variant = shared.environments[args.sharedEnvironment];
  check(variant, "ENVIRONMENT", "Choose a saved shared connection environment");
  const installed = resolvePackage(root, shared.reference);
  check(
    installed.entry.commit === shared.commit,
    "PACKAGE",
    "Install the exact shared connector version and commit before reviewing its use",
  );
  const manifest = connectorPackageSchema.parse(packageYaml(installed.file));
  check(
    manifest.upstream.licenceStatus === "evidenced",
    "LICENCE",
    "Connector licence evidence is unresolved",
  );
  auditSecrets(s.project.connections, "connections");
  auditSecrets(s.project.environments, "environments");
  const record = `${environment}:${args.connection}`,
    current = s.project.connections[args.connection];
  const bindings = Object.values(s.project.sharedConnections ?? {}).filter(
    (b) => b.connection === args.connection,
  );
  const existing = s.project.sharedConnections?.[record];
  const binding = args.connection + "_shared";
  const pkgEntries = Object.entries(projectPackages(s.project));
  const alias =
    bindings[0]?.packageAlias ??
    pkgEntries.find(
      ([, p]) => configuredPackageReference(p) === shared.reference,
    )?.[0] ??
    args.connection + "_package";
  if (current) {
    check(
      bindings.length > 0 &&
        bindings.every(
          (b) =>
            b.programmeId === args.programme.id &&
            b.platformId === args.platform &&
            b.sharedConnection === shared.id &&
            b.packageAlias === alias &&
            b.binding === binding,
        ),
      "OWNER",
      "An existing project connection has a different owner; choose a new project connection name",
    );
    check(
      current.package === alias &&
        current.binding === binding &&
        Object.keys(current.settings).length === 0 &&
        !current.bridge &&
        (!current.route || current.route === "portable"),
      "OWNER",
      "Project connection changed outside its shared binding; preserve it and choose a new name",
    );
    check(
      bindings.every(
        (b) =>
          current.sourceId === b.materialised.sourceId &&
          current.tenantId === b.materialised.tenantId,
      ),
      "OWNER",
      "Project connection identity changed outside its reviewed binding",
    );
    check(
      bindings.every(
        (b) =>
          canonical(
            s.project.environments[b.projectEnvironment]?.bindings[binding],
          ) === canonical(b.materialised.settings),
      ),
      "OWNER",
      "Project shared settings changed locally; preserve them and choose a new connection name",
    );
    check(
      bindings
        .filter((b) => b.projectEnvironment !== environment)
        .every(
          (b) =>
            b.reference === shared.reference &&
            b.materialised.sourceId === shared.sourceId &&
            b.materialised.tenantId === shared.tenantId,
        ),
      "OWNER",
      "Other environments use this connection identity or package; use a new connection name for this upgrade",
    );
  } else
    check(
      !bindings.length,
      "OWNER",
      "Restore the recorded shared connection or choose a new name",
    );
  const pkg = projectPackages(s.project)[alias];
  check(
    !pkg || configuredPackageReference(pkg) === shared.reference,
    "OWNER",
    "Package alias is owned by another reference; choose a new connection name",
  );
  check(
    existing ||
      !Object.hasOwn(s.project.environments[environment].bindings, binding),
    "OWNER",
    "Environment binding already exists; choose a new connection name",
  );
  check(
    !Object.entries(s.project.connections).some(
      ([name, c]) => name !== args.connection && c.binding === binding,
    ),
    "OWNER",
    "Another connection uses this environment binding",
  );
  const projected = structuredClone(s.project);
  projected.environments[environment].bindings[binding] = variant.settings;
  const connection = {
    package: alias,
    binding,
    sourceId: shared.sourceId,
    tenantId: shared.tenantId,
    settings: {},
  };
  resolveConnectionSettings(
    s.reader,
    projected,
    environment,
    connection,
    manifest.definition.settingsSchema,
  );
  const workspace = editableProject(root),
    changed = new Set<string>();
  const set = (prefix: string[], value: unknown) => {
    const target = workspace.location({ file: workspace.projectFile, prefix });
    workspace.document(target.file).setIn(target.prefix, value);
    changed.add(target.file);
  };
  if (!pkg) set(["packages", alias], shared.reference);
  set(["connections", args.connection], connection);
  set(["environments", environment, "bindings", binding], variant.settings);
  set(["sharedConnections", record], {
    programmeId: args.programme.id,
    platformId: args.platform,
    sharedConnection: shared.id,
    sharedEnvironment: args.sharedEnvironment,
    projectEnvironment: environment,
    connection: args.connection,
    packageAlias: alias,
    binding,
    sourceDigest: digest(canonical(shared)),
    reference: shared.reference,
    commit: shared.commit,
    materialised: {
      sourceId: shared.sourceId,
      tenantId: shared.tenantId,
      settings: variant.settings,
    },
  });
  const inputs = { ...s.reader.files, ...workspace.reader.files };
  for (const [name, sha256] of Object.entries(installed.entry.files))
    inputs[relative(s.reader.root, resolve(installed.root, name))] = sha256;
  check(
    Object.keys(inputs).length <= 1001,
    "LIMIT",
    "Shared connection inputs exceed the supported review bound",
  );
  return {
    apiVersion: "ingestron.shared-connection-review/v1",
    request: args,
    environment,
    sourceDigest: s.saved.digest,
    proposal: preview(
      root,
      Object.fromEntries(
        [...changed].map((file) => [
          relative(workspace.reader.root, file),
          workspace.document(file).toString(),
        ]),
      ),
      inputs,
    ),
    connection: args.connection,
    evidence:
      "Materialise reviewed shared settings in this project environment. The platform and other projects are unchanged; source access is a separate action.",
  };
}
export function applySharedConnection(
  root: string,
  programme: z.infer<typeof programmeSourceSchema>,
  review: unknown,
) {
  const parsed = z
    .object({
      apiVersion: z.literal("ingestron.shared-connection-review/v1"),
      request: sharedConnectionReviewSchema,
      environment: id,
    })
    .passthrough()
    .parse(review);
  check(
    canonical(parsed.request.programme) === canonical(programme),
    "PROPOSAL",
    "Shared connection review belongs to another programme",
  );
  return withProgrammeWrite(programme.root, () => {
    const fresh = reviewSharedConnection(
      root,
      parsed.environment,
      parsed.request,
    );
    check(
      canonical(fresh) === canonical(review),
      "STALE",
      "Project or shared connection changed after review; review again",
    );
    return apply(root, fresh.proposal);
  });
}
