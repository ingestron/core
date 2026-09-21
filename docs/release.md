# Releasing core

Use Node 22 and pnpm 10.15.0.

1. Install dependencies with `pnpm install --frozen-lockfile`.
2. After dependency changes, run `pnpm licences:inventory` and review the updated
   `THIRD_PARTY_NOTICES.md`. Full upstream notices must remain intact.
3. Run `pnpm validate` and `pnpm audit --prod`.
4. From the reviewed commit, run `npm pack --pack-destination build/release`
   (create the directory first). Inspect the archive before publishing.
5. Run `npm whoami` to check the publishing account, then
   `npm publish build/release/ingestron-core-<version>.tgz --access public`.
   Complete npm's authentication prompt in your browser using your existing
   security key or passkey. An expired prompt requires a fresh publish attempt.
6. Verify the registry version and integrity, and install that exact version in an
   empty directory without Git credentials or sibling repositories.

Never overwrite an existing version. If a publish attempt has an uncertain outcome,
check `npm view @ingestron/core@<version> version` before retrying. Record the source
commit and registry integrity in the release record. The CLI consumes an exact npm
version of core. Native providers are released separately.
