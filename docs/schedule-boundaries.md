# Compiled schedule boundaries

The private core 0.12.20 candidate includes `scheduleBoundaries` in a plan when
selected flows have reviewed schedules. Each entry is keyed by flow ID. Manual
flows have no entry. Delivery exports retain entries only for their own flows.

Each entry preserves the schedule digest and original IANA zone, the exact UTC
start and optional end, local timestamp, UTC offset and all possible instants for
that local timestamp. The host time-zone database and ICU versions are recorded.
The plan digest includes this resolution, so different clock data cannot silently
reuse the same plan identity. Preview and compilation report the same clock source. Before generation, the
compiler resolves bounds again and refuses missing, foreign, altered or stale
clock metadata, even if a saved plan has a newly calculated content digest.

An ambiguous boundary keeps both possible instants and the original selected UTC
instant. No fold choice is invented. A native generator that accepts only a local
timestamp must detect this ambiguity and require a qualified way to preserve the
reviewed instant. Boundary resolution does not promise the target's recurrence,
daylight-saving, overlap or missed-run behaviour.

Providers that require this metadata must declare
`resolved-schedule-boundaries` in `compatibility.requiredFeatures`, together with
`flow-schedules` for schedule capabilities. Older hosts then reject the provider
before rendering. Resolution runs in the Node compiler; providers consume JSON in
the metadata-only sandbox and need no clock, Temporal or time-zone API.

Generation does not deploy or activate a schedule. The candidate metadata alone
does not add ADF trigger generation, native vendor qualification or a dispatcher.
Public package dependency pins have not changed.
