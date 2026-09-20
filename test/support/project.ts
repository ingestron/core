import { execFileSync } from "node:child_process";
import { installPackage } from "../../src/core/packages.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { stringify } from "yaml";
const contract = (id: string) => ({
  apiVersion: "v3.1.0",
  kind: "DataContract",
  id,
  name: id,
  version: "1.0.0",
  status: "draft",
  schema: [
    {
      name: id,
      logicalType: "object",
      physicalType: "table",
      properties: [
        {
          name: "id",
          logicalType: "integer",
          physicalType: "BIGINT",
          required: true,
          primaryKey: true,
        },
        { name: "name", logicalType: "string", physicalType: "STRING" },
      ],
    },
  ],
});
export function fixture(t: any) {
  const root = mkdtempSync(resolve(tmpdir(), "ingestron-core-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name: string, value: any) => {
    const file = resolve(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : stringify(value));
  };
  const flow: any = {
    apiVersion: "ingestron.flow/v1",
    kind: "ingestion",
    id: "source",
    ingestion: {
      standard: "snapshot-with-history@v1",
      pipeline: "source",
      target: { schema: "current", historySchema: "history" },
      source: {
        delivery: "complete-snapshot",
        scope: "full-table",
        deletes: "missing-keys",
      },
      retention: { sourceDeliveries: "not-retained" },
    },
    defaults: {
      source: {
        binding: "files",
        format: "parquet",
        path: "/Volumes/dev_retail/landing/source/{{table.id}}",
        deliveryIndex:
          "/Volumes/dev_retail/landing/source/{{table.id}}/deliveries.json",
      },
    },
    tables: {
      customers: {
        source: {},
        contract: { $resolve: "./contracts/customers.yaml" },
      },
      orders: {
        source: {},
        contract: { $resolve: "./contracts/orders.yaml" },
      },
    },
  };
  const project: any = {
    apiVersion: "ingestron.project/v1",
    id: "retail",
    providers: {
      packages: { dbx: { source: "example/fixture", version: "1.0.0" } },
      configurations: { engineering: { package: "dbx", binding: "lakehouse" } },
    },
    defaults: { provider: "engineering" },
    environments: {
      dev: {
        apiVersion: "ingestron.environment/v1",
        environment: "dev",
        values: { catalog: "{{env}}_{{project.id}}" },
        bindings: {
          lakehouse: {
            kind: "databricks",
            host: "https://example.invalid",
            catalog: "{{values.catalog}}",
          },
          files: { kind: "adls" },
        },
      },
    },
    flows: [{ $resolve: "./flows/source/flow.yaml" }],
  };
  installFixture(root);
  put("project.yaml", project);
  put("flows/source/flow.yaml", flow);
  put("flows/source/contracts/customers.yaml", contract("customers"));
  put("flows/source/contracts/orders.yaml", contract("orders"));
  return { root, put, flow, project };
}

export function installFixture(root: string) {
  const origin = resolve(root, "fixture-origin");
  mkdirSync(resolve(origin, "plugin"), { recursive: true });
  const save = (name: string, value: any) =>
    writeFileSync(
      resolve(origin, "plugin", name),
      typeof value === "string" ? value : stringify(value),
    );
  save("provider.yaml", {
    apiVersion: "ingestron.provider/v1",
    id: "fixture",
    compatibility: { plan: "ingestron.plan/v1", minimumCli: "4.2.0" },
    version: "1.0.0",
    platform: "databricks",
    configurationSchema: { type: "object" },
    planner: {
      apiVersion: "ingestron.provider-planning/v1",
      module: "./index.mjs",
    },
    renderer: {
      apiVersion: "ingestron.provider-generation/v1",
      module: "./index.mjs",
    },
    lifecycle: {
      apiVersion: "ingestron.provider-lifecycle/v1",
      module: "./index.mjs",
    },
    activities: { "lakeflow-ingest": "./activity.yaml" },
  });
  save("activity.yaml", {
    apiVersion: "ingestron.activity/v1",
    id: "lakeflow-ingest",
    version: "1.0.0",
    platform: "databricks",
    description: "Synthetic compiler fixture",
    input: "source",
    output: "relation",
    effect: "read",
    optionsSchema: { type: "object" },
    generator: { kind: "native-notebook" },
  });
  save(
    "index.mjs",
    `
 export function expand(r){return {steps:Object.keys(r.flow.tables).map(t=>({id:'ingest_'+t,uses:'lakeflow-ingest@v1',select:[t],with:{}})),recovery:{}};}
 export function model(r){return {with:r.node.with,datasets:{},targets:[r.tableName]};}
 export function validate(){}
 export function validateOutput(){return {documents:[]};}
 export function render(p){return Object.fromEntries([['databricks.yml',{format:'yaml',value:{fixture:true}}],...p.nodes.map(n=>['pipelines/'+n.flow+'/'+n.table+'.ipynb',{format:'json',value:{cells:[{cell_type:'code',source:['pass'],metadata:{},outputs:[],execution_count:null}],metadata:{},nbformat:4,nbformat_minor:5}}])]);}
 export function author(r){const o=r.options;let files={};if(r.operation==='initialise'){
 files['project.yaml']=JSON.stringify({apiVersion:'ingestron.project/v1',id:o.id,providers:{packages:{native:r.provider},configurations:{default:{package:'native',binding:'platform'}}},defaults:{provider:'default'},environments:Object.fromEntries(o.environments.map(e=>[e,{$resolve:'./environments/'+e+'.yaml'}])),flows:[]});
 for(const e of o.environments)files['environments/'+e+'.yaml']=JSON.stringify({apiVersion:'ingestron.environment/v1',environment:e,bindings:{platform:{kind:'databricks'}},values:{}});
 files['README.md']='Synthetic fixture';
 }else files['flows/'+o.id+'/flow.yaml']=JSON.stringify({apiVersion:'ingestron.flow/v1',kind:o.kind,id:o.id,ingestion:{standard:o.standard},tables:{}});return {files};}
 `,
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: origin, stdio: "pipe" });
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  git("tag", "1.0.0");
  installPackage(root, "example/fixture@1.0.0", { fromGit: origin });
}
