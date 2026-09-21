import { generateProvider } from "../plugins/generation.js";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  lstatSync,
  realpathSync,
  renameSync,
  rmSync,
  mkdtempSync,
} from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { parseDocument } from "yaml";
import { parser as pythonParser } from "@lezer/python";
import { check, canonical, digest, Problem } from "./errors.js";
import { Configuration } from "./config.js";
import type { Plan } from "./schema.js";
import { compilerFingerprint } from "./fingerprint.js";
import { version } from "../version.js";
export type Files = Record<string, string>;
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
export function verifyPlan(root: string, plan: Plan) {
  const { digest: expected, ...body } = plan;
  check(
    plan.apiVersion === "ingestron.plan/v1" &&
      digest(canonical(body)) === expected,
    "PLAN",
    "Plan content digest is invalid",
  );
  check(
    plan.compilerVersion === version,
    "STALE",
    "Compiler version changed; create a new plan",
  );
  for (const [name, hash] of Object.entries(plan.inputDigests))
    check(
      process.env[name] !== undefined && digest(process.env[name]!) === hash,
      "STALE",
      `Environment input changed since planning: ${name}`,
    );
  check(
    plan.compilerDigest === compilerFingerprint(),
    "STALE",
    "Compiler content changed since planning; create a new plan",
  );
  const reader = new Configuration(root);
  for (const [file, hash] of Object.entries(plan.files))
    check(
      digest(reader.text(file)) === hash,
      "STALE",
      `Input changed since planning: ${file}`,
    );
}
export function validateGeneratedFiles(files: Files) {
  for (const [name, source] of Object.entries(files)) {
    const pythonSources = name.endsWith(".py")
      ? [source]
      : name.endsWith(".ipynb")
        ? JSON.parse(source)
            .cells.filter((cell: any) => cell.cell_type === "code")
            .map((cell: any) =>
              Array.isArray(cell.source) ? cell.source.join("") : cell.source,
            )
        : [];
    for (const python of pythonSources) {
      let bad = false;
      pythonParser.parse(python).iterate({
        enter(node) {
          if (node.type.isError) bad = true;
        },
      });
      check(!bad, "PYTHON", `Generated Python syntax invalid: ${name}`);
    }
    if (name.endsWith(".json") || name.endsWith(".ipynb")) JSON.parse(source);
    if (/\.ya?ml$/.test(name))
      check(
        !parseDocument(source, { uniqueKeys: true }).errors.length,
        "YAML",
        `Generated YAML syntax invalid: ${name}`,
      );
  }
}
export function renderProject(root: string, plan: Plan): Files {
  verifyPlan(root, plan);
  const files = generateProvider(root, plan);
  validateGeneratedFiles(files);
  return files;
}

