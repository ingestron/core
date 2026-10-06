# Read installed provider activity sources

The private core0.12.49 candidate provides the read-only operation
`provider_activity_inspect`. Supply the exact installed provider `reference` and
an `activity` exported by that provider. There is no arbitrary file-path argument.

The result includes the exact reference and commit, activity manifest, declared
templates with source text/output name/format, optional declared generator source
and package-relative source digests. The selected cache must match its immutable
lock. Source references cannot leave that package. Inspection checks the provider
host compatibility declaration and refuses results larger than 1 MiB. No provider
or activity code executes.

An absent generator-source field means the activity does not declare one. It does
not mean the provider has no generation implementation. Composition and actual
generated output remain the owning provider's responsibility.

`provider_migrate` remains a preview of the selected project package reference.
Its proposal includes hashes of the selected cached package files and the exact
reviewed package reference. Applying the proposal checks the complete locked file
inventory, reviewed file contents and project/lock revision. Added, removed or
changed files and package symlinks are refused before replacing the project
definition. This does not
migrate runtime checkpoints or deployed resources.
