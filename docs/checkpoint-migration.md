# Continue a checkpoint after a runtime upgrade

The private core 0.12.42, CLI 0.17.18, local provider 0.4.14 and PostgreSQL
1.1.7 candidates provide reviewed migration for an existing ordered append
history. A migration preserves the committed cursor when only compatible runtime
or package provenance changes. It writes an immutable transition alongside the
existing commits; it does not rewrite Parquet, reset a cursor or read source rows.

[Retain the previous managed build](build-retention.md), its approved review and
original locked packages before replacing it. Build the current package into the original output
directory, preserving its data directory. Prepare its locked runtime, discover,
review and approve the current extraction. Current and previous builds must belong
to the same project, environment, provider configuration, profile and single flow.
The previous compiler may be historical; the current build must use the current
compiler. The shared Studio upgrade journey remains unfinished.

From the project directory, review the transition:

```sh
ingestron checkpoint preview --flow orders_append \
  --from build/studio/dev/orders_append \
  --previous build/checkpoint-baseline/orders_append
```

The result shows the existing batch number, exact cursor and review digest. Apply
that digest with the same selection:

```sh
ingestron checkpoint apply --flow orders_append \
  --from build/studio/dev/orders_append \
  --previous build/checkpoint-baseline/orders_append \
  --digest YOUR_REVIEW_DIGEST
```

Replace `YOUR_REVIEW_DIGEST` with the 64-character digest returned by preview.
A changed checkpoint head produces `CHECKPOINT_MIGRATION_STALE`; preview again.
Then continue the current approved flow with its normal data-run command.

The SDK operations are `checkpoint_preview` and `checkpoint_apply`. Both take
`flow`, `previous` and optional `from`, `profile` and `runId`; apply also requires
`expectedDigest`. Both require write and execution authority. They accept no
secrets file or dependency-network option. Read-only MCP sessions omit both tools;
authorised sessions expose the same operations. Source selection, credentials,
contracts, schema, watermark policy, driver and dependency changes require another
migration strategy and are rejected by this candidate.

Core validates the managed builds, locked provider, current inputs and selection.
It claims both builds for the original operation until the provider acknowledges
its outcome. The selected source owns policy compatibility, reviewed source
identity, full commit/Parquet verification, head freshness and atomic publication.
The local provider transports the request and retains a durable acknowledgement.

Use `run_status` to inspect an uncertain maintenance ID and `execution_recover`
to acknowledge that original ID. Recovery reads the original provider receipt;
it never reapplies maintenance. Defined checkpoint failures retain their code,
without source messages or record values. An acknowledged failed operation stays
failed. Reapplying an already published digest is idempotent after further batches.
Previewing that digest reports `applied: true` and the original transition head;
it remains an inspection, without publishing another transition. Apply requires
an acknowledged committed result. An uncommitted apply result remains uncertain.
Old committed source-run retries retain their original output; this does not
qualify a fresh run with an old compiler.

Installed synthetic PostgreSQL acceptance covers SDK/CLI/MCP agreement, permission
and build-scope refusal, stale review, cursor 2 to 4 to 5, an empty batch, unchanged
first-batch bytes and original-operation acknowledgement. Other migration
strategies, authenticated Studio/editor interaction, finaliser death during
real migration, bounded archive, distributed reservations and vendor qualification
remain separate work.
