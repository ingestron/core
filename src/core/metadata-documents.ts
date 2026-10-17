import { canonical, check, digest, isMap } from "./errors.js";

export const metadataDocumentsVersion = "ingestron.metadata-documents/v1";

/** Reattach Core-owned bytes only where assembly preserves their original runner. */
export function composeMetadataDocuments(
  artifacts: Record<string, string>,
  connections: {
    flow: string;
    artifacts: Record<string, string>;
    documents: Record<string, string>;
  }[],
  roots: unknown,
) {
  check(
    isMap(roots) &&
      Object.keys(roots).length === connections.length &&
      connections.every(({ flow }) => Object.hasOwn(roots, flow)),
    "PROVIDER",
    "Assembly must locate every indexed metadata collection",
  );
  const result = { ...artifacts };
  const locations: string[] = [];
  for (const connection of connections) {
    const location = roots[connection.flow];
    check(
      typeof location === "string" &&
        location.length <= 200 &&
        /^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/.test(
          location,
        ) &&
        locations.every(
          (other) =>
            other !== location &&
            !other.startsWith(location + "/") &&
            !location.startsWith(other + "/"),
        ),
      "PROVIDER",
      "Assembly metadata roots must be safe and separate",
    );
    locations.push(location);
    for (const [name, content] of Object.entries(connection.artifacts))
      check(
        Object.hasOwn(artifacts, `${location}/${name}`) &&
          artifacts[`${location}/${name}`] === content,
        "PROVIDER",
        "Assembly cannot change an indexed connection's runner or references",
      );
    for (const [name, content] of Object.entries(connection.documents)) {
      check(
        /^metadata\/project\/[a-f0-9]{64}\.json$/.test(name) &&
          name === `metadata/project/${digest(content)}.json` &&
          !Object.hasOwn(result, `${location}/${name}`),
        "PROVIDER",
        "Assembly cannot replace compiler-owned metadata documents",
      );
      result[`${location}/${name}`] = content;
    }
  }
  return result;
}

/** Encode complete documents; references bind exact bytes, including unmanaged metadata. */
export function projectTableDocuments(tables: Record<string, unknown>) {
  const entries = Object.entries(tables);
  check(
    entries.length >= 1 && entries.length <= 100,
    "SOURCE_METADATA_COLLECTION_LIMIT",
    "Select 1–100 metadata documents",
  );
  let totalBytes = 0;
  const artifacts: Record<string, string> = {};
  const records = entries.map(([name, table]) => {
    check(
      /^[A-Za-z_][A-Za-z0-9_-]{0,100}$/.test(name) && isMap(table),
      "CONNECTION",
      "Invalid metadata document identity",
    );
    JSON.stringify(table, (_key, value) => {
      check(
        typeof value !== "number" || Number.isFinite(value),
        "CONNECTION",
        "Metadata requires finite JSON numbers",
      );
      return value;
    });
    const content = canonical(table),
      bytes = Buffer.byteLength(content);
    check(
      bytes <= 2_000_000,
      "SOURCE_METADATA_LIMIT",
      "A table exceeds the 2 MB metadata document limit",
    );
    totalBytes += bytes;
    check(
      totalBytes <= 7_000_000,
      "SOURCE_METADATA_COLLECTION_LIMIT",
      "Tables exceed the 7 MB metadata collection limit",
    );
    const sha256 = digest(content),
      path = `metadata/project/${sha256}.json`;
    artifacts[path] = content;
    return [name, { path, sha256, bytes }];
  });
  return {
    index: {
      apiVersion: metadataDocumentsVersion,
      kind: "project",
      documents: Object.fromEntries(records),
      totalBytes,
    },
    artifacts,
  };
}
