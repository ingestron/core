# Shared platform definitions

A platform can declare reusable exact packages and portable connections in its
`reuse` collection. Declarations record an owner, purpose and named consumer
projects; they do not grant source access or cloud permissions.

`platform_reuse_read` lists declarations, installed package identities and the
current project's binding state without returning connection settings.
`platform_reuse_review` promotes an installed package or saved portable connection.
`platform_reuse_apply` rechecks the project and programme and saves the reviewed
change. Programme JSON and split YAML use the existing storage transaction.

Connections retain independently named environment variants. Settings are resolved
when promoted; credentials remain runtime environment secret references. Native
and bridge connections continue to use target configuration and are not portable
shared connections.

`shared_connection_review` requires a permitted project on the platform and the
exact installed connector commit. Its proposal materialises settings into the
selected project environment and records the shared definition digest. Apply
rechecks both owners and refuses existing unmanaged connections, modified local
bindings, shared binding collisions and changes to another environment's identity.
It never changes the source platform or sibling projects. A later shared change
requires an explicit reviewed refresh. Project-specific configuration remains
editable, but locally modified shared bindings cannot be silently refreshed.

Package and model declarations retain the locked reference and commit. Each
consumer separately installs and configures its packages through the existing
package operations. Declared consumers describe intended use; this inventory is
not a live census of remote projects or an external access-control service.
