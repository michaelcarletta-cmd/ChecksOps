/**
 * Apply-order contract for 29_mortgage_ops_library_parity.sql.
 * completeAuth is the installer. writePlan and ddl must not apply 29
 * before 20_write_helpers.sql and 24_complete_write_policies.sql.
 */
export const MORTGAGE_OPS_LIBRARY_PARITY_SQL = '29_mortgage_ops_library_parity.sql';

export const MORTGAGE_OPS_LIBRARY_PARITY_REQUIRED_BEFORE = Object.freeze([
  '11_access_helpers.sql',
  '20_write_helpers.sql',
  '24_complete_write_policies.sql',
]);
