import { z } from "zod";
import {
  mkdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  renameSync,
  unlinkSync,
  realpathSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { join, resolve, parse } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { check, digest } from "./errors.js";
import { readProgramme } from "./programme.js";
import {
  platformProvider,
  environmentName,
  environmentVariableName,
} from "./platform-schema.js";
export const platformSecretSchema = z
  .object({
    id: z.string(),
    platform: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/),
    provider: platformProvider,
    environment: environmentName,
  })
  .strict();
export const platformSecretSetSchema = platformSecretSchema
  .extend({
    name: environmentVariableName,
    value: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (v) => !/[\u0000-\u001f\u007f]/.test(v),
        "Use a single-line secret",
      ),
  })
  .strict();
type Request = z.infer<typeof platformSecretSchema>;
function context(root: string, input: Request) {
  const programme = readProgramme(root, input.id).document;
  const environment = programme?.platforms
    ?.find((p) => p.id === input.platform)
    ?.configuration?.targets.find((t) => t.provider === input.provider)
    ?.environments.find((e) => e.name === input.environment);
  check(
    environment,
    "PROGRAMME",
    "Save this registered platform environment before managing its secrets",
  );
  const base = resolve(
    process.env.INGESTRON_LOCAL_SECRETS_DIR ??
      join(homedir(), ".config", "ingestron", "local-env"),
  );
  const namespace = digest(
    JSON.stringify([
      realpathSync(root),
      input.id,
      input.platform,
      input.provider,
      input.environment,
    ]),
  );
  return { environment, base, dir: join(base, namespace) };
}
function safeDirectory(dir: string, create = false) {
  const parts = resolve(dir)
    .slice(parse(resolve(dir)).root.length)
    .split(/[\/]+/);
  let current = parse(resolve(dir)).root;
  for (const part of parts) {
    current = join(current, part);
    // macOS system aliases such as /tmp are resolved before using the private base.
    try {
      const stat = lstatSync(current);
      check(
        !stat.isSymbolicLink() && stat.isDirectory(),
        "PATH",
        "Secret storage must use real directories",
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (!create) return false;
      mkdirSync(current, { mode: 0o700 });
    }
  }
  return true;
}
function readValues(dir: string): Record<string, string> {
  if (!safeDirectory(dir)) return {};
  const file = join(dir, "local.env");
  let stat;
  try {
    stat = lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  check(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.size <= 256 * 1024,
    "PATH",
    "Invalid local secret file",
  );
  check(
    process.platform === "win32" || (stat.mode & 0o077) === 0,
    "PERMISSION",
    "Local secret file permissions must be owner-only",
  );
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const match = /^([A-Z][A-Z0-9_]*)='(.*)'$/.exec(line);
    check(match, "SECRET", "Invalid local environment file");
    environmentVariableName.parse(match[1]);
    const value = match[2]!.replace(/'"'"'/g, "'");
    check(!value.includes("\n"), "SECRET", "Invalid local environment value");
    values[match[1]!] = value;
  }
  return values;
}
export function platformSecretStatus(root: string, input: Request) {
  const { environment, dir } = context(root, input);
  const values = readValues(dir);
  return {
    document: null,
    digest: null,
    secrets: environment.secrets
      .filter((s) => s.source === "local-env")
      .map((s) => ({
        name: s.name,
        stored: Object.hasOwn(values, s.name),
        inProcess: !!process.env[s.name],
      })),
  };
}
export function platformSecretSet(
  root: string,
  input: z.infer<typeof platformSecretSetSchema>,
) {
  const { environment, base, dir } = context(root, input);
  check(
    environment.purpose === "development" &&
      environment.secrets.some(
        (s) => s.name === input.name && s.source === "local-env",
      ),
    "PERMISSION",
    "Only declared local development secret variables can be stored",
  );
  safeDirectory(base, true);
  check(
    process.platform !== "win32",
    "PLATFORM",
    "Use operating-system environment variables on Windows; private local-file storage requires POSIX permissions",
  );
  chmodSync(base, 0o700);
  safeDirectory(dir, true);
  chmodSync(dir, 0o700);
  const lock = join(dir, ".write.lock");
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch {
    throw Error("Local secrets are being updated; retry shortly");
  }
  const temporary = join(dir, `.${randomUUID()}.tmp`);
  try {
    const values = readValues(dir);
    values[input.name] = input.value;
    const quote = (v: string) => "'" + v.replace(/'/g, "'\"'\"'") + "'";
    const raw =
      Object.entries(values)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${quote(v)}`)
        .join("\n") + "\n";
    check(
      Buffer.byteLength(raw) <= 256 * 1024,
      "LIMIT",
      "Local secret file is too large",
    );
    writeFileSync(temporary, raw, { flag: "wx", mode: 0o600 });
    renameSync(temporary, join(dir, "local.env"));
    return platformSecretStatus(root, input);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    closeSync(fd);
    unlinkSync(lock);
  }
}
