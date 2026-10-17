import { existsSync, realpathSync, statSync } from "node:fs";
import { z } from "zod";
import { stringify } from "yaml";
import { canonical, check, digest } from "./errors.js";
import {
  initialProjectFiles,
  preview,
  apply,
  type Proposal,
} from "./authoring.js";
import { programmeSchema, compilerProjectId } from "./programme-schema.js";
import { environmentName, platformProvider } from "./platform-schema.js";
import {
  loadProgrammeStorage,
  programmeBytes,
  programmePath,
  programmeYaml,
  programmeYamlFiles,
} from "./programme-storage.js";
import {
  assertProgrammeReadable,
  withProgrammeWrite,
} from "./programme-transaction.js";

const name = z.string().trim().min(1).max(160);
const id = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,79}$/)
  .refine((v) => !["constructor", "prototype", "__proto__"].includes(v));
const legacyInitialisationSchema = z
  .object({
    programme: z
      .object({
        id,
        name,
        objective: z.string().trim().min(1).max(4000),
        owner: name,
      })
      .strict(),
    project: z
      .object({
        id: compilerProjectId,
        name,
        outcome: z.string().trim().min(1).max(4000),
      })
      .strict(),
    platform: z
      .object({ id, name, targets: z.array(platformProvider).max(3) })
      .strict(),
    environments: z
      .array(
        z
          .object({
            name: environmentName,
            purpose: z.enum(["development", "test", "production"]),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      new Set(v.environments.map((e) => e.name)).size !==
        v.environments.length ||
      new Set(v.platform.targets).size !== v.platform.targets.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Use distinct environments and targets",
      });
  });
// Standalone projects do not create programme or planning records.
const projectFirstSchema = z
  .object({
    mode: z.literal("project"),
    project: z
      .object({
        id: compilerProjectId,
        name,
        outcome: z.string().trim().min(1).max(4000),
      })
      .strict(),
  })
  .strict();
export const workspaceInitialisationSchema = z.union([
  projectFirstSchema,
  legacyInitialisationSchema,
]);
export const workspaceInitialisationApplySchema = z
  .object({ input: workspaceInitialisationSchema, proposal: z.unknown() })
  .strict();
type Input = z.infer<typeof workspaceInitialisationSchema>;

/** Inspect only explicit/conventional definitions; no recursive discovery or writes. */
export function inspectWorkspace(root: string) {
  root = realpathSync(root);
  check(statSync(root).isDirectory(), "PATH", "Select a workspace directory");
  const projectBytes = programmeBytes(root, "project.yaml");
  if (projectBytes !== null) {
    const config = programmeYaml(projectBytes).toJS();
    check(
      config?.apiVersion === "ingestron.project/v1",
      "PROJECT",
      "Invalid project definition",
    );
    const projectId = compilerProjectId.parse(config.id);
    return {
      status: "existing" as const,
      platforms: [],
      projects: [
        {
          id: projectId,
          name: typeof config.name === "string" ? config.name : projectId,
          path: "",
          environments: Object.keys(config.environments ?? {}),
        },
      ],
    };
  }
  const candidates: {
    folder: string;
    document: ReturnType<typeof programmeSchema.parse>;
  }[] = [];
  for (const folder of ["", "programme"]) {
    const directory = folder ? programmePath(root, folder) : root;
    if (!existsSync(directory)) continue;
    assertProgrammeReadable(directory);
    const json = programmeBytes(directory, "programme.json");
    const yaml = programmeBytes(directory, "programme.yaml");
    if (json === null && yaml === null) continue;
    check(
      json === null || yaml === null,
      "CONFLICT",
      "Both JSON and YAML programme definitions exist; resolve the ambiguity before opening",
    );
    const raw = json !== null ? JSON.parse(json) : programmeYaml(yaml!).toJS();
    const loaded = loadProgrammeStorage(directory, raw.id);
    check(loaded.document, "PROGRAMME", "Programme definition is missing");
    candidates.push({ folder, document: loaded.document });
  }
  check(
    candidates.length <= 1,
    "CONFLICT",
    "Multiple programme definitions exist; select the programme folder directly",
  );
  if (!candidates.length) return { status: "new" as const };
  const { folder, document } = candidates[0];
  const projects = document.projects.flatMap((project) => {
    if (!project.compilerId) return [];
    const path = `projects/${project.compilerId}`;
    const raw = programmeBytes(root, `${path}/project.yaml`);
    if (raw === null) return [];
    const config = programmeYaml(raw).toJS();
    check(
      config.id === project.compilerId,
      "PROJECT",
      "Project identity does not match its programme registration",
    );
    return [
      {
        ...project,
        path,
        environments: Object.keys(config.environments ?? {}),
      },
    ];
  });
  return {
    status: "existing" as const,
    programme: { id: document.id, name: document.name, path: folder },
    platforms: document.platforms ?? [],
    projects,
  };
}

export function reviewWorkspaceInitialisation(root: string, raw: Input) {
  const input = workspaceInitialisationSchema.parse(raw);
  root = realpathSync(root);
  check(
    inspectWorkspace(root).status === "new",
    "OWNER",
    "This workspace already has a programme. Open it to continue",
  );
  // Initialisation owns new directories only. Existing projects must be registered,
  // never silently adopted or overwritten by a first-run wizard.
  for (const path of [
    "programme",
    "projects",
    "project.yaml",
    "packages.lock.yaml",
  ])
    check(
      !existsSync(programmePath(root, path)),
      "OWNER",
      `Existing ${path} must be opened or registered before initialising`,
    );
  const projectOnly = "mode" in input;
  const project = input.project;
  if (projectOnly) {
    const files = initialProjectFiles(project.id, ["dev"]);
    const config = programmeYaml(files["project.yaml"]).toJS();
    files["project.yaml"] = stringify({
      ...config,
      name: project.name,
      description: project.outcome,
    });
    return {
      input,
      proposal: preview(root, files),
      summary: { project: project.name, targetSetup: "pending" as const },
    };
  }
  const environments = input.environments;
  const document = programmeSchema.parse({
    apiVersion: "ingestron.programme/v1",
    id: input.programme.id,
    name: input.programme.name,
    objective: input.programme.objective,
    sponsor: input.programme.owner,
    stakeholders: [{ name: input.programme.owner, role: "Accountable owner" }],
    projects: [
      {
        id: input.project.id,
        compilerId: input.project.id,
        name: input.project.name,
        ...{ platformId: input.platform.id },
      },
    ],
    platforms: [
      {
        id: input.platform.id,
        name: input.platform.name,
        configuration: {
          environments: input.environments,
          targets: input.platform.targets.map((provider) => ({
            provider,
            capabilities: {},
            policies: {},
            naming: {},
            environments: [],
          })),
        },
      },
    ],
    requirements: [
      {
        id: "first-outcome",
        title: input.project.name,
        description: input.project.outcome,
        owner: input.programme.owner,
        priority: "must",
        disposition: "draft",
        acceptance: [],
        projectIds: [input.project.id],
        area: { kind: "project", id: input.project.id },
        component: "requirements",
        kind: "requirement",
      },
    ],
  });
  const files = Object.fromEntries([
    ...Object.entries(programmeYamlFiles(document)).map(([path, raw]) => [
      `programme/${path}`,
      raw,
    ]),
    ...Object.entries(
      initialProjectFiles(
        input.project.id,
        environments.map((e) => e.name),
      ),
    ).map(([path, raw]) => [`projects/${input.project.id}/${path}`, raw]),
  ]);
  return {
    input,
    proposal: preview(root, files),
    summary: {
      programme: input.programme.name,
      project: input.project.name,
      platform: input.platform.name,
      targetSetup: "pending" as const,
    },
  };
}

export function applyWorkspaceInitialisation(
  root: string,
  request: z.infer<typeof workspaceInitialisationApplySchema>,
) {
  request = workspaceInitialisationApplySchema.parse(request);
  return withProgrammeWrite(root, () => {
    const reviewed = reviewWorkspaceInitialisation(root, request.input);
    check(
      digest(canonical(reviewed.proposal)) ===
        digest(canonical(request.proposal)),
      "STALE",
      "Workspace or proposal changed since review; review again",
    );
    const result = apply(root, reviewed.proposal as Proposal);
    return { ...result, workspace: inspectWorkspace(root) };
  });
}
