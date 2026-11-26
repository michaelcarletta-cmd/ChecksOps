/**
 * Read-only production inspect of one organization's settlement-bank state (inspect only; there
 * is no apply). Owner question 2026-11-25 (Condition One): Transfer to bank says "No settlement
 * bank" while the Wallet & Treasury tile shows a bank; "Start verification" in ChecksOps did not
 * send the Moov micro-deposit (sending it from Moov directly arrived at once); entering that code
 * in ChecksOps answered "This verification can no longer accept codes".
 *
 * The suspected cause, which this inspect confirms or refutes: ChecksOps has no
 * public.payment_provider_methods row for the organization's own Moov bank in production.
 *   - Transfer to bank (src/hooks/useWalletWithdraw.ts) lists the tenant's moov rows of the wallet
 *     environment with external_recipient_id NULL; an unverified or unlinked row is still listed
 *     (disabled), so "No settlement bank" means that list is empty.
 *   - The tile (sweep-read.mjs) can show a bank from Moov's sweep config without a row.
 *   - moov-micro-deposit-initiate (onboarding/handlers.mjs) needs such a row that is not
 *     'disconnected' and has provider ids; otherwise it answers 'Bank account not found.' or
 *     'not ready' before it calls Moov, and opens no payment_method_verifications row.
 *   - pullMoovStatus (moov-sync) only UPDATEs existing rows by provider_bank_account_id; it never
 *     inserts a bank that is at Moov but has no row.
 *
 * Scope: the single tenant TARGET_TENANT_ID (Condition One, aws/identity/oneshot/onboard.mjs
 * C1C_TENANT), passed as the only bind parameter of fixed statements. Sections: whether the
 * tenant row exists; its payment_provider_accounts; its payment_provider_methods (all providers);
 * its payment_method_verifications; its payment_event_log rows of the last 30 days; its
 * financial_stepup_log rows of the last 14 days; its stakeholder_accounts by status (the legacy
 * card's rows).
 *
 * One transaction: BEGIN READ ONLY, search_path pg_catalog, statement and lock timeouts,
 * TimeZone UTC, then the fixed SELECTs in Q, then ROLLBACK. There is no SQL argument.
 *
 * Output: counts, booleans, code labels, small integers, minute timestamps (UTC) and per-section
 * sequence numbers. No id (tenant, account, bank, Moov or user), name, holder, bank name, last
 * four, routing digits, amount, error text or payload value is ever returned: provider ids are
 * compared inside predicates only (has_*, *_matches). Labels are printed only when code-shaped;
 * anything else is 'other'.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok } from './errors.mjs';
import { safeErrorCode } from './mortgage-desk-access-inspect.mjs';

export { safeErrorCode };

export const INSPECT_ID = 'settlement-bank-state-inspect';
export const CONFIG_REL = 'ops/deployment-guard/settlement-bank-state-inspect.json';
/** Condition One (aws/identity/oneshot/onboard.mjs C1C_TENANT). Used as a bind parameter only; never printed. */
export const TARGET_TENANT_ID = '4f172140-f57a-4744-8050-95f4f07b13b4';
export const EVENT_INTERVAL = '30 days';
export const STEPUP_INTERVAL = '14 days';

const MINUTE = (expr) => `COALESCE(pg_catalog.to_char(pg_catalog.date_trunc('minute', ${expr}), 'YYYY-MM-DD"T"HH24:MI"Z"'), '')`;
const TXT = (expr) => `COALESCE((${expr})::text, '')`;

