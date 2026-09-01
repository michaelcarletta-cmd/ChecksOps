/**
 * Live source access for the first copy.
 *
 * Catalog inventory is already committed in LIVE_SOURCE_INVENTORY.md.
 * This module never requests or prints tokens/passwords.
 *
 * Dump (when later approved) must use an operator-held read-only URI
 * outside this Cloud Agent. See FIRST_COPY_PROCEDURE.md.
 */

export const LIVE_ACCESS_POLICY = Object.freeze({
  inventorySource: "committed-file",
  inventoryFile: "aws/db-copy/LIVE_SOURCE_INVENTORY.md",
  requestToken: false,
  requestPassword: false,
  dumpFromThisCloudAgent: false,
  dumpFromOperatorHost: true,
  operatorMustUseReadOnlyUri: true,
  neverLogUriOrPassword: true,
});

export function describeLiveAccess() {
  return {
    ...LIVE_ACCESS_POLICY,
    message:
      "Live catalog is already in LIVE_SOURCE_INVENTORY.md. Do not request another " +
      "Supabase access token or database password. When dump is approved, an operator " +
      "with existing Lovable/Supabase read access must run pg_dump from a host that " +
      "can reach the source, using a read-only URI that is never logged or committed.",
  };
}
