/** Isolated provider generation: one ES module, JSON in/out, no host APIs. */
import { getQuickJS } from "quickjs-emscripten";
import { readFileSync } from "node:fs";
import { isMap, check } from "../core/errors.js";
const request = JSON.parse(readFileSync(process.argv[2] ?? 0, "utf8"));
try {
  check(
    typeof request.code === "string" && request.code.length <= 2_000_000,
    "PROVIDER",
    "Provider source exceeds 2 MB",
  );
  const engine = await getQuickJS(),
    runtime = engine.newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + 2000;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  runtime.setModuleLoader((name) => {
    if (name !== "provider-entry")
      throw new Error("Provider imports are forbidden");
    return request.code;
  });
  const context = runtime.newContext();
  const evaluate = (source: string, module = false) => {
    const result = context.evalCode(
      source,
      module ? "provider.mjs" : "request.js",
      { type: module ? "module" : "global" },
    );
    if (result.error) {
      const message = context.dump(result.error);
      result.error.dispose();
      throw new Error(message.message ?? String(message));
    }
    const value = context.dump(result.value);
    result.value.dispose();
    return value;
  };
  try {
    evaluate(
      "globalThis.Date = undefined; globalThis.performance = undefined; Math.random = () => { throw new Error('Providers must be deterministic'); };",
    );
    evaluate(
      "import * as provider from 'provider-entry'; globalThis.__provider = provider;",
      true,
    );
    const encoded = JSON.stringify(JSON.stringify(request.input));
    const result = evaluate(
      ["command", "author", "model", "validateOutput"].includes(
        request.operation,
      )
        ? `JSON.stringify((() => { const value = __provider[${JSON.stringify(request.operation)}](JSON.parse(${encoded})); if (value && typeof value.then === 'function') throw new Error('Provider command must be synchronous'); return value; })())`
        : request.operation === "expand"
          ? `JSON.stringify((() => { const value = __provider.expand(JSON.parse(${encoded})); if (value && typeof value.then === 'function') throw new Error('Provider expand must be synchronous'); return value; })())`
          : `JSON.stringify((() => { const input = JSON.parse(${encoded}); const validation = __provider.validate(input); if (validation && typeof validation.then === 'function') throw new Error('Provider validate must be synchronous'); const result = ${request.validateOnly ? "{}" : "__provider.render(input)"}; if (result && typeof result.then === 'function') throw new Error('Provider render must be synchronous'); return result; })())`,
    );
    check(
      typeof result === "string" && result.length <= 8_000_000,
      "PROVIDER",
      "Provider output exceeds 8 MB or is not synchronous JSON",
    );
    const assets = JSON.parse(result);
    check(
      isMap(assets) && Object.keys(assets).length <= 1000,
      "PROVIDER",
      "Provider must return at most 1000 assets",
    );
    if (request.operation === "expand") {
      check(
        Array.isArray(assets.steps) &&
          assets.steps.length <= 1000 &&
          isMap(assets.recovery) &&
          Object.keys(assets).every((k) => ["steps", "recovery"].includes(k)),
        "PROVIDER",
        "Invalid provider planning response",
      );
    }
    for (const [path, asset] of request.operation !== "render"
      ? []
      : Object.entries(assets)) {
      check(
        path.length <= 512 &&
          !path.startsWith("/") &&
          !path.includes("\\") &&
          !path.includes("\0") &&
          path.split("/").every((p) => p && p !== "." && p !== ".."),
        "PROVIDER",
        "Unsafe provider output path",
      );
      check(
        isMap(asset) &&
          ["json", "yaml", "text"].includes(asset.format) &&
          Object.hasOwn(asset, "value") &&
          Object.keys(asset).every((k) => ["format", "value"].includes(k)),
        "PROVIDER",
        "Invalid provider asset envelope",
      );
      check(
        asset.format !== "text" || typeof asset.value === "string",
        "PROVIDER",
        "Text asset must contain a string",
      );
    }
    process.stdout.write(JSON.stringify({ ok: true, assets }));
  } finally {
    context.dispose();
    runtime.dispose();
  }
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
