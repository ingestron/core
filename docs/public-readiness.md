# Public-source readiness — 2026-09-21

Status: technically qualified candidate; public-source and npm release held.

The compiler candidate at `3cea7fa` passes Node 22 validation: 43 tests,
independent packed installation, permission boundaries and the Node-free editor
export. Main contains only the bootstrap commit; the implementation remains in
PR #1. A repository visibility change alone would not publish a usable main branch.

Gitleaks 8.30.1, downloaded from its official release and SHA-256 checked, scanned
all fetched refs and tags (6 reachable commits, 5 with scanned changes). The one
initial match was the exact SHA-256 of `scripts/secrets.mjs` in extraction
provenance; hashing that file confirms it. `.gitleaks.toml` narrowly allows only
that digest at that path. The reviewed scan reports no remaining matches. This
is automated secret-pattern evidence, not comprehensive security/IP clearance.

Before public source release:

- Confirm the current rights holder's authority and enact the intended licence;
  Otrera incorporation/IP evidence is still pending from the owner.
- Review and merge the extraction candidate so main is usable.
- Reconcile repository metadata to `ingestron/core` after the authorised transfer.
- Recheck clean installation without private credentials at the new location.
- Clearly label provider catalogue entries as private previews. Publishing core
  and CLI does not make those providers available to anonymous users.

The intended npm scope remains `@ingestron-io/core`; authority to publish under
that scope has not been established by login to the npm user `ingestron`.
GitHub public source and npm publication are separate checks. Restricted/UNLICENSED
metadata and the prepublish guard remain active until release clearance.

Repeat history scanning with:

```sh
gitleaks git . --config .gitleaks.toml --log-opts="--all --full-history" --redact=100
```

Production dependency audit (`pnpm audit --prod`) reports zero known
vulnerabilities at inspection time. This is not a guarantee of vulnerability-free
code or complete third-party rights clearance.
