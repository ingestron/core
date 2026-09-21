/** One build path: native compilation and connector preparation feed provider assembly. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { validateProviderFiles } from "../plugins/generation.js";
import { inspectProject, planProject } from "./planner.js";
import { canonical, check, digest, isMap } from "./errors.js";
import {
  canonicalPackageReference,
  fence,
  packageYaml,
  providerPackageSchema,
  resolvePackage,
} from "./packages.js";
import { checkProviderCompatibility } from "../plugins/compatibility.js";
import { prepareConnection } from "./connections.js";
import { runProviderCommand } from "./provider-commands.js";
import { deliveryExports } from "./delivery-exports.js";
import {
  renderProject,
  validateGeneratedFiles,
  writeOutput,
  type Files,
} from "./generate.js";
import { compilerFingerprint } from "./fingerprint.js";
import { version } from "../version.js";
import type { Plan } from "./schema.js";

export function buildProject(root: string, environment: string, args: any) {
  const { project, flows, reader, profile } = inspectProject(root, environment);
  check(
    !(args.provider && args.flow),
    "SELECT",
    "Choose provider or flow, not both",
  );
  check(
    !args.table && !args.step,
    "SELECT",
    "Project packages contain complete flows; select flow, not individual tables or steps",
  );
  if (args.provider)
    check(
      project.providers.configurations[args.provider],
      "PROVIDER",
      `Unknown provider configuration ${args.provider}`,
    );
  const owner = (f: (typeof flows)[number]) =>
    f.provider ?? project.defaults.provider ?? "";
  const wanted = new Set<string>();
  const active = new Set<string>();
  const include = (id: string) => {
    check(!active.has(id), "CYCLE", `Flow dependency cycle at ${id}`);
    if (wanted.has(id)) return;
    const flow = flows.find((f) => f.id === id);
    check(flow, "SELECT", `Unknown flow ${id}`);
    active.add(id);
    for (const r of Object.values(flow.requires)) {
      const parts = r.dataset.split(".");
      check(
        parts[0] === project.id && parts.length >= 3,
        "DATASET",
        `Unknown project dataset ${r.dataset}`,
      );
      include(parts[1]);
    }
    active.delete(id);
    wanted.add(id);
  };
  flows
    .filter((f) =>
      args.flow
        ? f.id === args.flow
        : args.provider
          ? owner(f) === args.provider
          : true,
    )
    .forEach((f) => include(f.id));
  if (args.flow) include(args.flow);
  check(
    wanted.size,
    "INPUT",
    "No buildable flows; add a flow and contract before building",
  );
  // The existing planner owns native standards, resources, handovers and dependency validation.
  const targetNames = new Set(flows.filter((f) => wanted.has(f.id)).map(owner));
  const candidates = new Set(
    flows
      .filter((f) => !f.ingestion?.connection && targetNames.has(owner(f)))
      .map((f) => f.id),
  );
  const addNativeParents = (id: string, visiting = new Set<string>()) => {
    check(!visiting.has(id), "CYCLE", `Flow dependency cycle at ${id}`);
    visiting.add(id);
    const f = flows.find((f) => f.id === id)!;
    for (const r of Object.values(f.requires)) {
      const parent = r.dataset.split(".")[1];
      const producer = flows.find((f) => f.id === parent);
      check(
        producer && !producer.ingestion?.connection,
        "DATASET",
        "Connector-to-native dataset handovers require an explicit supported publication contract",
      );
      candidates.add(parent);
      addNativeParents(parent, new Set(visiting));
    }
  };
  [...candidates].forEach((id) => addNativeParents(id));
  const nativePlan = planProject(root, environment, {
    nativeOnly: true,
    flowIds: [...candidates],
    delivery: true,
    projectBuild: true,
  });
  // A partial build must include every flow sharing an owned native resource.
  let changed = true;
  while (changed) {
    const before = wanted.size;
    const claims = new Set(
      nativePlan.nodes
        .filter((n) => wanted.has(n.flow))
        .flatMap((n) =>
          (n.resources ?? []).map((r) =>
            canonical([n.platform, r.scope, r.kind, r.name]),
          ),
        ),
    );
    for (const n of nativePlan.nodes)
      if (
        (n.resources ?? []).some((r) =>
          claims.has(canonical([n.platform, r.scope, r.kind, r.name])),
        )
      )
        include(n.flow);
    for (const f of flows.filter((f) => wanted.has(f.id) && f.export))
      flows
        .filter((p) => p.export === f.export && owner(p) === owner(f))
        .forEach((p) => include(p.id));
    changed = before !== wanted.size;
  }
  const nativeBody = {
    ...nativePlan,
    nodes: nativePlan.nodes.filter((n) => wanted.has(n.flow)),
    flows: nativePlan.flows.filter((f) => wanted.has(f.id)),
  };
  const { digest: _old, ...body } = nativeBody;
  const selectedNative: Plan = { ...body, digest: digest(canonical(body)) };
  const nativeGroups = deliveryExports(selectedNative);
  const configurations = [
    ...new Set(flows.filter((f) => wanted.has(f.id)).map(owner)),
  ].sort();
  check(
    !(
      args.flow ||
      configurations.some(
        (configuration) =>
          flows.filter((f) => owner(f) === configuration && wanted.has(f.id))
            .length !== flows.filter((f) => owner(f) === configuration).length,
      )
    ) || !nativeGroups.some((g) => g.imports.length),
    "HANDOVER",
    "Partial cross-target native handovers require path rebinding; build the complete project instead",
  );
  const deploymentRoots = new Set<string>();
  const files: Files = {};
  const packages: any[] = [];
  const add = (path: string, content: string) => {
    check(
      !Object.hasOwn(files, path),
      "OWNER",
      `Duplicate assembled file ${path}`,
    );
    check(
      typeof content === "string" &&
        !path.startsWith("/") &&
        !path.includes("\\") &&
        path.split("/").every((p) => p && p !== "." && p !== ".."),
      "PATH",
      "Unsafe assembled file path",
    );
    check(
      path !== "ingestron-manifest.json" && path !== "ingestron-project.json",
      "OWNER",
      "Provider cannot replace host build manifests",
    );
    files[path] = content;
  };
  for (const configuration of configurations) {
    const selected = flows.filter(
      (f) => wanted.has(f.id) && owner(f) === configuration,
    );
    const config = project.providers.configurations[configuration];
    check(
      config,
      "PROVIDER",
      `Unknown provider configuration ${configuration}`,
    );
    const pkg = project.providers.packages[config.package];
    check(pkg, "PACKAGE", `Missing execution package ${config.package}`);
    const reference = canonicalPackageReference(`${pkg.source}@${pkg.version}`);
    const locked = pkg.source.startsWith(".")
      ? { file: reader.path(pkg.source), root, entry: undefined }
      : resolvePackage(root, reference);
    const manifest = providerPackageSchema.parse(packageYaml(locked.file));
    checkProviderCompatibility(manifest);
    const partial =
      !!args.flow ||
      selected.length !==
        flows.filter((f) => owner(f) === configuration).length;
    const scope = {
      partial,
      id: partial
        ? "subset_" +
          digest(canonical(selected.map((f) => f.id).sort())).slice(0, 12)
        : "full",
      flows: selected.map((f) => f.id).sort(),
    };
    const identity = { project: project.id, environment, configuration, scope };
    const native = nativeGroups.find((g) => g.id === configuration);
    const nativeFiles = native ? renderProject(root, native.plan) : {};
    const connections = selected
      .filter((f) => f.ingestion?.connection)
      .map((f) => {
        check(
          manifest.projectAssembly,
          "CAPABILITY",
          `${configuration}: install a provider with project assembly support`,
        );
        const prepared = prepareConnection(
          root,
          environment,
          f.id,
          false,
          undefined,
          (execution) => {
            const configured: any = runProviderCommand(root, environment, {
              configuration,
              command: manifest.projectAssembly!.command,
              input: {
                phase: "configure",
                ...identity,
                flow: f.id,
                execution,
                binding: profile.bindings[config.binding],
                options: config.options,
              },
            });
            check(
              isMap(configured.result) && isMap(configured.result.execution),
              "PROVIDER",
              "Invalid project execution configuration",
            );
            return configured.result.execution;
          },
        ) as any;
        return {
          flow: f.id,
          artifacts: prepared.result.artifacts,
          inputDigest: prepared.inputDigest,
        };
      });
    let artifacts: Files = nativeFiles;
    let details: any = {
      resources: native?.resources ?? [],
      execution: "not-run",
    };
    if (manifest.projectAssembly) {
      const assembled: any = runProviderCommand(root, environment, {
        configuration,
        command: manifest.projectAssembly.command,
        input: {
          phase: "assemble",
          ...identity,
          binding: profile.bindings[config.binding],
          options: config.options,
          nativeFiles,
          connections,
          dependencies: native?.imports ?? [],
        },
      });
      check(
        assembled.result?.apiVersion === "ingestron.project-package/v1" &&
          isMap(assembled.result.artifacts),
        "PROVIDER",
        "Invalid assembled project package",
      );
      artifacts = assembled.result.artifacts;
      details = assembled.result.details;
    } else
      check(
        !partial,
        "CAPABILITY",
        `${configuration}: partial project builds require project assembly support`,
      );
    if (manifest.lifecycle) {
      const asset = (path: string) =>
        reader.text(
          fence(
            locked.root,
            relative(locked.root, resolve(dirname(locked.file), path)),
          ),
        );
      validateProviderFiles(
        asset(manifest.lifecycle.module),
        Object.fromEntries(
          Object.entries(manifest.outputSchemas ?? {}).map(([key, path]) => [
            key,
            asset(path),
          ]),
        ),
        artifacts,
      );
    }
    if (details?.workspaceRoot) {
      const rootIdentity = canonical([
        manifest.platform,
        profile.bindings[config.binding]?.host,
        details.workspaceRoot,
      ]);
      check(
        !deploymentRoots.has(rootIdentity),
        "OWNER",
        "Provider configurations cannot share a deployment root",
      );
      deploymentRoots.add(rootIdentity);
    }
    const directory =
      configurations.length === 1 ? "" : `providers/${configuration}/`;
    for (const [name, content] of Object.entries(artifacts))
      add(directory + name, content);
    packages.push({
      configuration,
      platform: manifest.platform,
      directory: directory || ".",
      reference,
      commit: locked.entry?.commit,
      scope,
      details,
      needs: native?.needs ?? [],
      imports: native?.imports ?? [],
    });
  }
  check(
    Object.keys(files).length <= 10000 &&
      Buffer.byteLength(JSON.stringify(files)) <= 10 * 1024 * 1024,
    "LIMIT",
    "Project output exceeds 10000 files or 10 MiB",
  );
  const selection = {
    projectBuild: true,
    ...(args.flow ? { flow: args.flow } : {}),
    ...(args.provider ? { provider: args.provider } : {}),
  };
  const metadata = {
    apiVersion: "ingestron.project-build/v1",
    project: project.id,
    environment,
    compilerVersion: version,
    compilerDigest: compilerFingerprint(),
    selection,
    complete: !args.flow && !args.provider,
    requestedFlows: args.flow ? [args.flow] : undefined,
    includedFlows: [...wanted].sort(),
    packages,
    deployment: { executed: false, omissionMeansDeletion: false },
    files: Object.fromEntries(
      Object.entries(files).map(([n, t]) => [n, digest(t)]),
    ),
    sourceFiles: { ...reader.files, ...nativePlan.files },
    packageLockSha256: existsSync(fence(root, "packages.lock.yaml"))
      ? digest(readFileSync(fence(root, "packages.lock.yaml")))
      : undefined,
  };
  files["ingestron-project.json"] = JSON.stringify(metadata, null, 2) + "\n";
  validateGeneratedFiles(files);
  const output = writeOutput(
    fence(root, args.out),
    {
      project: project.id,
      environment,
      selection,
      digest: digest(canonical(metadata)),
    },
    files,
    args.ownership,
  );
  return {
    ...output,
    directory: args.out,
    nodes:
      selectedNative.nodes.length +
      flows.filter((f) => wanted.has(f.id) && f.ingestion?.connection).length,
    packages: packages.map((p) => p.configuration),
    scope: selection,
    evidence:
      "Project assets generated locally; no deployment or source execution",
  };
}
