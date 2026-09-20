/** Editor-safe exports: no filesystem access, runtime loading or plugin execution. */
import { LineCounter, parseDocument, isMap, isSeq } from "yaml";
import {
  projectSchema,
  flowSchema,
  environmentSchema,
  stepSchema,
} from "../core/schema.js";
export { projectSchema, flowSchema, environmentSchema, stepSchema };
export const documentSchemas = {
  project: projectSchema,
  flow: flowSchema,
  environment: environmentSchema,
  step: stepSchema,
} as const;
export type DocumentKind = keyof typeof documentSchemas;
export interface DocumentDiagnostic {
  code: string;
  message: string;
  file: string;
  pointer: string;
  /** Zero-based UTF-16 offsets into the supplied content; end is exclusive. */
  range: { start: number; end: number };
  /** One-based line and column for the start offset. */
  line: number;
  column: number;
}
export interface DocumentValidation {
  apiVersion: "ingestron.document-validation/v1";
  valid: boolean;
  diagnostics: DocumentDiagnostic[];
}
/** Validate the caller's unsaved YAML/JSON buffer, never the on-disk file. */
export function validateDocument(input: {
  kind: DocumentKind;
  content: string;
  uri: string;
}): DocumentValidation {
  const lines = new LineCounter();
  const doc = parseDocument(input.content, { lineCounter: lines });
  const diagnostics: DocumentDiagnostic[] = [];
  const add = (
    code: string,
    message: string,
    path: PropertyKey[],
    start: number,
    end: number,
  ) => {
    const position = lines.linePos(start);
    diagnostics.push({
      code,
      message,
      file: input.uri,
      pointer: path.length
        ? "/" +
          path
            .map((p) => String(p).replaceAll("~", "~0").replaceAll("/", "~1"))
            .join("/")
        : "",
      range: { start, end },
      line: position.line,
      column: position.col,
    });
  };
  for (const error of doc.errors)
    add("YAML", error.message, [], error.pos[0], error.pos[1]);
  if (diagnostics.length)
    return {
      apiVersion: "ingestron.document-validation/v1",
      valid: false,
      diagnostics,
    };
  try {
    const schema = Object.hasOwn(documentSchemas, input.kind)
      ? documentSchemas[input.kind]
      : undefined;
    if (!schema) {
      add("SCHEMA", "Unsupported document kind", [], 0, 0);
    } else {
      const result = schema.safeParse(doc.toJS({ maxAliasCount: 100 }));
      if (!result.success)
        for (const issue of result.error.issues) {
          let node: unknown = doc.contents;
          for (const key of issue.path) {
            const child =
              isMap(node) || isSeq(node) ? node.get(key, true) : undefined;
            if (!child) break;
            node = child;
          }
          const range =
            node && typeof node === "object" && "range" in node
              ? (node.range as [number, number, number] | null)
              : null;
          add(
            "SCHEMA",
            issue.message,
            issue.path,
            range?.[0] ?? 0,
            range?.[1] ?? 0,
          );
        }
    }
  } catch (error) {
    add(
      "YAML",
      error instanceof Error ? error.message : String(error),
      [],
      0,
      0,
    );
  }
  return {
    apiVersion: "ingestron.document-validation/v1",
    valid: diagnostics.length === 0,
    diagnostics,
  };
}
