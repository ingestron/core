# Inspect saved local output

`delivery_preview` reads a committed Parquet output through the installed operation
API. Supply the successful run ID, flow, stream, recorded SHA-256, build directory
and optional execution profile. The operation requires `allowExecute`; it does not
require source credentials, write permission or network access.

It verifies the local managed build, project/environment/flow/run identity, prepared
runtime identity, commit receipt and content hash. Missing, changed, ambiguous or
foreign output fails closed. A bounded PyArrow reader uses the existing prepared
runtime; no package installation or source request runs during inspection.

Limits: 20 rows, 100 columns, 500 characters per cell, 64 MiB compressed file and
64 MiB declared uncompressed row groups. Large integers and decimals remain strings
to avoid JavaScript precision loss. Dates are ISO values, binary values show byte
counts and null remains distinct from an empty string. Long cells are marked as
shortened. Files outside these limits require a separate local data tool.

Business values appear only in the immediate operation response. No preview run,
job or receipt is saved. Clients must request inspection explicitly and discard a
response when the selected run, table or project changes.

Verification: unit denial/ownership/size tests and installed CLI acceptance on the
existing Northwind Customers artefact (20 of 91 rows, 11 columns, unchanged receipts).
Studio owns its UI and installed-host evidence.
