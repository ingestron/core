import { compiledPath } from "../core/installation.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { check, Problem } from "../core/errors.js";
export type ProviderAssets = Record<
  string,
  { format: "json" | "yaml" | "text"; value: any }
>;
/** Only JSON crosses the process/VM boundary. The guest cannot access files or networks. */
export function executeProvider(
  code: string,
  input: unknown,
  validateOnly = false,
  operation:
    | "render"
    | "expand"
    | "command"
    | "author"
    | "model"
    | "validateOutput" = "render",
): ProviderAssets {
  const request = JSON.stringify({ code, input, validateOnly, operation });
  check(
    request.length <= 10_000_000,
    "PROVIDER",
    "Provider request exceeds 10 MB",
  );
  let response: any;
  // A private request file avoids large synchronous stdin pipe stalls. The VM
  // receives parsed JSON only; it never receives host filesystem access.
  const temporary = mkdtempSync(resolve(tmpdir(), "ingestron-worker-"));
  const requestPath = resolve(temporary, "request.json");
  try {
    writeFileSync(requestPath, request, { mode: 0o600, flag: "wx" });
    response = JSON.parse(
      execFileSync(
        process.execPath,
        [compiledPath("plugins/provider-worker.js"), requestPath],
        {
          encoding: "utf8",
          env: {},
          timeout: 30000,
          maxBuffer: 10_000_000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
  } catch {
    throw new Problem(
      "PROVIDER",
      "Provider exceeded its process limits or could not run",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  check(response.ok, "PROVIDER", response.error ?? "Provider renderer failed");
  return response.assets;
}

export function expandProvider(code: string, input: unknown): any {
  return executeProvider(code, input, false, "expand");
}
