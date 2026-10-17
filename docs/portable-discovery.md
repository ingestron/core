# Reusable source discovery — D2

Core owns one portable discovery envelope for Studio, CLI and external collectors.
No destination, processing method, target physical type, generation, ingestion run
or execution history is introduced by this slice.

## Collect or upload

`discovery_read {connection, snapshot?}` returns the expected connector reference,
exact version, inventory revision and saved snapshot summaries. With a snapshot ID
it returns metadata without contacting the source or requiring an installed source
runtime. The connection must exist in the selected project/environment.

`discovery_review {connection, revision, document, allowSamples:false}` accepts the
UTF-8 contents of a JSON/YAML snapshot. It rejects duplicate YAML keys, aliases,
unsupported versions/fields, duplicate identities, incorrect source/environment or
connector bindings, invalid hints and oversize input. It never accepts an arbitrary
host file path or URL. The connector ID is the **configured package source**, as
returned by `discovery_read`, rather than a guessed short manifest alias.

Example metadata-only document:

```json
{
  "apiVersion": "ingestron.discovery-snapshot/v1",
  "id": "sales_20261016",
  "source": "sales_files",
  "environment": "dev",
  "connector": {
    "id": "ingestron/connectors/connectors/files/connector.yaml",
    "version": "1.5.14"
  },
  "collectedAt": "2026-10-16T00:00:00Z",
  "provenance": { "method": "inferred", "producer": "External collector" },
  "coverage": { "scope": "Selected files", "complete": false },
  "objects": [
    {
      "id": "orders",
      "kind": "file-group",
      "metadataComplete": false,
      "locator": { "path": "orders.jsonl" },
      "fields": [
        {
          "path": "customer.id",
          "logicalType": "unknown",
          "origin": "inferred"
        }
      ]
    }
  ]
}
```

Kinds are table, view, file-group, endpoint, collection, topic and unknown. A legacy
connector's ambiguous `object` kind remains unknown. Native types are retained;
unsupported logical types remain unknown. Native precision/scale and bounded-record
inference limits are retained when supplied, without record values. Fields distinguish declared, observed,
inferred and unknown origins. Optional object name, namespace, description, scalar
locator attributes, keys, partitions and cursors are retained. Hint field references
must exist. Missing metadata is not populated with physical SQL defaults.

Live collection still uses reviewed `connection_inventory` and
`connection_metadata` operations, requiring their existing explicit local execution
and receipt-write permissions. `discovery_review {connection, revision, receipts}`
then converts up to 100 current successful metadata receipts into one portable
snapshot without contacting the source again. Conflicting objects across selected
receipts are rejected; select one current batch for each conflicting object.
Selected-scope discovery is always partial: absence never implies deletion.
Current live capabilities are connector-declared; the interchange accepts all source
families without claiming every connector can execute discovery on every host.

## Optional samples

An external collector may wrap the snapshot in
`{apiVersion:"ingestron.discovery-bundle/v1", snapshot, samples}`. Each sample has
`object`, unique `columns`, rectangular `rows` and `truncated`. Columns must exist
in the referenced object's fields. A bundle containing samples is refused unless
`allowSamples:true` is explicitly supplied. Up to 10 objects, 50 rows per object,
100 columns and 500 characters per string cell are permitted; scalar/null values
only. The file byte limit still applies.

Samples are returned for the current preview only. They are excluded from the
save input, proposal, metadata file and discovery receipts. Reopening a saved
snapshot provides metadata only; re-upload a bundle or explicitly request a live
sample to preview rows again. Live field inference that requires bounded sampling
has its own connector options and permission review. It does not prove complete
schema coverage or required fields/keys. No persistent sample archive is provided.

## Reviewed persistence

`discovery_apply {input, proposalId}` requires local write permission, reconstructs
the proposal, and uses the existing fenced atomic writer. It creates
`discovery/<environment>/<connection>/<snapshot-id>.yaml`, preserving earlier
snapshots. The `ingestron.saved-discovery/v1` wrapper holds the snapshot and a digest
of the reviewed configuration/lock binding. No credential values or samples are
written. Changes to configuration/locks make historical snapshots visibly stale;
they remain readable and are never silently adopted or deleted.

The save input and proposal ID are returned by review. Studio replaces these with
a short-lived, single-use host token bound to editor, root, project, environment
and source. Detaching the ingestion module guards discovery operations too.

Limits: 2 MiB uploaded/saved document, 10,000 objects, 5,000 fields per object,
1,000 saved snapshots per source/environment and 16 MiB aggregate saved metadata.
CLI discovery requests allow 16 MiB for JSON escaping and structured apply input;
other operation requests retain their 1 MiB limit. These are rejection bounds,
not estate-size qualification. A synthetic 480-object import is tested. D3 owns
adoption into editable ingestion definitions; D5 owns file-to-file comparisons.
