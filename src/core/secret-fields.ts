/** Shared field names requiring runtime secret references. No host dependencies. */
export const secretFields = new Set([
  "password",
  "auth_token",
  "token",
  "accessToken",
  "clientSecret",
  "accountKey",
  "sasToken",
]);
