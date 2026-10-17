import {
  programmeManifestSchema,
  platformDefinitionSchema,
  platformEnvironmentSchema,
  requirementsDefinitionSchema,
} from "./programme-storage-schema.js";
/** One resolved v1 model over legacy JSON or explicit, bounded v2 YAML documents. */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  parseDocument,
  stringify,
  visit,
  isMap as yamlMap,
  isSeq,
  isAlias,
  isScalar,
} from "yaml";
import { canonical, check, digest } from "./errors.js";
import { programmeSchema, type Programme } from "./programme-schema.js";
import { withWorkItemKeys } from "./programme-keys.js";

export const programmeLimit = 512 * 1024;

function programmeName(name: string) {
  check(
    name.length <= 500 &&
      name.split("/").length <= 10 &&
      !name.includes("\\") &&
      name
        .split("/")
        .every((p) => /^[A-Za-z0-9_.-]+$/.test(p) && p !== "." && p !== ".."),
    "PATH",
    "Programme paths must stay within the registered folder",
  );
}
export function programmePath(root: string, name: string) {
  programmeName(name);
  let current = realpathSync(root);
  for (const part of name.split("/")) {
    current = resolve(current, part);
    try {
      check(
        !lstatSync(current).isSymbolicLink(),
        "PATH",
        "Programme paths cannot cross symbolic links",
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return current;
}
export function programmeBytes(root: string, name: string): string | null {
  const file = programmePath(root, name);
  let stat;
  try {
    stat = lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  check(
    stat.isFile() && stat.size <= programmeLimit,
    "PATH",
    "Programme file must be a bounded regular file",
  );
  const raw = readFileSync(file);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      raw,
    );
  } catch {
    throw Error(
      "Programme definitions require valid UTF-8; original bytes were preserved",
    );
  }
}
export function programmeYaml(raw: string) {
  const parsed = parseDocument(raw, { uniqueKeys: true });
  check(
    !parsed.errors.length,
    "YAML",
    parsed.errors[0]?.message ?? "Invalid programme YAML",
  );
  let nodes = 0;
  visit(parsed, (_, node, path) => {
    check(
      !isAlias(node) && !(node as any)?.anchor && !(node as any)?.tag,
      "YAML",
      "Programme YAML aliases, anchors and explicit tags are not supported",
    );
    check(
      ++nodes <= 50000 && path.length <= 50,
      "LIMIT",
      "Programme YAML exceeds structural limits",
    );
  });
  return parsed;
}
export interface ProgrammeStorage {
  format: "missing" | "json" | "yaml";
  document: Programme | null;
  digest: string | null;
  files: Record<string, string>;
  requirements?: string;
  platforms: Map<string, { file: string; profiles: Map<string, string> }>;
}
export function loadProgrammeStorage(
  root: string,
  id: string,
): ProgrammeStorage {
  root = realpathSync(root);
  const json = programmeBytes(root, "programme.json"),
    yaml = programmeBytes(root, "programme.yaml");
  check(
    programmeBytes(root, "programme.yml") === null,
    "AMBIGUOUS",
    "Use programme.yaml; programme.yml cannot be an additional programme authority",
  );
  check(
    json === null || yaml === null,
    "AMBIGUOUS",
    "Both programme.json and programme.yaml exist; review migration or rollback before continuing",
  );
  const result: ProgrammeStorage = {
    format: "missing",
    document: null,
    digest: null,
    files: {},
    platforms: new Map(),
  };
  if (json === null && yaml === null) return result;
  let input: unknown;
  if (json !== null) {
    result.format = "json";
    result.files["programme.json"] = json;
    result.digest = digest(json);
    input = JSON.parse(json);
    programmeYaml(json); // Reject duplicate keys before converting legacy JSON.
  } else {
    result.format = "yaml";
    const identities = new Set<string>();
    let total = 0;
    const read = (name: string) => {
      check(
        Object.keys(result.files).length < 6400 &&
          !Object.hasOwn(result.files, name),
        "REFERENCE",
        "Duplicate or cyclic programme definition reference",
      );
      const raw = programmeBytes(root, name);
      check(raw !== null, "REFERENCE", `Missing programme definition: ${name}`);
      const stat = lstatSync(programmePath(root, name)),
        identity = `${stat.dev}:${stat.ino}`;
      check(
        !identities.has(identity),
        "REFERENCE",
        "Duplicate programme definition file",
      );
      identities.add(identity);
      total += Buffer.byteLength(raw);
      check(
        total <= programmeLimit,
        "LIMIT",
        "Resolved programme definitions exceed 512 KiB",
      );
      result.files[name] = raw;
      return programmeYaml(raw).toJS({ maxAliasCount: 0 });
    };
    const ref = (from: string, target: string) => {
      check(
        target.startsWith("./"),
        "PATH",
        "Programme references must be explicit local ./ paths",
      );
      const name = relative(
        realpathSync(root),
        resolve(root, dirname(from), target),
      );
      // Reject traversal even when normalisation would land back in the registered root.
      programmeName(target.slice(2));
      programmePath(root, name);
      check(
        /\.yaml$/.test(name),
        "REFERENCE",
        "Programme references must name YAML files",
      );
      return name;
    };
    const manifest = programmeManifestSchema.parse(read("programme.yaml"));
    result.requirements = ref("programme.yaml", manifest.requirements.$resolve);
    const requirements = requirementsDefinitionSchema.parse(
      read(result.requirements),
    ).requirements;
    const platforms = manifest.platforms?.map((reference) => {
      const file = ref("programme.yaml", reference.definition),
        platform = platformDefinitionSchema.parse(read(file));
      check(
        platform.id === reference.id && !result.platforms.has(platform.id),
        "REFERENCE",
        "Platform definition identity differs or is duplicated",
      );
      const profiles = new Map<string, string>();
      result.platforms.set(platform.id, { file, profiles });
      const { apiVersion: _, ...body } = platform;
      return {
        ...body,
        ...(platform.configuration
          ? {
              configuration: {
                ...platform.configuration,
                targets: platform.configuration.targets.map((target) => ({
                  ...target,
                  environments: target.environments.map((reference) => {
                    const name = ref(file, reference.$resolve),
                      profile = platformEnvironmentSchema.parse(read(name));
                    check(
                      profile.provider === target.provider,
                      "REFERENCE",
                      "Environment profile belongs to another target provider",
                    );
                    const key = `${target.provider}/${profile.name}`;
                    check(
                      !profiles.has(key),
                      "REFERENCE",
                      "Duplicate target environment profile",
                    );
                    profiles.set(key, name);
                    const {
                      apiVersion: _,
                      provider: __,
                      ...environment
                    } = profile;
                    return environment;
                  }),
                })),
              },
            }
          : {}),
      };
    });
    input = {
      ...manifest,
      apiVersion: "ingestron.programme/v1",
      requirements,
      ...(platforms ? { platforms } : {}),
    };
    result.digest = digest(
      canonical(
        Object.fromEntries(
          Object.entries(result.files).map(([name, raw]) => [
            name,
            digest(raw),
          ]),
        ),
      ),
    );
  }
  result.document = withWorkItemKeys(programmeSchema.parse(input));
  check(
    result.document.id === id,
    "PROGRAMME",
    "Programme identity does not match the registered folder",
  );
  return result;
}

/** Reconcile existing YAML nodes so unchanged values, comments and ordering survive saves. */
function updateYaml(raw: string | undefined, value: unknown) {
  if (raw === undefined) return stringify(value, { lineWidth: 0 });
  const doc = programmeYaml(raw);
  if (canonical(doc.toJS()) === canonical(value)) return raw;
  const identity = (v: any) =>
    v && typeof v === "object"
      ? (v.id ?? v.name ?? v.provider ?? v.$resolve)
      : undefined;
  const sync = (node: any, next: any): any => {
    if (
      yamlMap(node) &&
      next &&
      typeof next === "object" &&
      !Array.isArray(next)
    ) {
      for (const pair of [...node.items])
        if (!Object.hasOwn(next, String(pair.key)))
          node.delete(String(pair.key));
      for (const [key, item] of Object.entries(next))
        node.set(key, sync(node.get(key, true), item));
      return node;
    }
    if (isSeq(node) && Array.isArray(next)) {
      const old = [...node.items];
      node.items = next.map((item, i) => {
        const key = identity(item);
        return sync(
          key === undefined
            ? old[i]
            : old.find((n: any) => identity(n?.toJSON()) === key),
          item,
        );
      });
      return node;
    }
    if (node && canonical(node.toJSON()) === canonical(next)) return node;
    if (isScalar(node) && (next === null || typeof next !== "object")) {
      node.value = next;
      return node;
    }
    const replacement = doc.createNode(next);
    if (node) {
      replacement.comment = node.comment;
      replacement.commentBefore = node.commentBefore;
      replacement.spaceBefore = node.spaceBefore;
    }
    return replacement;
  };
  doc.contents = sync(doc.contents, value);
  return doc.toString({ lineWidth: 0 });
}
export function programmeYamlFiles(
  document: Programme,
  previous?: ProgrammeStorage,
) {
  const files: Record<string, string> = {},
    names = new Set<string>();
  const put = (name: string, value: unknown) => {
    check(
      !names.has(name.toLowerCase()),
      "REFERENCE",
      "Programme output file names collide",
    );
    names.add(name.toLowerCase());
    files[name] = updateYaml(previous?.files[name], value);
  };
  const requirements = previous?.requirements ?? "planning/requirements.yaml";
  put(requirements, {
    apiVersion: "ingestron.requirements/v1",
    requirements: document.requirements,
  });
  const platforms = document.platforms?.map((platform) => {
    const old = previous?.platforms.get(platform.id),
      file = old?.file ?? `platforms/${platform.id}/platform.yaml`;
    const configuration = platform.configuration
      ? {
          ...platform.configuration,
          targets: platform.configuration.targets.map((target) => ({
            ...target,
            environments: target.environments.map((environment) => {
              const name =
                old?.profiles.get(`${target.provider}/${environment.name}`) ??
                `${dirname(file)}/environments/${target.provider}/${environment.name}.yaml`;
              put(name, {
                apiVersion: "ingestron.platform-environment/v1",
                provider: target.provider,
                ...environment,
              });
              return { $resolve: "./" + relative(dirname(file), name) };
            }),
          })),
        }
      : undefined;
    put(file, {
      apiVersion: "ingestron.platform/v1",
      ...platform,
      ...(configuration ? { configuration } : {}),
    });
    return { id: platform.id, definition: "./" + file };
  });
  put("programme.yaml", {
    ...document,
    apiVersion: "ingestron.programme/v2",
    requirements: { $resolve: "./" + requirements },
    ...(platforms ? { platforms } : {}),
  });
  check(
    Object.values(files).reduce((n, raw) => n + Buffer.byteLength(raw), 0) <=
      programmeLimit,
    "LIMIT",
    "Resolved programme definitions exceed 512 KiB",
  );
  return files;
}
