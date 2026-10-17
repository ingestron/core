# Reviewed connector lifecycle — local candidate

The local Studio 0.67.0 candidate uses three core operations through the installed
CLI. Public dependency pins are unchanged.

- `connector_library` reads installed packages with registration aliases and
  consumer paths. CLI adds its existing catalogue metadata.
- `connector_change_review` accepts `action` (`install`, `reinstall`, `upgrade`,
  `remove`), an exact `reference`, and optional `registration` and `tagPrefix`.
  It returns a revision-bound proposal, affected consumers and configuration edits.
- `connector_change_apply` consumes that proposal and requires write permission.
  Package access also requires explicit network permission or an approved local
  origin. Clients cannot submit arbitrary configuration edits through this path.

Installation reviews the package and a unique registration together. Upgrade keeps
an existing registration, requires a newer version of the same connector source,
and validates dependent connection settings in every declared environment.
Reinstall verifies the locked commit; a moved tag is rejected. Existing tampered
package caches are rejected by the package installer, not silently overwritten.

Removal rejects resolved consumers, then removes unused registrations and the exact
lock entry. It retains cached package files, source data and generated output.
Referenced root package declaration files need an explicit edit and are rejected
by this convenience operation. File and package revisions are rechecked on apply;
inline connection credentials are rejected before returning review files.
Installation and registration use sequential existing operations, not one global
transaction: a concurrent edit after package installation may leave the package
installed without its registration. Refresh and use Set up connection to recover.

Verification: `pnpm validate` (380 tests), including used-removal denial, exact
reinstall, version upgrade, incompatible-settings denial, stale proposals, write
permissions, unused-registration removal and inline-secret rejection. Installed
UI evidence belongs to Studio's `docs/evidence/connector-lifecycle-20261015/`.
