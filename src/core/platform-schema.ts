import { z } from "zod";
import { platformCatalogue } from "./platform-catalogue.js";
export const platformProvider = z.enum(["fabric", "databricks", "adf"]);
export const environmentName = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
export const environmentVariableName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
  .refine(
    (v) =>
      ![
        "PATH",
        "HOME",
        "NODE_OPTIONS",
        "NODE_PATH",
        "PYTHONPATH",
        "SHELL",
        "BASH_ENV",
        "ENV",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "DYLD_INSERT_LIBRARIES",
        "DYLD_LIBRARY_PATH",
      ].includes(v) &&
      !v.startsWith("INGESTRON_") &&
      !v.startsWith("STUDIO2_"),
    "Reserved environment variable",
  );
const ref = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_.-]+$/);
const secretReference = z.discriminatedUnion("source", [
  z
    .object({ name: environmentVariableName, source: z.literal("local-env") })
    .strict(),
  z
    .object({
      name: environmentVariableName,
      source: z.literal("key-vault"),
      vaultUrl: z
        .string()
        .url()
        .regex(/^https:\/\/[a-zA-Z0-9-]+\.vault\.azure\.net\/?$/),
      secretName: ref,
    })
    .strict(),
  z
    .object({
      name: environmentVariableName,
      source: z.literal("databricks-scope"),
      scope: ref,
      key: ref,
    })
    .strict(),
]);
const short = z
  .string()
  .trim()
  .max(300)
  .refine(
    (v) => !/[\u0000-\u001f\u007f]/.test(v),
    "Control characters are not allowed",
  );
const setting = z.enum(["inherit", "enabled", "disabled"]);
export const platformTargetSchema = z
  .object({
    provider: platformProvider,
    generation: z.record(z.string(), z.string().max(80)).optional(),
    capabilities: z.record(z.string(), setting),
    policies: z.record(z.string(), setting),
    naming: z.record(z.string(), short),
    environments: z
      .array(
        z
          .object({
            name: environmentName,
            purpose: z.enum(["development", "test", "production"]),
            authentication: z.enum([
              "azure-cli",
              "databricks-cli",
              "service-principal",
              "oauth-m2m",
              "managed-identity",
            ]),
            configuration: z.record(z.string(), short),
            secrets: z.array(secretReference).max(50),
          })
          .strict(),
      )
      .max(20),
  })
  .strict()
  .superRefine((target, ctx) => {
    const catalogue = platformCatalogue.find((p) => p.id === target.provider)!;
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    for (const field of ["capabilities", "policies", "naming"] as const) {
      const keys =
        field === "naming"
          ? Object.keys(catalogue.naming)
          : catalogue[field].map((f) => f.id);
      if (Object.keys(target[field]).some((key) => !keys.includes(key)))
        fail("Unknown platform setting");
    }
    for (const [key, value] of Object.entries(target.generation ?? {})) {
      const field = catalogue.generation.find((s) => s.id === key);
      if (!field || !field.options.some((o) => o.id === value))
        fail("Unknown generation setting or option for this platform");
    }
    const tokens = [
      "programme",
      "project",
      "environment",
      "layer",
      "dataset",
      "flow",
      "source",
    ];
    for (const pattern of Object.values(target.naming))
      if (
        pattern &&
        (pattern.length > 120 ||
          !/^[A-Za-z0-9_{}-]+$/.test(pattern) ||
          [...pattern.matchAll(/\{([^{}]*)\}/g)].some(
            (m) => !tokens.includes(m[1]!),
          ) ||
          pattern.replace(/\{[^{}]+\}/g, "").match(/[{}]/))
      )
        fail(
          "Use known naming tokens and letters, numbers, underscores or hyphens",
        );
    if (
      new Set(target.environments.map((e) => e.name)).size !==
      target.environments.length
    )
      fail("Environment names must be unique");
    for (const env of target.environments) {
      if (!catalogue.authentication.includes(env.authentication))
        fail("Unsupported authentication method for this platform");
      if (
        Object.keys(env.configuration).some(
          (k) => !catalogue.fields.includes(k),
        )
      )
        fail("Only declared non-secret platform fields are allowed");
      if (
        env.configuration.workspaceUrl &&
        !/^https:\/\/[^/@\s?#]+\/?$/.test(env.configuration.workspaceUrl)
      )
        fail(
          "Use an HTTPS workspace origin without credentials, paths or query parameters",
        );
      if (new Set(env.secrets.map((s) => s.name)).size !== env.secrets.length)
        fail("Secret variable names must be unique");
      if (
        env.secrets.some((s) => s.source === "databricks-scope") &&
        target.provider !== "databricks"
      )
        fail("Databricks scopes require a Databricks target");
      if (
        env.purpose !== "development" &&
        env.secrets.some((s) => s.source === "local-env")
      )
        fail("Local environment secrets are only for development environments");
    }
  });
export const platformConfigurationSchema = z
  .object({
    targets: z.array(platformTargetSchema).max(3),
    environments: z
      .array(
        z
          .object({
            name: environmentName,
            purpose: z.enum(["development", "test", "production"]),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.environments) {
      if (
        new Set(v.environments.map((e) => e.name)).size !==
        v.environments.length
      )
        ctx.addIssue({
          code: "custom",
          message: "Shared environment names must be unique",
        });
      for (const target of v.targets)
        for (const env of target.environments) {
          if (
            !v.environments.some(
              (e) => e.name === env.name && e.purpose === env.purpose,
            )
          )
            ctx.addIssue({
              code: "custom",
              message: "Target bindings must match a shared environment",
            });
        }
    }
    if (new Set(v.targets.map((t) => t.provider)).size !== v.targets.length)
      ctx.addIssue({
        code: "custom",
        message: "Target providers must be unique",
      });
  });
