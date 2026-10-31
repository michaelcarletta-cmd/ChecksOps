/**
 * Server-only money-write flag (security audit 2026-10-29, finding 14, step 1 of 2).
 *
 * The API's money-table writers (invoices, billing settings and billing engine,
 * wallets, transfers, collection v2, provider onboarding parity handlers) call
 * setMoneyWriteFlag(client) inside their open transaction, immediately before
 * they write. It sets the transaction-local GUC request.money_write = '1'
 * (is_local = true: it ends with the transaction, and a ROLLBACK TO SAVEPOINT
 * taken after it does not clear it unless the savepoint was opened first).
 *
 * The browser never sends SQL, so it cannot set a GUC; the generic /data/write
 * and /data/rpc routes never call this helper (tests assert both).
 *
 * Step 1 (this module) is behavior-neutral: no policy reads request.money_write
 * yet. Step 2 (SQL 136) adds a RESTRICTIVE policy on each money table that
 * accepts this flag, the SQL 72 / SQL 91 GUCs and the definer paths. The API
 * must be live in staging and production before SQL 136 is applied.
 * Design note: aws/docs/money-write-flag.md.
 *
 * Where the write that follows swallows its own error (`.catch(() => {})`), the
 * call site swallows the flag's error too (`setMoneyWriteFlag(client).catch(...)`),
 * so an already-aborted transaction fails at the same place it did before.
 *
 * '1' matches the other server-only GUCs (request.financial_execution,
 * request.moov_onboarding, request.provider_webhook_apply), which SQL compares
 * with = '1'.
 */
export const MONEY_WRITE_GUC = 'request.money_write';
export const MONEY_WRITE_ON = '1';
export const SET_MONEY_WRITE_SQL = "SELECT set_config('request.money_write', '1', true)";

/** Sets request.money_write = '1' for the rest of the client's current transaction. */
export async function setMoneyWriteFlag(client) {
  await client.query(SET_MONEY_WRITE_SQL);
}
