# Review provider options

These operations are installed verified in the private core0.12.22 candidate with
CLI0.17.10. Published dependency pins have not changed. A provider is the package
that generates or runs a flow for its target platform; its declared configuration
schema defines the options that can be reviewed.

Inspect the selected configuration before editing it:

```js
const inspected = execute(
  { root, environment: "dev" },
  "provider_configuration_inspect",
  { configuration: "landing" },
);
```

The result contains the installed provider's schema, saved options, configuration
digest, authoritative definition file/pointer and affected default/profile flows.
It does not execute the provider, contact a source or resolve host environment
values. A provider without a declared schema returns `available: false`; proposals
are refused for that provider. Invalid existing options can be inspected and
explicitly repaired.

Use the inspected digest with the full intended options object:

```js
const reviewed = execute(
  { root, environment: "dev" },
  "provider_configuration_propose",
  {
    configuration: "landing",
    expectedDigest: inspected.result.digest,
    options: nextOptions,
  },
);
```

The result is a normal change proposal. Check `ok` before using either result.
Review its changed files and apply the exact returned proposal with `allowWrite:
true`. Inspection and proposal creation need no write or execution permission.
CLI `operation` and read-only MCP expose the same operation names and results;
read-only MCP does not expose `apply`.

Options are validated against the installed provider schema before a proposal is
returned. Existing inline-credential guards apply; use declared runtime secret
references. Unknown fields are rejected when the provider forbids them. This does
not verify linked services, source permissions or native target behaviour.

Local `$resolve` files retain their ownership and relative reference layout.
Unchanged neighbouring option values and comments are preserved. Shared YAML
aliases are refused rather than edited implicitly. The proposal retains hashes
of inspected project/package/schema inputs. A changed configuration or schema
requires inspection again; changed inputs after review refuse apply before writes.

`scripts/provider-configuration-acceptance.mjs` verifies immutable SDK/CLI/MCP
inspection and proposals, reviewed referenced-file saves, actual locked ADF asset
preparation, stale/schema/permission refusals and exact recovery. Its required
`INGESTRON_ACCEPTANCE_*` inputs identify the installed CLI package, prior locked ADF
fixture, output/proof locations and immutable core/CLI archives. This is an
engineering acceptance harness, not a published user quickstart.
