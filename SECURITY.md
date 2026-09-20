# Security boundary

The compiler reads local metadata, SQL and custom function source and writes
native artefacts. Build, plan and validation do not contact source or target
platforms. No target SDK or telemetry is bundled.

Explicit package operations are a separate network boundary: installation and
version discovery can contact GitHub through Git/authorised package transports.
Private package access can use the operator's existing GitHub credentials. These
operations must not be described as offline compilation or as target-platform
credential provisioning. Dependency installation and repository development also
use the network. A local installed-package cache permits locked offline builds.

References must stay inside the project after realpath resolution. YAML uses
unique keys, bounded size/depth/alias expansion and rejects prototype keys. Only
explicit local reference, merge and parameter/env directives are supported.
Custom functions are never executed by the compiler. Generated workloads execute
reviewed user code with the operator's target identity; they are not sandboxed.

Environment variables are for non-secret existing resource identifiers. Use
platform-managed connection credentials. Do not put secrets in SQL, Python or
metadata. Resolved configuration is included in the generated plan.

Output replacement requires an intact manifest and exact inventory. Hashes are
local consistency checks, not authenticated publisher provenance. Do not point
generation at directories concurrently modified by other programs. Runtime
outputs, checkpoints and quarantine locations require single-writer ownership.
No distributed transaction or cross-platform exactly-once guarantee is claimed.

Report issues privately through the repository's private issue tracker; include
synthetic reproduction steps and no credentials, data or production logs.
