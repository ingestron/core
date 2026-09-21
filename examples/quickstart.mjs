import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAsync } from "@ingestron/core";
import { validateDocument } from "@ingestron/core/schemas";

const root = mkdtempSync(join(tmpdir(), "ingestron-example-"));
try {
  const proposal = await executeAsync({ root }, "initialise", {
    id: "example",
  });
  assert.equal(proposal.ok, true);
  assert.equal(existsSync(join(root, "project.yaml")), false);

  // A host can present proposal.result.changes for review before granting writes.
  const denied = await executeAsync({ root }, "apply", {
    proposal: proposal.result,
  });
  assert.equal(denied.diagnostics[0].code, "PERMISSION");
  const applied = await executeAsync({ root, allowWrite: true }, "apply", {
    proposal: proposal.result,
  });
  assert.equal(applied.ok, true);
  const checked = await executeAsync({ root }, "validate", { mode: "draft" });
  assert.equal(checked.ok, true);

  const document = validateDocument({
    kind: "environment",
    uri: "untitled:environment",
    content: "apiVersion: ingestron.environment/v1\nvalues: {}\n",
  });
  assert.equal(document.valid, true);
  console.log(
    "Proposal, write protection, project validation and editor validation passed.",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
