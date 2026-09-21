# Core release runbook

Use Node 22 and pnpm 10.15.0. Run `pnpm validate`, `pnpm licences:inventory`
and `pnpm audit --prod`. Inspect packed files and preserve the upstream notices.
The original-code licence is Apache-2.0; Otrera Limited is the licensor selected by
the owner. No further company/IP evidence collection is part of this release task.

Publish from the reviewed commit with `npm publish --access public` after npm
account authentication. Never overwrite an existing version. Record the registry
integrity and source commit, then install the exact version in an empty directory
without Git credentials or sibling repositories. CLI consumes that exact registry
version; it must not require a Git-hosted prepare step. Source and package visibility
are verified independently. Native providers have their own release scope.