export const Q = Object.freeze({
  begin: 'BEGIN READ ONLY',
  searchPath: "SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)",
  statementTimeout: "SELECT pg_catalog.set_config('statement_timeout', '20000', true)",
  lockTimeout: "SELECT pg_catalog.set_config('lock_timeout', '2000', true)",
  timeZone: "SELECT pg_catalog.set_config('TimeZone', 'UTC', true)",
  session: `SELECT current_user::text AS current_user, session_user::text AS session_user,
  pg_catalog.current_setting('transaction_read_only') AS transaction_read_only,
  pg_catalog.current_setting('server_version_num')::int AS server_version_num`,
  columns: `SELECT c.relname::text AS table_name, a.attname::text AS column_name
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[]) AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY 1, a.attnum`,
  rowSecurity: `SELECT c.relname::text AS table_name, pg_catalog.row_security_active(c.oid) AS row_security_active
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[])
  ORDER BY 1`,
  tenant: `SELECT count(*)::int AS tenant_rows FROM public.tenants t WHERE t.id = $1::uuid`,
  accounts: `SELECT ${TXT('a.provider')} AS provider, ${TXT('a.environment')} AS environment,
  ${TXT('a.onboarding_status')} AS onboarding_status, ${TXT('a.verification_status')} AS verification_status,
  (a.provider_account_id IS NOT NULL) AS has_provider_account,
  a.disabled AS disabled, a.restricted AS restricted,
  ${TXT('a.last_webhook_event_type')} AS last_webhook_event_type,
  ${MINUTE('a.created_at')} AS created_minute, ${MINUTE('a.last_synced_at')} AS synced_minute
  FROM public.payment_provider_accounts a WHERE a.tenant_id = $1::uuid
  ORDER BY a.created_at NULLS LAST, a.id`,
  methods: `SELECT pg_catalog.row_number() OVER (ORDER BY m.created_at NULLS LAST, m.id)::int AS seq,
  ${TXT('m.provider')} AS provider, ${TXT('m.environment')} AS environment,
  (m.external_recipient_id IS NOT NULL) AS is_recipient_bank,
  (m.provider_account_id IS NOT NULL) AS has_provider_account,
  (m.provider_bank_account_id IS NOT NULL) AS has_provider_bank,
  EXISTS (SELECT 1 FROM public.payment_provider_accounts a WHERE a.tenant_id = m.tenant_id AND a.provider = m.provider
    AND a.environment = m.environment AND a.provider_account_id = m.provider_account_id) AS account_matches,
  ${TXT('m.connection_status')} AS connection_status, ${TXT('m.verification_status')} AS verification_status,
  m.is_default AS is_default, m.can_send AS can_send, m.can_receive AS can_receive,
  ${TXT("m.provider_metadata ->> 'source'")} AS source,
  ${TXT("m.provider_metadata ->> 'status'")} AS provider_status,
  ${MINUTE('m.created_at')} AS created_minute, ${MINUTE('m.connected_at')} AS connected_minute,
  ${MINUTE('m.disconnected_at')} AS disconnected_minute
  FROM public.payment_provider_methods m WHERE m.tenant_id = $1::uuid
  ORDER BY m.created_at NULLS LAST, m.id`,
  verifications: `WITH methods AS (
    SELECT m.id, pg_catalog.row_number() OVER (ORDER BY m.created_at NULLS LAST, m.id)::int AS seq,
      m.provider_bank_account_id FROM public.payment_provider_methods m WHERE m.tenant_id = $1::uuid)
  SELECT ${TXT('v.provider')} AS provider, ${TXT('v.environment')} AS environment, ${TXT('v.method')} AS method,
  ${TXT('v.status')} AS status, v.attempts AS attempts, v.max_attempts AS max_attempts,
  ${TXT('v.failure_reason')} AS failure_reason,
  (v.payment_method_id IS NOT NULL) AS has_payment_method, (mm.id IS NOT NULL) AS payment_method_found,
  mm.seq AS method_seq,
  CASE WHEN mm.id IS NULL THEN NULL ELSE (mm.provider_bank_account_id IS NOT DISTINCT FROM v.provider_bank_account_id) END AS bank_matches,
  ${MINUTE('v.created_at')} AS created_minute, ${MINUTE('v.initiated_at')} AS initiated_minute,
  ${MINUTE('v.verified_at')} AS verified_minute, ${MINUTE('v.updated_at')} AS updated_minute
  FROM public.payment_method_verifications v LEFT JOIN methods mm ON mm.id = v.payment_method_id
  WHERE v.tenant_id = $1::uuid
  ORDER BY v.created_at NULLS LAST, v.id`,
  events: `SELECT ${TXT('e.event_type')} AS event_type, ${TXT('e.environment')} AS environment,
  ${TXT('e.previous_status')} AS previous_status, ${TXT('e.new_status')} AS new_status,
  ${MINUTE('e.created_at')} AS created_minute
  FROM public.payment_event_log e
  WHERE e.tenant_id = $1::uuid AND e.created_at >= pg_catalog.now() - interval '${EVENT_INTERVAL}'
  ORDER BY e.created_at, e.id`,
  stepUps: `SELECT ${TXT('s.action_key')} AS action_key, ${TXT('s.factor_type')} AS factor_type, s.succeeded AS succeeded,
  ${MINUTE('s.created_at')} AS created_minute
  FROM public.financial_stepup_log s
  WHERE s.tenant_id = $1::uuid AND s.created_at >= pg_catalog.now() - interval '${STEPUP_INTERVAL}'
  ORDER BY s.created_at, s.id`,
  stakeholders: `SELECT ${TXT('k.account_type')} AS account_type, k.is_active AS is_active, k.is_primary AS is_primary,
  ${TXT('k.verification_status')} AS verification_status, count(*)::int AS accounts
  FROM public.stakeholder_accounts k WHERE k.tenant_id = $1::uuid
  GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`,
  rollback: 'ROLLBACK',
});