interface Manifest {
  apiVersion: "ingestron.output/v1";
  project: string;
  environment: string;
  planDigest: string;
  selection: Plan["selection"];
  files: Record<string, string>;
  ownership?: "managed" | "team";
}
const manifestName = "ingestron-manifest.json";
function outputPath(root: string, name: string) {
  check(
    !isAbsolute(name) &&
      !name.includes("\\") &&
      name.split("/").every((p) => p && ![".", ".."].includes(p)),
    "PATH",
    "Unsafe generated output path",
  );
  let at = root;
  for (const p of name.split("/")) {
    at = resolve(at, p);
    check(
      !existsSync(at) || !lstatSync(at).isSymbolicLink(),
      "PATH",
      "Generated output cannot cross symlinks",
    );
  }
  return at;
}
export function writeOutput(
  directory: string,
  plan: Pick<Plan, "project" | "environment" | "selection" | "digest">,
  files: Files,
  ownership: "managed" | "team" = "managed",
) {
  directory = resolve(directory);
  check(
    !existsSync(directory) || !lstatSync(directory).isSymbolicLink(),
    "PATH",
    "Output directory cannot be a symlink",
  );
  mkdirSync(directory, { recursive: true });
  directory = realpathSync(directory);
  const manifestFile = outputPath(directory, manifestName),
    previous: Manifest | undefined = existsSync(manifestFile)
      ? JSON.parse(readFileSync(manifestFile, "utf8"))
      : undefined;
  check(
    previous?.ownership !== "team",
    "OWNER",
    "This project is team-maintained. Generate into a new directory and review the diff; existing source will not be overwritten.",
  );
  if (ownership === "team") {
    check(
      !previous && readdirSync(directory).length === 0,
      "OWNER",
      "Team export requires a new or empty output directory",
    );
    files = {
      ...files,
      "OWNERSHIP.md":
        "# Team-maintained project\n\nThe team owns this source and configuration. Ingestron will not regenerate into this directory. Compiler provenance describes the original export, not subsequent edits. No Ingestron runtime is needed. Review changes through Git and run ingestron validate-output on this directory. Maintain business tests, native acceptance and documentation in your own Git workflow.\n",
    };
  }
  if (previous) {
    check(
      canonical(previous.selection) === canonical(plan.selection),
      "OWNER",
      "Use a separate output directory for each selected flow/table/step scope",
    );
    check(
      previous.apiVersion === "ingestron.output/v1" &&
        previous.project === plan.project &&
        previous.environment === plan.environment,
      "OWNER",
      "Output directory belongs to another project/environment",
    );
    for (const [name, hash] of Object.entries(previous.files))
      check(
        existsSync(outputPath(directory, name)) &&
          digest(readFileSync(outputPath(directory, name))) === hash,
        "CONFLICT",
        `Generated output was edited or removed: ${name}`,
      );
  }
  for (const name of Object.keys(files))
    check(
      !existsSync(outputPath(directory, name)) || !!previous?.files[name],
      "OWNER",
      `Refusing to overwrite unowned file ${name}`,
    );
  // Output directories own exactly one generation scope. Remove only unchanged owned files.
  const merged = Object.fromEntries(
    Object.entries(files).map(([name, text]) => [
      name,
      digest(name.endsWith(".whl") ? Buffer.from(text, "base64") : text),
    ]),
  );
  const manifest: Manifest = {
    apiVersion: "ingestron.output/v1",
    project: plan.project,
    environment: plan.environment,
    planDigest: plan.digest,
    selection: plan.selection,
    files: merged,
    ownership,
  };
  const guard = outputPath(directory, ".ingestron-generate.lock");
  try {
    writeFileSync(guard, plan.digest, { flag: "wx" });
  } catch {
    throw new Problem(
      "CONFLICT",
      "Another generator owns this output directory",
    );
  }
  const stage = mkdtempSync(resolve(directory, ".generate-")),
    touched: string[] = [],
    before = new Map<string, Buffer | null>();
  try {
    for (const [name, hash] of Object.entries(previous?.files ?? {}))
      check(
        digest(readFileSync(outputPath(directory, name))) === hash,
        "CONFLICT",
        `Output changed while acquiring generation guard: ${name}`,
      );
    for (const name of new Set([
      ...Object.keys(files),
      ...Object.keys(previous?.files ?? {}),
      manifestName,
    ]))
      before.set(
        name,
        existsSync(outputPath(directory, name))
          ? readFileSync(outputPath(directory, name))
          : null,
      );
    for (const [name, text] of Object.entries(files)) {
      const staged = outputPath(stage, name);
      mkdirSync(dirname(staged), { recursive: true });
      writeFileSync(
        staged,
        name.endsWith(".whl") ? Buffer.from(text, "base64") : text,
      );
    }
    for (const name of Object.keys(files)) {
      const target = outputPath(directory, name);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(outputPath(stage, name), target);
      touched.push(name);
    }
    for (const name of Object.keys(previous?.files ?? {}))
      if (!Object.hasOwn(files, name)) {
        rmSync(outputPath(directory, name));
        touched.push(name);
      }
    const stagedManifest = resolve(stage, manifestName);
    writeFileSync(stagedManifest, json(manifest));
    renameSync(stagedManifest, manifestFile);
    touched.push(manifestName);
  } catch (error) {
    for (const name of touched.reverse()) {
      const file = outputPath(directory, name),
        bytes = before.get(name);
      if (bytes == null) rmSync(file, { force: true });
      else writeFileSync(file, bytes);
    }
    throw error;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(guard, { force: true });
  }
  return { directory, files: Object.keys(files).length, digest: plan.digest };
}
export function validateOutput(directory: string) {
  directory = realpathSync(directory);
  const manifest: Manifest = JSON.parse(
    readFileSync(outputPath(directory, manifestName), "utf8"),
  );
  check(
    manifest.apiVersion === "ingestron.output/v1",
    "OUTPUT",
    "Unknown output manifest version",
  );
  const files: Files = {};
  const inventory =
    manifest.ownership === "team"
      ? Object.fromEntries(teamFiles(directory).map((name) => [name, ""]))
      : manifest.files;
  for (const [name, hash] of Object.entries(inventory)) {
    const bytes = readFileSync(outputPath(directory, name));
    const content = bytes.toString(name.endsWith(".whl") ? "base64" : "utf8");
    check(
      manifest.ownership === "team" || digest(bytes) === hash,
      "CONFLICT",
      `Output hash mismatch: ${name}`,
    );
    files[name] = content;
  }
  validateGeneratedFiles(files);
  return {
    files: Object.keys(files).length,
    planDigest: manifest.planDigest,
    evidence: "offline",
    ownership: manifest.ownership ?? "managed",
  };
}

function teamFiles(root: string, prefix = ""): string[] {
  return readdirSync(resolve(root, prefix), { withFileTypes: true }).flatMap(
    (entry) => {
      if (
        [".git", ".venv", "node_modules", "__pycache__", ".ingestron"].includes(
          entry.name,
        )
      )
        return [];
      const name = prefix ? prefix + "/" + entry.name : entry.name;
      check(
        !entry.isSymbolicLink(),
        "PATH",
        "Team source cannot contain symlinks",
      );
      if (entry.isDirectory()) return teamFiles(root, name);
      return /\.(py|sql|json|ipynb|ya?ml|whl)$/.test(name) &&
        name !== manifestName
        ? [name]
        : [];
    },
  );
}
