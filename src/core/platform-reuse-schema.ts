/** Versioned shared declarations; they confer no source or cloud permissions. */
import { z } from "zod";
import { secretFields } from "./secret-fields.js";
const id = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/);
const text = z.string().trim().min(1).max(200);
const reference = z
  .string()
  .max(500)
  .regex(/^[A-Za-z0-9_./-]+@(?:[a-f0-9]{40}|\d+\.\d+\.\d+)$/);
const consumers = z
  .array(z.string().min(1).max(160))
  .min(1)
  .max(100)
  .refine((v) => new Set(v).size === v.length, "Choose distinct consumers");
const settings = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  let nodes = 0;
  const walk = (v: any, path: (string | number)[], depth: number): void => {
    const fail = (message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    if (++nodes > 5000 || depth > 20) {
      fail("Shared settings exceed supported bounds");
      return;
    }
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach((child, i) => walk(child, [...path, i], depth + 1));
      return;
    }
    if (Object.hasOwn(v, "$secret")) {
      const ref = v.$secret;
      if (
        Object.keys(v).length !== 1 ||
        !ref ||
        typeof ref !== "object" ||
        Object.keys(ref).length !== 1 ||
        typeof ref.env !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.env) ||
        /^(PYTHON|PIP|LD_|DYLD_|PATH$|HOME$|TMPDIR$)/i.test(ref.env)
      )
        fail("Use an explicit runtime secret environment reference");
      return;
    }
    for (const [key, child] of Object.entries(v)) {
      if (
        ["__proto__", "constructor", "prototype", "$env", "$resolve"].includes(
          key,
        )
      )
        fail(
          "Shared settings must contain resolved data and runtime secret references",
        );
      if (
        secretFields.has(key) &&
        !(child && typeof child === "object" && Object.hasOwn(child, "$secret"))
      )
        fail("Use runtime secret references for credential fields");
      if (
        key === "jdbcUrl" &&
        typeof child === "string" &&
        /(password|pwd|token|accesskey)\s*=/i.test(child)
      )
        fail("Keep credentials out of JDBC URLs");
      walk(child, [...path, key], depth + 1);
    }
  };
  walk(value, [], 0);
});
export const sharedPackageSchema = z
  .object({
    id,
    name: text,
    owner: text,
    purpose: z.string().trim().max(2000),
    consumers,
    reference,
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    kind: z.enum([
      "provider",
      "connector",
      "model-pack",
      "report-pack",
      "activity-pack",
    ]),
    packageId: text,
    version: text,
  })
  .strict();
export const sharedConnectionSchema = z
  .object({
    id,
    name: text,
    owner: text,
    purpose: z.string().trim().max(2000),
    consumers,
    reference,
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    sourceId: id,
    tenantId: id,
    environments: z
      .record(id, z.object({ settings }).strict())
      .refine(
        (v) => Object.keys(v).length >= 1 && Object.keys(v).length <= 20,
        "Declare between 1 and 20 shared environments",
      ),
  })
  .strict();
export const platformReuseSchema = z
  .object({
    packages: z.array(sharedPackageSchema).max(100).default([]),
    connections: z.array(sharedConnectionSchema).max(100).default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const key of ["packages", "connections"] as const)
      if (new Set(v[key].map((x) => x.id)).size !== v[key].length)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Choose distinct shared definition IDs",
        });
  });
export const sharedConnectionBindingSchema = z
  .object({
    programmeId: id,
    platformId: id,
    sharedConnection: id,
    sharedEnvironment: id,
    projectEnvironment: id,
    connection: id,
    packageAlias: id,
    binding: id,
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    reference,
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    materialised: z
      .object({
        sourceId: id,
        tenantId: id,
        settings,
      })
      .strict(),
  })
  .strict();
