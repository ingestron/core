import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve, isAbsolute } from "node:path";
import { parseDocument, LineCounter } from "yaml";
import { z } from "zod";
import { check, Problem, digest, isMap } from "./errors.js";
export type Location = {
  file: string;
  pointer: string;
  line: number;
  column: number;
};
export class Configuration {
  readonly root: string;
  readonly files: Record<string, string> = {};
  readonly locations = new WeakMap<object, Location>();
  readonly inputs: Record<string, string> = {};
  readonly pending: { name: string; file?: string; pointer?: string }[] = [];
  private bytes = 0;
  private nodes = 0;
  private documents = new Map<string, any>();
  constructor(
    root: string,
    readonly environmentVariables: Record<
      string,
      string | undefined
    > = process.env,
  ) {
    this.root = realpathSync(root);
  }
  path(name: string, from = resolve(this.root, "project.yaml")) {
    let file: string;
    try {
      file = realpathSync(resolve(dirname(from), name));
    } catch {
      throw new Problem("FILE", `Missing file: ${name}`, from);
    }
    const rel = relative(this.root, file);
    check(
      rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel),
      "PATH",
      "Reference leaves the project",
      from,
    );
    check(statSync(file).isFile(), "FILE", "Expected a regular file", file);
    return file;
  }
  text(name: string, from?: string) {
    const file = this.path(name, from),
      size = statSync(file).size;
    check(
      size <= 10 * 1024 * 1024,
      "LIMIT",
      "A source file must be at most 10 MiB",
      file,
    );
    if (!Object.hasOwn(this.files, relative(this.root, file)))
      this.bytes += size;
    check(
      this.bytes <= 50 * 1024 * 1024,
      "LIMIT",
      "Project inputs exceed 50 MiB",
      file,
    );
    const value = readFileSync(file, "utf8");
    this.files[relative(this.root, file)] = digest(value);
    return value;
  }
  private document(file: string) {
    if (!this.documents.has(file)) {
      const lines = new LineCounter(),
        doc = parseDocument(this.text(file), {
          uniqueKeys: true,
          lineCounter: lines,
          strict: true,
        });
      check(
        !doc.errors.length && !doc.warnings.length,
        "YAML",
        `${doc.errors[0]?.message ?? doc.warnings[0]?.message}`,
        file,
      );
      let value: any;
      try {
        value = doc.toJS({ maxAliasCount: 50 });
      } catch {
        throw new Problem("LIMIT", "YAML aliases exceed the limit", file);
      }
      this.documents.set(file, { doc, lines, value });
    }
    return this.documents.get(file)!;
  }
  load(
    name = "project.yaml",
    from = resolve(this.root, "project.yaml"),
    stack: string[] = [],
    depth = 0,
  ): any {
    check(depth < 64, "LIMIT", "Includes exceed 64 levels", from);
    check(
      !/^[a-z]+:/i.test(name),
      "REFERENCE",
      "Only local configuration includes are allowed",
      from,
    );
    const index = name.indexOf("#"),
      path = index < 0 ? name : name.slice(0, index);
    let pointer = "";
    try {
      pointer = index < 0 ? "" : decodeURIComponent(name.slice(index + 1));
    } catch {
      throw new Problem("POINTER", "Invalid fragment encoding", from);
    }
    check(
      !pointer || pointer.startsWith("/"),
      "POINTER",
      "Expected a JSON Pointer fragment",
      from,
    );
    const file = path ? this.path(path, from) : from,
      key = file + "#" + pointer;
    check(
      !stack.includes(key),
      "CYCLE",
      `Reference cycle: ${[...stack, key].join(" → ")}`,
      file,
    );
    let value = this.document(file).value;
    for (const token of pointer ? pointer.slice(1).split("/") : []) {
      check(
        !/~(?![01])/.test(token),
        "POINTER",
        "Invalid pointer escape",
        file,
      );
      const part = token.replaceAll("~1", "/").replaceAll("~0", "~");
      check(
        !["__proto__", "constructor", "prototype"].includes(part) &&
          value != null &&
          typeof value === "object" &&
          Object.hasOwn(value, part) &&
          (!Array.isArray(value) || /^(0|[1-9]\d*)$/.test(part)),
        "POINTER",
        `Missing pointer ${pointer}`,
        file,
      );
      value = value[part];
    }
    return this.walk(value, file, pointer, [...stack, key], depth + 1);
  }
  private walk(
    value: any,
    file: string,
    pointer: string,
    stack: string[],
    depth: number,
  ): any {
    check(
      ++this.nodes <= 200000 && depth <= 64,
      "LIMIT",
      "Configuration exceeds structural limits",
      file,
    );
    if (Array.isArray(value))
      return value.map((v, i) =>
        this.walk(v, file, `${pointer}/${i}`, stack, depth + 1),
      );
    if (!isMap(value)) return value;
    for (const key of Object.keys(value))
      check(
        !["__proto__", "constructor", "prototype"].includes(key),
        "KEY",
        "Unsafe mapping key",
        file,
      );
    if (Object.hasOwn(value, "$resolve")) {
      check(
        Object.keys(value).length === 1 && typeof value.$resolve === "string",
        "REFERENCE",
        "$resolve must be the only key",
        file,
      );
      return this.load(value.$resolve, file, stack, depth);
    }
    const out: Record<string, any> = {};
    for (const [key, child] of Object.entries(value)) {
      if (
        ["sqlFile", "pythonFile", "moduleFile"].includes(key) &&
        typeof child === "string"
      ) {
        const target = this.path(child, file);
        this.text(target);
        out[key] = relative(this.root, target);
      } else if (key === "projectDirectory" && typeof child === "string") {
        const target = realpathSync(resolve(dirname(file), child)),
          rel = relative(this.root, target);
        check(
          rel !== ".." &&
            !rel.startsWith("../") &&
            !isAbsolute(rel) &&
            statSync(target).isDirectory(),
          "PATH",
          "Project directory must stay inside the project",
          file,
        );
        out[key] = rel;
      } else if (
        key === "uses" &&
        typeof child === "string" &&
        child.startsWith(".")
      ) {
        const target = this.path(child, file);
        this.text(target);
        out[key] = "./" + relative(this.root, target);
      } else
        out[key] = this.walk(
          child,
          file,
          pointer + "/" + key.replaceAll("~", "~0").replaceAll("/", "~1"),
          stack,
          depth + 1,
        );
    }
    const entry = this.document(file),
      keys = pointer
        ? pointer
            .slice(1)
            .split("/")
            .map((k: string) => k.replaceAll("~1", "/").replaceAll("~0", "~"))
        : [];
    const node = keys.length ? entry.doc.getIn(keys, true) : entry.doc.contents;
    this.locations.set(out, {
      file: relative(this.root, file),
      pointer,
      ...entry.lines.linePos(node?.range?.[0] ?? 0),
      column: entry.lines.linePos(node?.range?.[0] ?? 0).col,
    });
    return out;
  }
  parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    const issue = result.error.issues[0];
    let owner: any = value;
    for (const key of issue.path.slice(0, -1))
      if (owner && typeof owner === "object") owner = owner[key as any];
    const where =
      this.locations.get(owner) ??
      (isMap(value) ? this.locations.get(value) : undefined);
    throw new Problem(
      "SCHEMA",
      `${issue.path.join(".")}: ${issue.message}`,
      where?.file,
      where?.pointer,
      "Use config explain to inspect the originating value",
    );
  }
  values(
    value: any,
    context: Record<string, any>,
    options: { draft?: boolean; table?: boolean; runtime?: boolean } = {},
  ): any {
    const resolving = new Set<string>();
    const lookup = (name: string): any => {
      check(!resolving.has(name), "CYCLE", `Value cycle at ${name}`);
      const parts = name.split(".");
      let current: any = context;
      for (const key of parts) {
        check(
          !["__proto__", "constructor", "prototype"].includes(key),
          "KEY",
          "Unsafe value reference",
        );
        current =
          isMap(current) && Object.hasOwn(current, key)
            ? current[key]
            : undefined;
      }
      check(current !== undefined, "VALUE", `Unknown value {{${name}}}`);
      resolving.add(name);
      const result = visit(current);
      resolving.delete(name);
      return result;
    };
    const visit = (v: any): any => {
      if (Array.isArray(v)) return v.map(visit);
      if (isMap(v)) {
        if (Object.hasOwn(v, "$env")) {
          check(
            Object.keys(v).length === 1 &&
              typeof v.$env === "string" &&
              /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.$env),
            "ENV",
            "$env requires one environment variable name",
          );
          const supplied = this.environmentVariables[v.$env];
          if (supplied === undefined || supplied === "") {
            const location = this.locations.get(v);
            this.pending.push({
              name: v.$env,
              file: location?.file,
              pointer: location?.pointer,
            });
            check(
              options.draft,
              "INPUT",
              `Missing environment variable ${v.$env}`,
              location?.file,
            );
            return { $env: v.$env };
          }
          this.inputs[v.$env] = digest(supplied);
          return supplied;
        }
        if (Object.hasOwn(v, "$secret")) {
          check(
            Object.keys(v).length === 1 && isMap(v.$secret),
            "SECRET",
            "$secret must describe a runtime lookup",
          );
          return structuredClone(v);
        }
        return Object.fromEntries(
          Object.entries(v).map(([k, child]) => [
            k,
            ["sql", "query", "python", "script"].includes(k)
              ? child
              : visit(child),
          ]),
        );
      }
      if (typeof v !== "string") return v;
      const all = [...v.matchAll(/{{\s*([A-Za-z_][\w.]*)\s*}}/g)];
      if (!all.length) return v;
      const tokenValue = (name: string) => {
        if (name.startsWith("run.") && options.runtime) {
          check(
            ["run.id", "run.date"].includes(name),
            "VALUE",
            `Unknown runtime placeholder ${name}; use run.id or run.date`,
          );
          return `{{${name}}}`;
        }
        if (
          (name.startsWith("table.") || name.startsWith("step.")) &&
          options.table
        )
          return `{{${name}}}`;
        return lookup(name);
      };
      if (all.length === 1 && all[0][0] === v) return tokenValue(all[0][1]);
      return v.replace(/{{\s*([A-Za-z_][\w.]*)\s*}}/g, (_, name) => {
        const resolved = tokenValue(name);
        if (options.draft && isMap(resolved) && resolved.$env)
          return `{{${name}}}`;
        check(
          ["string", "number", "boolean"].includes(typeof resolved),
          "VALUE",
          `Cannot embed non-scalar ${name} in text`,
        );
        return String(resolved);
      });
    };
    return visit(value);
  }
}