/** Every statement the inspect may send, for the tests' allowlist. */
export const INSPECT_STATEMENTS = Object.freeze(Object.values(Q));

const T = Object.freeze({
  tenants: ['id'],
  payment_provider_accounts: ['id', 'tenant_id', 'provider', 'environment', 'onboarding_status', 'verification_status',
    'provider_account_id', 'disabled', 'restricted', 'last_webhook_event_type', 'created_at', 'last_synced_at'],
  payment_provider_methods: ['id', 'tenant_id', 'provider', 'environment', 'external_recipient_id', 'provider_account_id',
    'provider_bank_account_id', 'connection_status', 'verification_status', 'is_default', 'can_send', 'can_receive',
    'provider_metadata', 'created_at', 'connected_at', 'disconnected_at'],
  payment_method_verifications: ['id', 'tenant_id', 'payment_method_id', 'provider', 'environment', 'provider_bank_account_id',
    'method', 'status', 'attempts', 'max_attempts', 'failure_reason', 'created_at', 'initiated_at', 'verified_at', 'updated_at'],
  payment_event_log: ['id', 'tenant_id', 'event_type', 'environment', 'previous_status', 'new_status', 'created_at'],
  financial_stepup_log: ['id', 'tenant_id', 'action_key', 'factor_type', 'succeeded', 'created_at'],
  stakeholder_accounts: ['tenant_id', 'account_type', 'is_active', 'is_primary', 'verification_status'],
});
export const INSPECT_TABLES = Object.freeze(Object.keys(T));
const pick = (...tables) => Object.fromEntries(tables.map((t) => [t, T[t]]));
/** The columns each data statement reads; a statement runs only when all of them exist. */
export const STATEMENT_REQUIRES = Object.freeze({
  tenant: pick('tenants'),
  accounts: pick('payment_provider_accounts'),
  methods: pick('payment_provider_methods', 'payment_provider_accounts'),
  verifications: pick('payment_method_verifications', 'payment_provider_methods'),
  events: pick('payment_event_log'),
  stepUps: pick('financial_stepup_log'),
  stakeholders: pick('stakeholder_accounts'),
});

