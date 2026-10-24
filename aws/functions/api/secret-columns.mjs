/**
 * Credential columns the API never echoes to a client, per table: link and
 * session tokens, third-party passwords and API keys, webhook secrets, encrypted
 * secrets, and the tenant's full EIN (the audited moov-ein-reveal route is its
 * only reader). RLS still decides the rows; this decides the columns.
 *
 * The map is PR #1213's SECRET_COLUMNS (data.mjs) verbatim. The write routes
 * (write.mjs, write-app-metadata.mjs) strip these columns from every
 * `RETURNING *` row they hand back, so a write cannot echo a secret the read
 * route refuses. What is written is unchanged.
 *
 * Columns a screen shows on purpose stay readable (signature_signers.access_token,
 * homeowner_ledger_tokens.token, moov_invoices.public_token: the "copy link"
 * buttons for links the tenant created).
 */
export const SECRET_COLUMNS = Object.freeze({
  check_endorsements: Object.freeze(['token']),
  check_payees: Object.freeze(['endorsement_token']),
  check_payment_directions: Object.freeze(['secure_token']),
  checkalt_config: Object.freeze(['webhook_secret']),
  claims: Object.freeze(['mortgage_portal_password']),
  company_branding: Object.freeze(['signnow_make_webhook_url']),
  email_unsubscribe_tokens: Object.freeze(['token']),
  external_payment_recipients: Object.freeze(['secure_token']),
  homeowner_bank_link_tokens: Object.freeze(['token']),
  homeowner_intro_requests: Object.freeze(['access_token']),
  mortgage_companies: Object.freeze(['portal_password']),
  profiles: Object.freeze(['jobnimbus_api_key']),
  signature_signers: Object.freeze(['token_hash']),
  stakeholder_accounts: Object.freeze(['plaid_access_token', 'verification_token']),
  tenant_billing_accounts: Object.freeze(['account_number_encrypted']),
  tenant_openai_credentials: Object.freeze(['encrypted_key']),
  tenants: Object.freeze(['actum_password', 'actum_test_password', 'actum_webhook_secret', 'ein']),
  user_sessions: Object.freeze(['session_token']),
});

const tableName = (table) => String(table || '').replace(/^public\./, '');

/** The secret columns of one table (a bare or `public.`-qualified name); empty when it has none. */
export const secretColumnsForTable = (table) => {
  const name = tableName(table);
  return Object.prototype.hasOwnProperty.call(SECRET_COLUMNS, name) ? SECRET_COLUMNS[name] : [];
};

const stripRow = (secret, row) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  if (!secret.some((column) => Object.prototype.hasOwnProperty.call(row, column))) return row;
  const out = { ...row };
  for (const column of secret) delete out[column];
  return out;
};

/**
 * Remove `table`'s secret columns from a row or an array of rows. Returns a copy
 * for each row that held one; other rows, other values and tables without
 * secret columns are returned as given. Never mutates its input.
 */
export const stripSecretColumns = (table, rowOrRows) => {
  const secret = secretColumnsForTable(table);
  if (!secret.length) return rowOrRows;
  if (Array.isArray(rowOrRows)) return rowOrRows.map((row) => stripRow(secret, row));
  return stripRow(secret, rowOrRows);
};
