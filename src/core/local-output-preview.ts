/** Bounded inspection of committed local Parquet artefacts. Never queries a source. */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { fence } from "./packages.js";
import { check, digest, Problem } from "./errors.js";
const read = promisify(execFile);
const maxBytes = 64 * 1024 * 1024;
const previewSchema = z
  .object({
    columns: z.array(z.string().min(1).max(128)).min(1).max(100),
    rows: z
      .array(
        z
          .array(
            z.union([
              z.string().max(500),
              z.number().finite(),
              z.boolean(),
              z.null(),
            ]),
          )
          .max(100),
      )
      .max(20),
    truncated: z.boolean(),
    cellsTruncated: z.boolean(),
  })
  .strict();
const script = String.raw`
import json,sys,math,hashlib
from decimal import Decimal
from datetime import date,datetime,time
import pyarrow.parquet as pq
path,expected,total,limit=sys.argv[1:]
with open(path,'rb') as file:
    if hashlib.sha256(file.read()).hexdigest()!=expected: raise ValueError()
    file.seek(0)
    parquet=pq.ParquetFile(file)
    if parquet.metadata.num_rows!=int(total) or sum(parquet.metadata.row_group(i).total_byte_size for i in range(parquet.metadata.num_row_groups))>67108864: raise ValueError()
    columns=parquet.schema_arrow.names
    if not 1<=len(columns)<=100 or len(set(columns))!=len(columns) or any(not 1<=len(c)<=128 for c in columns): raise ValueError()
    clipped=False
    def cell(v):
        global clipped
        if v is None or type(v) is bool: return v
        if type(v) is int and abs(v)<=9007199254740991: return v
        if type(v) is float and math.isfinite(v): return v
        if isinstance(v,(date,datetime,time)): v=v.isoformat()
        elif isinstance(v,bytes): v='[binary: '+str(len(v))+' bytes]'
        elif not isinstance(v,str): v=str(v)
        if len(v)>500: clipped=True;v=v[:499]+'…'
        return v
    rows=[]
    for batch in parquet.iter_batches(batch_size=int(limit),use_threads=False):
        rows=[[cell(record[c]) for c in columns] for record in batch.to_pylist()]
        break
    print(json.dumps({'columns':columns,'rows':rows,'truncated':int(total)>len(rows),'cellsTruncated':clipped},allow_nan=False))
`;
function regular(file: string, limit: number) {
  const stat = lstatSync(file);
  check(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit,
    "LIMIT",
    "Local output exceeds inspection bounds",
  );
}
export async function previewLocalOutput(
  root: string,
  packageRoot: string,
  input: {
    flow: string;
    run: string;
    stream: string;
    sha256: string;
    rows: number;
    runtime: unknown;
    limit: number;
  },
) {
  check(
    typeof input.runtime === "string" && /^[a-f0-9]{64}$/.test(input.runtime),
    "RUNTIME",
    "Local runtime identity is unavailable",
  );
  const runtime = fence(root, `.ingestron/runtimes/${input.runtime}`);
  const ready = fence(runtime, "ready.json");
  regular(ready, 4096);
  check(
    JSON.parse(readFileSync(ready, "utf8")).lock === input.runtime,
    "RUNTIME",
    "Local runtime identity changed",
  );
  // The venv interpreter is an intentional symlink; its containing path is fenced.
  const python = `${fence(runtime, "bin")}/python`;
  check(existsSync(python), "RUNTIME", "Local runtime is unavailable");
  const directory = fence(packageRoot, `data/${input.flow}`);
  const namespaces = readdirSync(directory, { withFileTypes: true });
  check(
    namespaces.length <= 200,
    "LIMIT",
    "Local output has too many namespaces to inspect",
  );
  const candidates = namespaces
    .filter((n) => n.isDirectory() && /^[a-f0-9]{64}$/.test(n.name))
    .map((n) => fence(directory, `${n.name}/${input.run}`))
    .filter(existsSync);
  check(
    candidates.length === 1,
    "SELECT",
    "Saved run output is missing or ambiguous",
  );
  const folder = candidates[0]!;
  const commitFile = fence(folder, "commit.json");
  regular(commitFile, 1024 * 1024);
  const commitBytes = readFileSync(commitFile);
  const commit = JSON.parse(commitBytes.toString("utf8"));
  check(
    [
      "ingestron-singer-local-snapshot/preview-1",
      "ingestron-local-incremental/v1",
    ].includes(commit.format) &&
      commit.identity?.run_id === input.run &&
      Array.isArray(commit.tables) &&
      commit.tables.filter(
        (t: any) =>
          t.stream === input.stream &&
          t.sha256 === input.sha256 &&
          t.rows === input.rows,
      ).length === 1,
    "RECEIPT",
    "Committed output differs from the saved run",
  );
  const file = fence(folder, `${input.stream}.parquet`);
  regular(file, maxBytes);
  check(
    digest(readFileSync(file)) === input.sha256,
    "RECEIPT",
    "Output content changed after ingestion",
  );
  try {
    const { stdout } = await read(
      python,
      [
        "-I",
        "-c",
        script,
        file,
        input.sha256,
        String(input.rows),
        String(input.limit),
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          LANG: "C.UTF-8",
          PYTHONDONTWRITEBYTECODE: "1",
        },
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      },
    );
    const preview = previewSchema.parse(JSON.parse(stdout));
    check(
      preview.rows.length <= input.limit &&
        preview.rows.every((r) => r.length === preview.columns.length),
      "LIMIT",
      "Data preview exceeded its bounds",
    );
    check(
      digest(readFileSync(file)) === input.sha256 &&
        digest(readFileSync(commitFile)) === digest(commitBytes),
      "STALE",
      "Output changed during inspection",
    );
    return preview;
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(
      "PREVIEW",
      "Cannot inspect this local output; verify its saved receipt and prepared Parquet runtime",
    );
  }
}