// Code labels: lower-case words with _ . - (event types such as bank_account.micro_deposit.initiated).
const LABEL_RE = /^[a-z][a-z0-9_.-]{0,60}$/;
const label = (v) => (v === '' || v == null ? '(none)' : LABEL_RE.test(String(v)) ? String(v) : 'other');
const MINUTE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\dZ$/;
const minute = (v) => (v === '' || v == null ? '(none)' : MINUTE_RE.test(String(v)) ? String(v) : 'other');
const int = (v) => (Number.isInteger(v) && v >= 0 && v < 1e6 ? v : null);
const bool = (v) => (v === true ? true : v === false ? false : null);
const section = (r, key, map) => (r[key] === undefined
  ? { read: false, reason: r.skipped?.[key] || 'not_read' }
  : { read: true, rows: r[key].map(map) });

/** Pure: the Transfer to bank list rule (useWalletWithdraw.ts): own moov banks of an environment. */
export const ownMoovBanks = (methods, environment) => (methods || []).filter((m) => m.provider === 'moov'
  && m.environment === environment && m.is_recipient_bank === false);

/** Pure: the micro-deposit initiate rule (onboarding/handlers.mjs): a candidate bank exists and is ready. */
export const initiateCandidate = (methods, environment) => {
  const own = ownMoovBanks(methods, environment).filter((m) => m.connection_status !== 'disconnected');
  const latest = own.at(-1) || null;
  if (!latest) return 'bank_account_not_found';
  if (!latest.has_provider_account || !latest.has_provider_bank) return 'not_ready_for_verification';
  return 'would_call_moov';
};

/** Pure: builds the report from the rows the statements returned. */
export function buildReport(r) {
  const session = r.session?.[0] || {};
  const methods = r.methods === undefined ? undefined : r.methods.map((x) => ({
    seq: int(x.seq),
    provider: label(x.provider),
    environment: label(x.environment),
    is_recipient_bank: x.is_recipient_bank === true,
    has_provider_account: x.has_provider_account === true,
    has_provider_bank: x.has_provider_bank === true,
    account_matches: x.account_matches === true,
    connection_status: label(x.connection_status),
    verification_status: label(x.verification_status),
    is_default: bool(x.is_default),
    can_send: bool(x.can_send),
    can_receive: bool(x.can_receive),
    source: label(x.source),
    provider_status: label(x.provider_status),
    created_minute: minute(x.created_minute),
    connected_minute: minute(x.connected_minute),
    disconnected_minute: minute(x.disconnected_minute),
  }));
  return {
    inspect: INSPECT_ID,
    read_only: true,
    transaction_read_only: session.transaction_read_only === 'on',
    current_user: session.current_user,
    session_user: session.session_user,
    server_major_version: Math.floor(Number(session.server_version_num || 0) / 10000),
    question: "does ChecksOps hold a payment_provider_methods row for the organization's own Moov bank in production, and did a micro-deposit verification ever open?",
    target: 'TARGET_TENANT_ID (fixed in the tool; the runbook names the organization)',
    timestamps: 'UTC, truncated to the minute',
    windows: { events: EVENT_INTERVAL, step_ups: STEPUP_INTERVAL },
    row_security: r.rowSecurity === undefined
      ? { read: false, reason: 'not_read' }
      : Object.fromEntries(r.rowSecurity.map((x) => [label(x.table_name), x.row_security_active === true])),
    tenant_found: r.tenant === undefined ? null : int(r.tenant?.[0]?.tenant_rows) === 1,
    derived: methods === undefined ? { read: false } : {
      read: true,
      transfer_to_bank_rows_production: ownMoovBanks(methods, 'production').length,
      transfer_to_bank_rows_sandbox: ownMoovBanks(methods, 'sandbox').length,
      micro_deposit_initiate_production: initiateCandidate(methods, 'production'),
    },
    accounts: section(r, 'accounts', (x) => ({
      provider: label(x.provider),
      environment: label(x.environment),
      onboarding_status: label(x.onboarding_status),
      verification_status: label(x.verification_status),
      has_provider_account: x.has_provider_account === true,
      disabled: bool(x.disabled),
      restricted: bool(x.restricted),
      last_webhook_event_type: label(x.last_webhook_event_type),
      created_minute: minute(x.created_minute),
      synced_minute: minute(x.synced_minute),
    })),
    methods: methods === undefined ? { read: false, reason: r.skipped?.methods || 'not_read' } : { read: true, rows: methods },
    verifications: section(r, 'verifications', (x) => ({
      provider: label(x.provider),
      environment: label(x.environment),
      method: label(x.method),
      status: label(x.status),
      attempts: int(x.attempts),
      max_attempts: int(x.max_attempts),
      failure_reason: label(x.failure_reason),
      has_payment_method: x.has_payment_method === true,
      payment_method_found: x.payment_method_found === true,
      method_seq: int(x.method_seq),
      bank_matches: bool(x.bank_matches),
      created_minute: minute(x.created_minute),
      initiated_minute: minute(x.initiated_minute),
      verified_minute: minute(x.verified_minute),
      updated_minute: minute(x.updated_minute),
    })),
    events: section(r, 'events', (x) => ({
      event_type: label(x.event_type),
      environment: label(x.environment),
      previous_status: label(x.previous_status),
      new_status: label(x.new_status),
      created_minute: minute(x.created_minute),
    })),
    step_ups: section(r, 'stepUps', (x) => ({
      action_key: label(x.action_key),
      factor_type: label(x.factor_type),
      succeeded: bool(x.succeeded),
      created_minute: minute(x.created_minute),
    })),
    stakeholder_accounts: section(r, 'stakeholders', (x) => ({
      account_type: label(x.account_type),
      is_active: bool(x.is_active),
      is_primary: bool(x.is_primary),
      verification_status: label(x.verification_status),
      accounts: int(x.accounts),
    })),
  };
}

