/**
 * The schema the Moov status catch-up apply (aws/functions/api/providers/moov-status-catch-up.mjs) and SQL 146 touch,
 * on top of the release fixture (helpers/release-sql-pg.mjs), with production's policies on the three tables it writes:
 *
 *   - public.payment_transfers / public.payment_event_log as helpers/sql145-collection-leg-schema.mjs builds them
 *     (RLS on, aws/rls select policies, SQL 24's aws_write_payment_transfers, SQL 72's member INSERT, SQL 136's gate and
 *     its three restrictive policies on payment_transfers), plus, verbatim from the repository:
 *       SQL 72's aws_member_update_payment_transfers and aws_member_insert_payment_event_log,
 *       SQL 91's aws_webhook_insert_payment_event_log,
 *       SQL 136's three restrictive policies on tenant_maintenance_payments;
 *   - public.tenant_maintenance_payments with the columns the settlement code reads and writes, and production's
 *     live-only policies (read-only policy check SSM 8a2063ee-4dbf-49fe-b35a-e3a767666621; the same texts staging showed,
 *     scripts/deployment-guard/lib/tmp-rls-catalog.mjs INSPECTED_WRITE / INSPECTED_JOB): the permissive
 *     aws_write_tenant_maintenance_payments FOR ALL TO authenticated (is_platform_owner() OR aws_monthly_billing_job() OR
 *     request.provider_webhook_apply = '1') and the *_job SELECT / ALL policies TO checksops; the repository's
 *     aws_select_tenant_maintenance_payments; aws_monthly_billing_job() is helpers/sql139-billing-schema.mjs' stand-in.
 *
 * SQL90_WRITE_HELPERS (helpers/sql145-collection-leg-schema.mjs) turns the fixture's pre-SQL 90 aws_can_write_tenant into
 * production's membership-only one; run it after the fixture. SQL 109 (the webhook's definer writer) is applied by the
 * tests as checksops_admin, as production has it (applied 2026-10-21).
 *
 * Rows (all production, tenant TENANT_A, whose members do not include the platform owner):
 *   SEND        send_wallet leg, submitted, 640520 cents, Moov transfer mv-catchup-send   (5768ab44's shape)
 *   FUND        wallet_funding leg, pending, 25000 cents, Moov transfer mv-catchup-fund
 *   FEE_LEG     ach_debit tenant-collection-v2 leg of FEE_OBLIGATION, submitted, 13900 cents, Moov transfer mv-catchup-fee
 *   FEE_OBLIGATION  2026-09 monthly_subscription obligation, due, 13900 cents, the same Moov transfer (b31c7752's shape)
 */
import { TENANT_A } from './release-sql-pg.mjs';
import { BILLING_JOB_FN } from './sql139-billing-schema.mjs';
import { collectionLegSchema, sliceFrom } from './sql145-collection-leg-schema.mjs';
import { INSPECTED_JOB, INSPECTED_WRITE } from '../../../scripts/deployment-guard/lib/tmp-rls-catalog.mjs';

const SQL72 = 'aws/workflows/sql/72_member_payment_writes.sql';
const SQL91 = 'aws/workflows/sql/91_moov_onboarding.sql';
const SQL136 = 'aws/workflows/sql/136_money_write_restrictive_policies.sql';

export const SEND = 'c1460000-0000-4000-8000-0000000000a1';
export const FUND = 'c1460000-0000-4000-8000-0000000000a2';
export const FEE_LEG = 'c1460000-0000-4000-8000-0000000000a3';
export const FEE_OBLIGATION = 'c1460000-0000-4000-8000-0000000000b1';
export const SEND_TRANSFER = 'mv-catchup-send';
export const FUND_TRANSFER = 'mv-catchup-fund';
export const FEE_TRANSFER = 'mv-catchup-fee';
export const SEND_CENTS = 640520;
export const FUND_CENTS = 25000;
export const FEE_CENTS = 13900;

export const FEE_LEG_META = Object.freeze({
  collection_contract: 'tenant-collection-v2', checksops_kind: 'monthly_subscription', obligation_id: FEE_OBLIGATION,
  billing_period: '2026-09', leg_type: 'ach_debit',
});

