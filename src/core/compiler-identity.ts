import { compilerFingerprint } from "./fingerprint.js";
import { version } from "../version.js";
import { check } from "./errors.js";

/** Integrity-checked installed compiler identity; does not read or write a project. */
export function compilerIdentity() {
  return {
    apiVersion: "ingestron.compiler-identity/v1",
    version,
    digest: compilerFingerprint(),
  };
}

export function buildCompilerIdentity(build: any) {
  check(
    typeof build.compilerVersion === "string" &&
      /^\d+\.\d+\.\d+$/.test(build.compilerVersion) &&
      typeof build.compilerDigest === "string" &&
      /^[a-f0-9]{64}$/.test(build.compilerDigest),
    "COMPILER",
    "Managed build has no supported compiler identity; rebuild before fresh execution",
  );
  return { version: build.compilerVersion, digest: build.compilerDigest };
}

export function buildCompilerCurrent(build: any) {
  const original = buildCompilerIdentity(build),
    current = compilerIdentity();
  return (
    original.version === current.version && original.digest === current.digest
  );
}
