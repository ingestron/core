# Programme definition inspection and stable identities

Local candidate 0.12.56 retains the `ingestron.programme/v1` JSON representation.
`programme_definition_inspect {id}` returns shared platform configuration, programme
project identities, work-item count, raw source digest and canonical definition
digests. It does not open project folders, resolve credentials or infer bindings.

A programme project can declare `compilerId`, its explicit logical connection to
an `ingestron.project/v1` definition. The programme project's existing `id` remains
the reference used by requirements and work items. Compiler IDs must be distinct.
Hosts must verify the chosen project definition separately within their authorised
root before presenting this mapping; the operation accepts no filesystem paths.

`programme_registration_propose {id, project, compilerId, expectedDigest}` returns
a read-only review with `document` and `expectedDigest`. Apply those two fields with
`programme_save {id, document, expectedDigest}` and explicit write permission.
Stale reviews fail. A registered compiler identity cannot be removed or reassigned
through an ordinary save; a future deliberate relocation/migration contract is
required for that operation. Legacy projects without compilerId continue to work.

No environment/provider binding, YAML representation, migration or generation is
implemented by these identity operations. Source digests detect changes in storage;
canonical digests identify the resolved logical document independently of JSON
whitespace. Existing schema validation, bounded files, symlink denial and programme
write locking still apply.