export function loadInspectConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, CONFIG_REL), 'utf8'));
}

/**
 * Runs the inspect on a connected client: BEGIN READ ONLY ... ROLLBACK of the fixed statements
 * in Q only. A data statement runs only when every table and column it reads exists. Returns
 * the structured result; never throws.
 */
export async function inspectSettlementBankState({ connect }) {
  const names = new Map(Object.entries(Q).map(([k, v]) => [v, k]));
  let client = null;
  let stage = null;
  const rows = async (sql, params) => { stage = names.get(sql); return (await client.query(sql, params)).rows; };
  try {
    stage = 'connect';
    client = await connect();
    await rows(Q.begin);
    await rows(Q.searchPath);
    await rows(Q.statementTimeout);
    await rows(Q.lockTimeout);
    await rows(Q.timeZone);
    const r = { skipped: {} };
    r.session = await rows(Q.session);
    if (r.session?.[0]?.transaction_read_only !== 'on') {
      return fail(CODES.UNRELATED_MUTATION, 'settlement bank state inspect refused: the transaction is not read-only');
    }
    r.columns = await rows(Q.columns, [[...INSPECT_TABLES]]);
    r.rowSecurity = await rows(Q.rowSecurity, [[...INSPECT_TABLES]]);
    const have = new Set(r.columns.map((c) => `${c.table_name}.${c.column_name}`));
    const missing = (key) => Object.entries(STATEMENT_REQUIRES[key]).flatMap(([t, cols]) => cols.filter((c) => !have.has(`${t}.${c}`)).map((c) => `${t}.${c}`));
    for (const key of Object.keys(STATEMENT_REQUIRES)) {
      const gone = missing(key);
      if (gone.length) { r.skipped[key] = `columns_missing:${gone.join(',')}`; continue; }
      r[key] = await rows(Q[key], [TARGET_TENANT_ID]);
    }
    return ok(buildReport(r));
  } catch (error) {
    return fail(CODES.UNRELATED_MUTATION, 'settlement bank state inspect failed', {
      read_only: true,
      stage,
      error_code: safeErrorCode(error),
    });
  } finally {
    if (client) {
      try { await client.query(Q.rollback); } catch { /* closed below */ }
      try { await client.end(); } catch { /* nothing to report */ }
    }
  }
}
