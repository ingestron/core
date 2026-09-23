import { connectorPackageSchema } from "./connector-package.js";
import { reportPackSchema } from "./report-pack-schema.js";
import { validateModelPack } from "./model-pack-schema.js";
/** Explicit Git installation. Generation only reads integrity-checked cached text. */
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  realpathSync,
  lstatSync,
  renameSync,
  openSync,
  closeSync,
} from "node:fs";
import { resolve, relative, dirname, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";
import { check, digest, canonical, Problem } from "./errors.js";
import {
  gitTags,
  taggedVersions,
  packageGitEnvironment,
} from "./package-references.js";
const platform = z.string().regex(/^[a-z][a-z0-9-]*$/);
export const externalActivitySchema = z
  .object({
    apiVersion: z.literal("ingestron.activity/v1"),
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    version: z.string().regex(/^(?:0|[1-9]\d*)\.\d+\.\d+$/),
    description: z.string(),
    platform,
    input: z.enum(["source", "files", "relation", "committed"]),
    output: z.enum(["files", "relation", "committed"]),
    effect: z.enum(["read", "stage", "commit", "control"]),
    capabilities: z.array(z.string()).default([]),
    optionsSchema: z.record(z.string(), z.unknown()),
    generator: z
      .object({
        kind: z.enum(["native-notebook", "native-pipeline", "native-project"]),
        artifactKind: platform.optional(),
        execution: platform.optional(),
        persistence: z.enum(["capture", "ephemeral", "durable"]).optional(),
        runtime: z.string().optional(),
        code: z.string().optional(),
        scope: z.enum(["table", "collection"]).default("table"),
        modes: z
          .array(z.enum(["table", "collection"]))
          .min(1)
          .default(["table"]),
        groupBy: z
          .array(z.string().regex(/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/))
          .default([]),
        dependencyOptions: z
          .record(
            z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
            z.string().regex(/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/),
          )
          .default({}),
        entrypoint: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .default("run"),
      })
      .strict()
      .optional(),
    requirements: z
      .object({
        execution: z.string().min(1),
        features: z.array(z.string()).default([]),
        sourceKinds: z.array(z.string()).optional(),
        evidence: z.literal("offline"),
      })
      .strict()
      .optional(),
    templates: z
      .array(
        z
          .object({
            source: z.string(),
            output: z.string(),
            format: z.enum(["python", "sql", "json", "yaml", "text"]),
          })
          .strict(),
      )
      .default([]),
    dependencies: z
      .record(
        z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
        z.string().regex(/^\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/),
      )
      .default({}),
  })
  .strict();
export type ExternalActivity = z.infer<typeof externalActivitySchema>;
export const providerPackageSchema = z
  .object({
    apiVersion: z.literal("ingestron.provider/v1"),
    id: z.string(),
    version: z.string().regex(/^(?:0|[1-9]\d*)\.\d+\.\d+$/),
    platform,
    activities: z.record(z.string(), z.string()),
    capabilities: z
      .object({
        artifactKinds: z.array(platform).min(1),
        delivery: z.boolean().default(false),
        handovers: z.array(z.enum(["files", "relation"])).default([]),
        packContracts: z
          .record(
            platform,
            z
              .object({
                version: z.string().regex(/^\d+\.\d+\.\d+$/),
                activities: z.array(platform).min(1),
              })
              .strict(),
          )
          .default({}),
      })
      .strict()
      .optional(),
    projectAssembly: z
      .object({
        apiVersion: z.literal("ingestron.project-assembly/v1"),
        command: z.string().min(1),
      })
      .strict()
      .optional(),
    connectorRuntimes: z
      .record(
        z.string(),
        z
          .object({
            selectionSchema: z.record(z.string(), z.unknown()),
            executionSchema: z.record(z.string(), z.unknown()),
            prepareCommand: z.string(),
            contractsCommand: z.string().optional(),
            executionPlatforms: z.array(z.string()).min(1),
          })
          .strict(),
      )
      .optional(),
    configurationSchema: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .optional(),
    standards: z
      .array(
        z
          .object({
            id: z.string(),
            description: z.string(),
            sourceKinds: z.array(z.string()).optional(),
            dataFlow: z.enum(["forbidden", "required"]).optional(),
          })
          .strict(),
      )
      .optional(),
    compatibility: z
      .object({
        plan: z.literal("ingestron.plan/v1"),
        requiredFeatures: z.array(platform).default([]),
        minimumCli: z.string().regex(/^\d+\.\d+\.\d+$/),
      })
      .strict()
      .optional(),
    outputSchemas: z.record(z.string(), z.string()).optional(),
    lifecycle: z
      .object({
        apiVersion: z.literal("ingestron.provider-lifecycle/v1"),
        module: z.string(),
      })
      .strict()
      .optional(),
    planner: z
      .object({
        apiVersion: z.literal("ingestron.provider-planning/v1"),
        module: z.string(),
      })
      .strict()
      .optional(),
    commands: z
      .object({
        apiVersion: z.literal("ingestron.provider-commands/v1"),
        namespace: z
          .string()
          .regex(/^[a-z][a-z0-9-]*$/)
          .optional(),
        execution: z.literal("offline-json"),
        module: z.string(),
        definitions: z
          .array(
            z
              .object({
                name: z.string().regex(/^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$/),
                description: z.string().min(1).max(500),
                reportPack: z.boolean().optional(),
                examples: z.array(z.string().max(500)).max(10).optional(),
                resultSchema: z.record(z.string(), z.unknown()).optional(),
                inputSchema: z.record(z.string(), z.unknown()),
              })
              .strict(),
          )
          .min(1)
          .max(50)
          .refine(
            (items) => new Set(items.map((i) => i.name)).size === items.length,
            "Duplicate provider command",
          ),
      })
      .strict()
      .optional(),
    execution: z
      .object({
        apiVersion: z.literal("ingestron.execution/v1"),
        transport: z.string().min(1),
        entryPoint: z.string().min(1),
        actions: z
          .array(z.enum(["prepare", "discover", "review", "approve", "run"]))
          .min(1),
        status: z.literal("receipt"),
        retry: z.literal("same-run-id"),
        cancellation: z.literal("interrupt"),
      })
      .strict()
      .optional(),
    renderer: z
      .object({
        apiVersion: z.literal("ingestron.provider-generation/v1"),
        module: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
/** Data-only presets: no modules, nested dependencies or renderer replacement. */
export const extensionPackSchema = z
  .object({
    apiVersion: z.literal("ingestron.extension-pack/v1"),
    id: platform,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1),
    extends: z
      .object({
        provider: z.string().min(1),
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
        platform,
        contract: platform,
        contractVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
      })
      .strict(),
    activities: z
      .record(
        platform,
        z
          .object({
            uses: platform,
            with: z.record(z.string(), z.unknown()).default({}),
          })
          .strict(),
      )
      .refine(
        (value) => Object.keys(value).length > 0,
        "Pack must export activities",
      ),
  })
  .strict();
const lockSchema = z
  .object({
    apiVersion: z.literal("ingestron.packages-lock/v1"),
    packages: z.record(
      z.string(),
      z
        .object({
          repository: z.string(),
          path: z.string(),
          commit: z.string().regex(/^[a-f0-9]{40}$/),
          files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
        })
        .strict(),
    ),
  })
  .strict();
export function fence(root: string, name: string) {
  check(
    !isAbsolute(name) &&
      !name.includes("\\") &&
      name.split("/").every((p) => p && ![".", ".."].includes(p)),
    "PATH",
    `Unsafe package path ${name}`,
  );
  const target = resolve(root, name);
  let current = root;
  for (const part of name.split("/")) {
    current = resolve(current, part);
    check(
      !existsSync(current) || !lstatSync(current).isSymbolicLink(),
      "PATH",
      "Package symlinks are forbidden",
    );
  }
  return target;
}
export function packageYaml(file: string) {
  const text = readFileSync(file, "utf8");
  check(
    Buffer.byteLength(text) < 2 * 1024 * 1024,
    "LIMIT",
    "Package YAML exceeds 2 MiB",
  );
  const doc = parseDocument(text, { uniqueKeys: true });
  check(
    !doc.errors.length,
    "YAML",
    doc.errors[0]?.message ?? "Invalid package YAML",
    file,
  );
  const value = doc.toJS({ maxAliasCount: 20 });
  const walk = (v: any, depth = 0) => {
    check(depth <= 64, "LIMIT", "Package structure exceeds 64 levels");
    if (v && typeof v === "object")
      for (const [k, c] of Object.entries(v)) {
        check(
          !["__proto__", "constructor", "prototype"].includes(k),
          "KEY",
          "Unsafe package key",
        );
        walk(c, depth + 1);
      }
  };
  walk(value);
  return value;
}
/** Stable convenience names; locks always retain the explicit repository and path. */
export function canonicalPackageReference(reference: string): string {
  reference = reference.replace(/@v((?:0|[1-9]\d*)\.\d+\.\d+)$/, "@$1");
  const short = /^([\w.-]+(?:\/[\w.-]+)?)@([^@]+)$/.exec(reference);
  if (!short) return reference;
  const repository = short[1];
  check(
    repository.includes("/"),
    "PACKAGE",
    "Unknown plugin name; use an explicit owner/repository@version",
  );
  return `${repository}/plugin/provider.yaml@${short[2]}`;
}
export function configuredPackageReference(pkg: {
  source: string;
  version: string;
}) {
  const reference = `${pkg.source}@${pkg.version}`;
  return /^[a-z][a-z0-9-]*@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(
    reference,
  )
    ? reference
    : canonicalPackageReference(reference);
}
const parseReference = (reference: string) => {
  check(
    !reference.endsWith("@latest"),
    "PACKAGE",
    "@latest is not supported: packages must be pinned to an exact semantic version or commit. Use plugin_versions with an explicit repository to inspect available versions.",
  );
  const m =
    /^([\w.-]+\/[\w.-]+)\/(.+\.ya?ml)@(v1|(?:0|[1-9]\d*)\.\d+\.\d+|[a-f0-9]{40})$/.exec(
      reference,
    );
  check(
    m && !m[1].includes(".."),
    "PACKAGE",
    "Use owner/repository@1.2.3 or owner/repository/path/manifest.yaml@commit; legacy v1 tags are also accepted",
  );
  fence("/package", m[2]);
  return { repository: m[1], path: m[2], ref: m[3] };
};
const inventory = (root: string, dir = root): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      check(!e.isSymbolicLink(), "PATH", "Package symlinks are forbidden");
      return e.isDirectory()
        ? inventory(root, resolve(dir, e.name))
        : [relative(root, resolve(dir, e.name))];
    })
    .sort();
export function packageLock(root: string) {
  const file = resolve(root, "packages.lock.yaml");
  check(
    !existsSync(file) || !lstatSync(file).isSymbolicLink(),
    "PATH",
    "Package lock cannot be a symlink",
  );
  return existsSync(file)
    ? lockSchema.parse(packageYaml(file))
    : {
        apiVersion: "ingestron.packages-lock/v1" as const,
        packages: {} as z.infer<typeof lockSchema>["packages"],
      };
}
export function resolvePackage(root: string, reference: string) {
  if (
    /^[a-z][a-z0-9-]*@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(
      reference,
    )
  ) {
    const [name, version] = reference.split("@");
    const matches = Object.keys(packageLock(root).packages).filter(
      (lockedReference) => {
        const installed = resolvePackage(root, lockedReference);
        const manifest = packageYaml(installed.file);
        return manifest.id === name && manifest.version === version;
      },
    );
    check(
      matches.length === 1,
      "PACKAGE",
      matches.length
        ? `Ambiguous installed package ${reference}; use an explicit reference`
        : `Install ${reference} before building this project`,
    );
    return resolvePackage(root, matches[0]);
  }
  reference = canonicalPackageReference(reference);
  const parsed = parseReference(reference),
    entry = packageLock(root).packages[reference];
  check(
    entry &&
      entry.repository === parsed.repository &&
      entry.path === parsed.path,
    "PACKAGE",
    `Install locked package ${reference} using packages_install`,
  );
  if (/^[a-f0-9]{40}$/.test(parsed.ref))
    check(
      entry.commit === parsed.ref,
      "PACKAGE",
      "Lock commit differs from selected reference",
    );
  const cache = fence(
    root,
    `.ingestron/packages/${digest(entry.repository)}/${entry.commit}`,
  );
  check(existsSync(cache), "PACKAGE", `Package cache missing for ${reference}`);
  check(
    canonical(inventory(cache)) === canonical(Object.keys(entry.files).sort()),
    "PACKAGE",
    "Package file inventory changed",
  );
  for (const [file, hash] of Object.entries(entry.files))
    check(
      digest(readFileSync(fence(cache, file))) === hash,
      "PACKAGE",
      `Package integrity failed: ${file}`,
    );
  return { file: fence(cache, entry.path), root: cache, entry };
}
/** Derived information lives outside the integrity-checked source cache. */
export function savePluginInformation(root: string, reference: string) {
  const source = resolvePackage(root, reference);
  const manifest = packageYaml(source.file);
  const connector =
    manifest.apiVersion === "ingestron.connector/v1"
      ? connectorPackageSchema.parse(manifest)
      : undefined;
  const documents = Object.keys(source.entry.files)
    .filter(
      (name) =>
        name === connector?.upstream.licenceFile ||
        /(?:^|\/)(?:licen[cs]e|copying|notice|copyright|third[-_]party[-_]notices?)(?:[._-].*)?$/i.test(
          name,
        ),
    )
    .sort()
    .map((path) => ({
      path,
      sha256: source.entry.files[path],
      text: readFileSync(fence(source.root, path), "utf8"),
    }));
  let declaredLicence: string | null = null;
  if (source.entry.files["package.json"]) {
    try {
      const metadata = JSON.parse(
        readFileSync(fence(source.root, "package.json"), "utf8"),
      );
      if (typeof metadata.license === "string")
        declaredLicence = metadata.license;
    } catch {
      /* Optional upstream metadata is not a licence determination. */
    }
  }
  const file = `.ingestron/plugin-info/${digest(reference)}.json`;
  const target = fence(root, file);
  mkdirSync(dirname(target), { recursive: true });
  const information = {
    apiVersion: "ingestron.plugin-information/v1",
    reference,
    id: manifest.id,
    version: manifest.version,
    kind: manifest.apiVersion,
    repository: source.entry.repository,
    commit: source.entry.commit,
    manifest: source.entry.path,
    sourceDocumentation: `https://github.com/${source.entry.repository}/tree/${source.entry.commit}`,
    ...(connector
      ? {
          upstream: connector.upstream,
          execution: connector.execution,
          upstreamDocumentation: connector.documentation,
        }
      : {}),
    declaredLicence,
    licenceDocuments: documents,
    licenceReview:
      "Not assessed: retained upstream evidence is not permission or a complete dependency licence audit. Review the selected connector and its dependencies before customer-operated use or redistribution.",
  };
  const temporary = fence(root, `${file}.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(information, null, 2) + "\n", {
    flag: "wx",
  });
  try {
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return file;
}
export function installPackage(
  root: string,
  reference: string,
  options: {
    fromGit?: string;
    update?: boolean;
    frozen?: boolean;
    tagPrefix?: string;
    kind?: "provider" | "connector";
  } = {},
) {
  root = realpathSync(root);
  reference = canonicalPackageReference(reference);
  const parsed = parseReference(reference),
    lock = packageLock(root);
  const previous = lock.packages[reference];
  check(
    !(options.update && options.frozen),
    "PACKAGE",
    "Frozen install cannot update packages",
  );
  check(
    !options.frozen || previous,
    "PACKAGE",
    "Frozen install requires an existing lock entry",
  );
  if (
    previous &&
    !options.update &&
    existsSync(
      resolve(
        root,
        `.ingestron/packages/${digest(previous.repository)}/${previous.commit}`,
      ),
    )
  ) {
    if (options.kind) {
      const installed = resolvePackage(root, reference);
      const manifest = packageYaml(installed.file);
      check(
        manifest.apiVersion === `ingestron.${options.kind}/v1`,
        "PACKAGE",
        `Expected a ${options.kind} package at ${reference}`,
      );
    }
    return {
      reference,
      ...resolvePackage(root, reference).entry,
      cached: true,
      informationFile: savePluginInformation(root, reference),
    };
  }
  const control = fence(root, ".ingestron");
  mkdirSync(control, { recursive: true });
  const guard = resolve(control, "package-install.lock");
  let fd: number;
  try {
    fd = openSync(guard, "wx");
  } catch {
    throw new Problem("CONFLICT", "Another package install is running");
  }
  const temp = mkdtempSync(resolve(tmpdir(), "ingestron-package-"));
  try {
    const git = (args: string[], cwd: string) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: 60000,
        maxBuffer: 12 * 1024 * 1024,
        env: packageGitEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    const repo = options.fromGit
        ? realpathSync(options.fromGit)
        : resolve(temp, "git"),
      requested = previous && !options.update ? previous.commit : parsed.ref;
    let gitRef = requested;
    if (/^(?:0|[1-9]\d*)\.\d+\.\d+$/.test(requested)) {
      const tag = taggedVersions(
        gitTags(parsed.repository, options.fromGit ? repo : undefined),
        options.tagPrefix,
      ).find((v) => v.version === requested);
      check(
        tag,
        "PACKAGE",
        `No version ${requested} found; use plugin versions ${parsed.repository}`,
      );
      check(
        !tag.ambiguous,
        "PACKAGE",
        `Tags ${requested} and v${requested} point to different commits; select an explicit commit instead`,
      );
      gitRef = tag.commit;
    }
    if (!options.fromGit) {
      mkdirSync(repo);
      git(["init", "--quiet"], repo);
      git(
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "credential.helper=!gh auth git-credential",
          "fetch",
          "--quiet",
          "--depth=1",
          `https://github.com/${parsed.repository}.git`,
          gitRef,
        ],
        repo,
      );
    }
    const commit = git(
      [
        "rev-parse",
        "--verify",
        `${options.fromGit ? gitRef : "FETCH_HEAD"}^{commit}`,
      ],
      repo,
    ).trim();
    check(/^[a-f0-9]{40}$/.test(commit), "PACKAGE", "Invalid Git commit");
    if (/^[a-f0-9]{40}$/.test(gitRef))
      check(commit === gitRef, "PACKAGE", "Fetched commit mismatch");
    const rows = git(["ls-tree", "-r", "-l", "-z", commit], repo)
      .split("\0")
      .filter(Boolean);
    check(rows.length <= 1024, "LIMIT", "Package exceeds 1024 files");
    const staged = resolve(temp, "source");
    mkdirSync(staged);
    const files: Record<string, string> = {};
    let total = 0;
    for (const row of rows) {
      const m = /^(\d+) (\w+) ([a-f0-9]+)\s+(\d+)\t(.+)$/.exec(row);
      check(
        m && ["100644", "100755"].includes(m[1]) && m[2] === "blob",
        "PACKAGE",
        "Symlinks/submodules are forbidden",
      );
      const size = +m[4];
      total += size;
      check(
        size <= 2 * 1024 * 1024 && total <= 10 * 1024 * 1024,
        "LIMIT",
        "Package exceeds text limits",
      );
      const text = git(["cat-file", "blob", m[3]], repo);
      check(
        !text.includes("\0") &&
          !text.includes("\uFFFD") &&
          Buffer.byteLength(text) === size,
        "PACKAGE",
        "Packages contain UTF-8 text only",
      );
      const dest = fence(staged, m[5]);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, text);
      files[m[5]] = digest(text);
    }
    const manifest = packageYaml(fence(staged, parsed.path));
    if (options.kind)
      check(
        manifest.apiVersion === `ingestron.${options.kind}/v1`,
        "PACKAGE",
        `Expected a ${options.kind} package at ${reference}`,
      );
    if (manifest.apiVersion === "ingestron.connector/v1") {
      const connector = connectorPackageSchema.parse(manifest);
      check(
        connector.upstream.licenceStatus === "evidenced",
        "LICENCE",
        "Connector licence evidence is missing or conflicting; installation held",
      );
      check(
        connector.connector.endsWith("@" + connector.upstream.version),
        "PACKAGE",
        "Connector and upstream version differ",
      );
      const licenceFile = fence(staged, connector.upstream.licenceFile);
      check(
        existsSync(licenceFile) &&
          readFileSync(licenceFile, "utf8").trim().length > 0,
        "LICENCE",
        "Connector licence file is missing or empty",
      );
    } else if (manifest.apiVersion === "ingestron.activity/v1")
      externalActivitySchema.parse(manifest);
    else if (manifest.apiVersion === "ingestron.provider/v1")
      providerPackageSchema.parse(manifest);
    else if (manifest.apiVersion === "ingestron.extension-pack/v3")
      reportPackSchema.parse(manifest);
    else if (manifest.apiVersion === "ingestron.extension-pack/v2")
      validateModelPack(manifest);
    else if (manifest.apiVersion === "ingestron.extension-pack/v1")
      extensionPackSchema.parse(manifest);
    else
      throw new Problem(
        "PACKAGE",
        "Only activity, provider and extension-pack packages are supported",
      );
    if (/^(?:0|[1-9]\d*)\.\d+\.\d+$/.test(parsed.ref))
      check(
        manifest.version === parsed.ref,
        "PACKAGE",
        "Manifest version differs from selected exact version",
      );
    const entry = {
        repository: parsed.repository,
        path: parsed.path,
        commit,
        files,
      },
      dest = fence(
        root,
        `.ingestron/packages/${digest(parsed.repository)}/${commit}`,
      );
    mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(dest)) {
      const staging = dest + `-${process.pid}`;
      mkdirSync(staging);
      try {
        for (const name of Object.keys(files)) {
          const target = fence(staging, name);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, readFileSync(fence(staged, name)));
        }
        renameSync(staging, dest);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    check(
      canonical(inventory(dest)) === canonical(Object.keys(files).sort()),
      "PACKAGE",
      "Existing cached inventory differs",
    );
    for (const [name, hash] of Object.entries(files))
      check(
        digest(readFileSync(fence(dest, name))) === hash,
        "PACKAGE",
        `Existing package cache is modified: ${name}`,
      );
    lock.packages[reference] = entry;
    const temporary = resolve(root, `.packages-${process.pid}.yaml`);
    writeFileSync(temporary, stringify(lock), { flag: "wx" });
    try {
      renameSync(temporary, resolve(root, "packages.lock.yaml"));
    } finally {
      rmSync(temporary, { force: true });
    }
    resolvePackage(root, reference);
    return {
      reference,
      ...entry,
      cached: false,
      informationFile: savePluginInformation(root, reference),
    };
  } finally {
    closeSync(fd!);
    rmSync(guard, { force: true });
    rmSync(temp, { recursive: true, force: true });
  }
}

export function installedProviders(root: string) {
  return Object.keys(packageLock(root).packages).flatMap((reference) => {
    const resolved = resolvePackage(root, reference);
    const manifest = packageYaml(resolved.file);
    if (manifest.apiVersion !== "ingestron.provider/v1") return [];
    return [
      {
        ...providerPackageSchema.parse(manifest),
        reference,
        commit: resolved.entry.commit,
        evidence: "offline",
      },
    ];
  });
}

export function installedActivities(root: string) {
  return installedProviders(root).flatMap((provider) => {
    const source = resolvePackage(root, provider.reference);
    return Object.entries(provider.activities).map(([id, path]) => {
      const file = fence(
        source.root,
        relative(source.root, resolve(dirname(source.file), path)),
      );
      const manifest = externalActivitySchema.parse(packageYaml(file));
      check(
        manifest.id === id && manifest.platform === provider.platform,
        "PACKAGE",
        "Activity export identity or platform differs from provider",
      );
      return {
        id,
        provider: provider.reference,
        version: manifest.version,
        description: manifest.description,
        platforms: [manifest.platform],
        evidence: "offline",
        implementations: [manifest],
      };
    });
  });
}
