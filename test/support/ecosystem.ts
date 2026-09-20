import { fixture } from "./project.js";

export function ecosystem(t: any) {
  const f = fixture(t);
  const reviewed = { $resolve: "./flows/source/contracts/customers.yaml" };
  const manifests: Record<string, any> = {};
  for (const platform of ["loader", "sqlmodel"]) {
    const manifest = (manifests[platform] = {
      apiVersion: "ingestron.provider/v1",
      id: platform,
      version: "1.0.0",
      platform,
      compatibility: {
        plan: "ingestron.plan/v1",
        minimumCli: "4.2.0",
        requiredFeatures: [
          "native-project",
          "extension-packs",
          "delivery-exports",
          "relation-handovers",
        ],
      },
      capabilities: {
        artifactKinds: ["sql-project"],
        handovers: ["files", "relation"],
        delivery: true,
        packContracts: {
          "source-presets": { version: "1.0.0", activities: ["query"] },
        },
      },
      configurationSchema: { type: "object", additionalProperties: false },
      activities: { query: "./query.yaml" },
      renderer: {
        apiVersion: "ingestron.provider-generation/v1",
        module: "./index.mjs",
      },
    });
    f.put(`${platform}/provider.yaml`, manifest);
    f.put(`${platform}/query.yaml`, {
      apiVersion: "ingestron.activity/v1",
      id: "query",
      version: "1.0.0",
      platform,
      description: "Synthetic SQL project",
      input: "relation",
      output: "relation",
      effect: "stage",
      generator: { kind: "native-project", artifactKind: "sql-project" },
      optionsSchema: {
        type: "object",
        properties: { label: { type: "string" } },
        additionalProperties: false,
      },
    });
    f.put(
      `${platform}/index.mjs`,
      `export function validate(p) { if(p.nodes.some(n=>n.platform!==${JSON.stringify(platform)})) throw new Error('foreign nodes'); if(p.delivery && p.nodes.some(n=>n.needs.some(d=>!p.nodes.some(x=>x.id===d)))) throw new Error('foreign dependency'); } export function render(p) { return {'model.sql':{format:'text',value:'select 1;\\n'},'context.json':{format:'json',value:{labels:p.nodes.map(n=>n.with.label),imports:p.delivery?.imports??[],bindings:Object.keys(p.bindings)}}}; }`,
    );
  }
  const pack: any = {
    apiVersion: "ingestron.extension-pack/v1",
    id: "sample-source",
    version: "1.0.0",
    description: "Synthetic source preset",
    extends: {
      provider: "loader",
      version: "1.0.0",
      platform: "loader",
      contract: "source-presets",
      contractVersion: "1.0.0",
    },
    activities: { customers: { uses: "query", with: { label: "from-pack" } } },
  };
  f.project.providers = {
    packages: Object.fromEntries(
      Object.keys(manifests).map((id) => [
        id,
        { source: `./${id}/provider.yaml`, version: "1.0.0" },
      ]),
    ),
    packs: { sample: { source: "./pack/pack.yaml", version: "1.0.0" } },
    configurations: {
      load: { package: "loader", binding: "loader", packs: ["sample"] },
      model: { package: "sqlmodel", binding: "sqlmodel" },
    },
  };
  f.project.defaults.provider = "load";
  f.project.environments.dev.bindings = {
    loader: { kind: "loader" },
    sqlmodel: { kind: "sqlmodel" },
    warehouse: { kind: "warehouse" },
  };
  f.project.flows = [
    {
      apiVersion: "ingestron.flow/v1",
      id: "landing",
      kind: "transformation",
      provider: "load",
      steps: [{ id: "load", uses: "sample:customers" }],
      publishes: {
        customers: {
          from: "steps.load.outputs.result",
          contract: reviewed,
          location: {
            kind: "relation",
            binding: "warehouse",
            name: "raw.customers",
          },
        },
      },
    },
    {
      apiVersion: "ingestron.flow/v1",
      id: "models",
      kind: "transformation",
      provider: "model",
      requires: {
        raw: {
          dataset: "retail.landing.customers",
          handover: "relation",
          select: { mode: "same-run" },
        },
      },
      steps: [
        { id: "model", uses: "query", with: { label: "reviewed-model" } },
      ],
      publishes: {
        customers: { from: "steps.model.outputs.result", contract: reviewed },
      },
    },
  ];
  const save = () => {
    f.put("project.yaml", f.project);
    f.put("pack/pack.yaml", pack);
    for (const [id, m] of Object.entries(manifests))
      f.put(`${id}/provider.yaml`, m);
  };
  save();
  return { ...f, pack, manifests, save };
}
