import type { Programme } from "./programme-schema.js";
/** Stable human references; internal IDs and external links are never rewritten. */
export function withWorkItemKeys(input: Programme): Programme {
  const doc = structuredClone(input);
  const reserved = new Set(
    doc.requirements
      .map((r) => r.key ?? (r.id.length <= 12 ? r.id : ""))
      .filter(Boolean),
  );
  const assigned = new Set(doc.requirements.map((r) => r.key).filter(Boolean));
  let next = doc.nextWorkItemNumber ?? 1;
  for (const item of doc.requirements) {
    if (item.key) continue;
    if (item.id.length <= 12 && !assigned.has(item.id)) item.key = item.id;
    else {
      const prefix = item.id.split("-")[0]!.slice(0, 6);
      let key: string;
      do {
        key = `${prefix}-${String(next++).padStart(3, "0")}`;
      } while (reserved.has(key));
      item.key = key;
      reserved.add(key);
    }
    assigned.add(item.key);
  }
  doc.nextWorkItemNumber = next;
  return doc;
}
