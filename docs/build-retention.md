# Retain a build before upgrading

The private core 0.12.40 and CLI 0.17.18 candidates can retain a managed build,
including its approved source review and committed output, before a package or
project upgrade. Run this from the project directory before changing its inputs
or package lock:

```sh
ingestron checkpoint retain --from build/studio/dev/orders_append \
  --to build/checkpoint-baseline/orders_append
```

Select a new, separate destination. Add `--profile NAME` if the original build
uses a named profile. The result gives the destination, file count, byte count
and content digest. It copies existing output; it reads no source system and
requires no secrets file, execution authority or network access.

Keep the retained directory private: it contains the original review and data.
The copy preserves file bytes and executable flags, gives the new directories
and files access only to their owner, and excludes core execution leases and
generation locks. It accepts at most 10000 entries, 20 directory levels and
256 MiB. It refuses symlinks, changed generated files, changed project inputs,
a different profile, active or uncertain managed work, and existing destinations.
Finish or recover the original work before retaining it. Stop any separately
started standalone runner first.

Upgrade and build into the original working directory, preserving its committed
data. The retained build has an integrity receipt. Checkpoint preview and apply
verify every retained byte before dispatch, including the approved review and
original output. Changing that copy requires recovering the original baseline.

The SDK operation is `build_retain`, with `from`, `to` and optional `profile`.
It requires local write authority. Read-only MCP sessions omit it.
A historical compiler is permitted for retention; this does not qualify the
old build for fresh execution. Managed generation cannot overwrite a retained
baseline or run fresh work there: select the working directory for further builds
and execution.

Continue with [reviewed checkpoint migration](checkpoint-migration.md). Studio
and editor retention controls, automatic archive cleanup and other migration
strategies remain unfinished.