export function catchUpSchema() {
  return [
    ...collectionLegSchema(),
    `
ALTER TABLE public.tenant_maintenance_payments
  ADD COLUMN provider_environment text,
  ADD COLUMN occurrence_kind text,
  ADD COLUMN settled_at timestamptz,
  ADD COLUMN returned_at timestamptz,
  ADD COLUMN return_reason text,
  ADD COLUMN failure_reason text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
GRANT DELETE ON public.tenant_maintenance_payments TO checksops;
ALTER TABLE public.payment_provider_accounts ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'moov';`,
    sliceFrom(SQL72, 'DROP POLICY IF EXISTS aws_member_update_payment_transfers ON public.payment_transfers;', '  );'),
    sliceFrom(SQL72, 'DROP POLICY IF EXISTS aws_member_insert_payment_event_log ON public.payment_event_log;', '  );'),
    sliceFrom(SQL91, 'DROP POLICY IF EXISTS aws_webhook_insert_payment_event_log ON public.payment_event_log;',
      'WITH CHECK (public.aws_moov_webhook_apply_active());'),
    sliceFrom(SQL136, 'DROP POLICY IF EXISTS aws_money_write_gate_insert_tenant_maintenance_payments ON public.tenant_maintenance_payments;',
      'CREATE POLICY aws_money_write_gate_delete_tenant_maintenance_payments ON public.tenant_maintenance_payments\n  AS RESTRICTIVE FOR DELETE TO authenticated\n  USING (public.aws_money_write_allowed());'),
    BILLING_JOB_FN,
    `
DROP POLICY IF EXISTS aws_write_tenant_maintenance_payments ON public.tenant_maintenance_payments;
CREATE POLICY aws_write_tenant_maintenance_payments ON public.tenant_maintenance_payments
  FOR ALL TO authenticated USING ${INSPECTED_WRITE} WITH CHECK ${INSPECTED_WRITE};
CREATE POLICY aws_select_tenant_maintenance_payments_job ON public.tenant_maintenance_payments
  FOR SELECT TO checksops USING ${INSPECTED_JOB};
CREATE POLICY aws_write_tenant_maintenance_payments_job ON public.tenant_maintenance_payments
  FOR ALL TO checksops USING ${INSPECTED_JOB} WITH CHECK ${INSPECTED_JOB};
DELETE FROM public.payment_transfers;
DELETE FROM public.tenant_maintenance_payments;
INSERT INTO public.tenant_maintenance_payments (id, tenant_id, amount_cents, billing_period, status, provider_transfer_id,
    provider_environment, occurrence_kind, notes) VALUES
  ('${FEE_OBLIGATION}', '${TENANT_A}', ${FEE_CENTS}, '2026-09', 'due', '${FEE_TRANSFER}', 'production', 'monthly_subscription',
   'collection_v2 status BANK_PENDING · moov:${FEE_TRANSFER}');
INSERT INTO public.payment_transfers (id, tenant_id, environment, provider_transfer_id, provider_status, status, idempotency_key,
    amount_cents, leg_role, provider_metadata) VALUES
  ('${SEND}', '${TENANT_A}', 'production', '${SEND_TRANSFER}', 'created', 'submitted', 'send:catchup:send', ${SEND_CENTS}, 'send_wallet', '{}'),
  ('${FUND}', '${TENANT_A}', 'production', '${FUND_TRANSFER}', 'pending', 'pending', 'wallet-fund:catchup', ${FUND_CENTS}, 'wallet_funding', '{}'),
  ('${FEE_LEG}', '${TENANT_A}', 'production', '${FEE_TRANSFER}', 'created', 'submitted', 'billing-2026-09-${TENANT_A}-bank', ${FEE_CENTS},
   'ach_debit', '${JSON.stringify(FEE_LEG_META)}');`,
  ];
}

/** Moov's record as confirmMoovWebhookPayload returns it (the catch-up hint: no account id), for a fake confirm. */
export const trustedTransfer = (transferID, status, value) => ({
  type: 'transfer.updated',
  accountID: null,
  data: { transferID, status, amount: { currency: 'USD', value }, ...(status === 'completed' ? { completedOn: '2026-09-05T15:00:00Z' } : {}) },
});

/** A confirm that answers from `records` (transfer id -> trusted payload) and 404s every other id. */
export const fakeConfirm = (records) => async (hint) => {
  const id = hint?.data?.transferID;
  return records[id] ? { ok: true, payload: records[id] } : { ok: false, skipped: 'moov_resource_not_found' };
};
