/** Generic package references and version discovery; no bundled provider registry. */
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { check, Problem } from "./errors.js";
export function providerRepository(name: string): string {
  check(
    /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) &&
      !name.includes(".."),
    "PACKAGE",
    "Use an explicit GitHub owner/repository",
  );
  return name;
}
/** Preserve custom manifest paths and immutable selectors when formatting references. */
export function friendlyReference(reference: string): string {
  return reference
    .replace(/\/plugin\/provider\.yaml(?=@|$)/, "")
    .replace(/@v(?=\d+\.\d+\.\d+$)/, "@");
}
export function packageGitEnvironment() {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}
export function gitTags(repository: string, fromGit?: string) {
  providerRepository(repository);
  try {
    return execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=!gh auth git-credential",
        "ls-remote",
        "--tags",
        "--",
        fromGit
          ? realpathSync(fromGit)
          : `https://github.com/${repository}.git`,
      ],
      {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: packageGitEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    // Git stderr may include authentication diagnostics. Do not echo it into
    // terminal/JSON responses; callers get a stable, actionable diagnostic.
    throw new Problem(
      "PACKAGE",
      `Cannot read plugin versions from ${repository}`,
      undefined,
      undefined,
      "Check repository access and GitHub authentication, then retry.",
    );
  }
}
export function taggedVersions(text: string, prefix = "") {
  check(/^[a-z0-9-]*$/.test(prefix), "PACKAGE", "Invalid package tag prefix");
  const refs = new Map<string, string>();
  const lines = text.trim() ? text.trim().split("\n") : [];
  check(
    lines.length <= 10000,
    "LIMIT",
    "Provider tag listing exceeds 10,000 refs",
  );
  for (const line of lines) {
    if (prefix && !line.includes("refs/tags/" + prefix)) continue;
    const match =
      /^([a-f0-9]{40})\s+refs\/tags\/(v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(\^\{\})?$/.exec(
        prefix ? line.replace("refs/tags/" + prefix, "refs/tags/") : line,
      );
    if (match) refs.set(match[2] + (match[3] ?? ""), match[1]);
  }
  const versions = new Map<
    string,
    { version: string; tag: string; commit: string; ambiguous: boolean }
  >();
  for (const [tag, object] of refs) {
    if (tag.endsWith("^{}")) continue;
    const version = tag.replace(/^v/, ""),
      commit = refs.get(tag + "^{}") ?? object;
    const prior = versions.get(version);
    const ambiguous = !!prior && (prior.ambiguous || prior.commit !== commit);
    versions.set(version, {
      version,
      tag: prior && !tag.startsWith("v") ? prior.tag : prefix + tag,
      commit,
      ambiguous,
    });
  }
  return [...versions.values()].sort((a, b) => {
    const left = a.version.split(".").map(Number),
      right = b.version.split(".").map(Number);
    return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
  });
}

export function providerVersions(
  name: string,
  fromGit?: string,
  tagPrefix = "",
) {
  const repository = providerRepository(name);
  const versions = taggedVersions(gitTags(repository, fromGit), tagPrefix).map(
    (v) => ({
      ...v,
      repository,
      reference: `${repository}@${v.version}`,
      selectable: !v.ambiguous,
      compatibility: "unchecked",
    }),
  );
  return {
    provider: repository,
    repository,
    source: fromGit ? "local-git" : "github",
    versions,
    evidence:
      "Git tags only; manifest and host compatibility are checked during installation",
  };
}
