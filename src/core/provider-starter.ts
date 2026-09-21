import { stringify } from "yaml";
import { existsSync } from "node:fs";
import { preview } from "./authoring.js";
import { fence } from "./packages.js";
import { check } from "./errors.js";

/** A complete offline example, deliberately without a platform execution adapter. */
export function scaffoldProvider(
  root: string,
  args: { id: string; out: string },
) {
  const { id, out } = args;
  check(
    /^[a-z][a-z0-9-]*$/.test(id),
    "PROVIDER",
    "Provider id must use lowercase letters, digits and hyphens, starting with a letter",
  );
  const module = `const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function validate(plan) {
 if (plan.nodes.length !== 1 || plan.nodes[0].platform !== ${JSON.stringify(id)}) throw new Error('One example activity is required');
 if (!identifier.test(plan.nodes[0].with.target)) throw new Error('Invalid target identifier');
 if (plan.nodes[0].needs.length || plan.delivery?.imports.length) throw new Error('This starter has no input adapter');
}
export function render(plan) {
 validate(plan);
 return {'model.sql':{format:'text',value:'CREATE VIEW '+plan.nodes[0].with.target+' AS SELECT 1 AS id;\\n'}};
}
`;
  const contract = {
    apiVersion: "v3.1.0",
    kind: "DataContract",
    id: "example",
    name: "example",
    version: "1.0.0",
    status: "draft",
    schema: [
      {
        name: "example",
        logicalType: "object",
        physicalType: "table",
        properties: [
          {
            name: "id",
            logicalType: "integer",
            physicalType: "BIGINT",
            required: true,
          },
        ],
      },
    ],
  };
  const files: Record<string, string> = {
    "plugin/provider.yaml": stringify({
      apiVersion: "ingestron.provider/v1",
      id,
      version: "0.1.0",
      platform: id,
      compatibility: {
        plan: "ingestron.plan/v1",
        minimumCli: "4.2.0",
        requiredFeatures: ["native-project", "delivery-exports"],
      },
      capabilities: { artifactKinds: ["sql-project"], delivery: true },
      configurationSchema: { type: "object", additionalProperties: false },
      activities: { example: "./activity.yaml" },
      renderer: {
        apiVersion: "ingestron.provider-generation/v1",
        module: "./index.mjs",
      },
    }),
    "plugin/activity.yaml": stringify({
      apiVersion: "ingestron.activity/v1",
      id: "example",
      version: "1.0.0",
      description:
        "Synthetic SQL generator; replace with a tested platform implementation",
      platform: id,
      input: "relation",
      output: "relation",
      effect: "stage",
      optionsSchema: {
        type: "object",
        additionalProperties: false,
        required: ["target"],
        properties: {
          target: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        },
      },
      generator: { kind: "native-project", artifactKind: "sql-project" },
    }),
    "plugin/index.mjs": module,
    "project.yaml": stringify({
      apiVersion: "ingestron.project/v1",
      id: "example",
      providers: {
        packages: {
          example: { source: "./plugin/provider.yaml", version: "0.1.0" },
        },
        configurations: { example: { package: "example", binding: "example" } },
      },
      defaults: { provider: "example" },
      environments: {
        dev: {
          apiVersion: "ingestron.environment/v1",
          environment: "dev",
          bindings: { example: { kind: id } },
        },
      },
      flows: [
        {
          apiVersion: "ingestron.flow/v1",
          kind: "transformation",
          id: "model",
          steps: [
            {
              id: "example",
              uses: "example",
              with: { target: "example_view" },
            },
          ],
          publishes: {
            example: { from: "steps.example.outputs.result", contract },
          },
        },
      ],
    }),
    "package.json":
      JSON.stringify(
        {
          name: `provider-${id}`,
          version: "0.1.0",
          private: true,
          type: "module",
          scripts: {
            test: "node --test test/*.test.mjs",
            check: "ingestron --no-input plugin check --delivery",
          },
          engines: { node: ">=22 <23" },
        },
        null,
        2,
      ) + "\n",
    "test/provider.test.mjs": `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {render} from '../plugin/index.mjs';
const plan=()=>({nodes:[{platform:${JSON.stringify(id)},with:{target:'example_view'},needs:[]}]});
test('deterministic SQL and identifier safety',()=>{assert.deepEqual(render(plan()),render(plan()));const p=plan();p.nodes[0].with.target='view; DROP TABLE data';assert.throws(()=>render(p),/identifier/);});
test('unsupported inputs fail closed',()=>{const p=plan();p.nodes[0].needs=['other'];assert.throws(()=>render(p),/input adapter/);});
`,
    "README.md": `# ${id} provider starter\n\nThis runnable synthetic SQL generator is an authoring example. It has no platform connection or execution adapter.\n\nWith Node 22 and the candidate Ingestron CLI installed, run:\n\n\`\`\`sh\nnode --test test/*.test.mjs\ningestron --no-input plugin check --delivery\ningestron --no-input build --delivery --out out\n\`\`\`\n\nReview out/ingestron-project.json and the exported model.sql. Execution remains not-run. Change the target to an invalid identifier to verify rejection.\n\nBefore publishing: replace the example with platform-owned validation and rendering; declare only implemented capabilities; add model resource identities before sharing native resources; validate handover completion protocols and contract compatibility; declare a versioned pack contract before accepting presets; test installed Git packages, malformed inputs, determinism and edited-output protection. Record offline and native evidence separately. Read the CLI repository docs/contributing/provider-contract.md for the normative contract.\n`,
    "AGENTS.md":
      "Own platform semantics here. Keep compiler hooks deterministic and offline. Run node --test and ingestron plugin check --delivery. Preserve user output; do not call platforms from compiler hooks or tests.\n",
    "SECURITY.md":
      "Do not include secrets or source data in packages or fixtures. Compiler hooks are offline; credentials belong in customer execution context. Report suspected vulnerabilities privately to the repository owner.\n",
    ".gitignore": "out/\nnode_modules/\n.ingestron/\n",
  };
  const replacements = Object.fromEntries(
    Object.entries(files).map(([name, text]) => {
      const path = `${out}/${name}`;
      check(
        !existsSync(fence(root, path)),
        "OWNER",
        `Refusing to replace ${path}`,
      );
      return [path, text];
    }),
  );
  return preview(root, replacements);
}
