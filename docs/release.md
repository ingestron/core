# Core release runbook

Use Node 22 and the committed pnpm lock. Run `pnpm validate`, regenerate the
production dependency inventory with `node scripts/licence-inventory.mjs`, inspect
licence gaps and the packed archive, and verify downstream CLI/editor consumers.
The source import is documented in extraction-provenance.json; it is not an IP
assignment. Do not delete historical CLI releases or rewrite their grants.

Initial private consumers may pin an immutable Git commit; the prepare script
builds this repository without sibling checkouts. Switch to an exact npm version
only after publication exists. Never publish edited bytes over an existing version.

Publication is deliberately blocked in `scripts/release-check.mjs`. Confirm Otrera
legal identity and licensing authority, complete the recorded rights review, enact
the Apache grant and exact release authority, and configure registry authentication
before introducing a public publication workflow. A CI pass is not legal clearance.
