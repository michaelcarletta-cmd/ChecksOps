/**
 * The schema SQL 144 (get_tenant_incoming_transfers) reads, on top of the release fixture
 * (helpers/release-sql-pg.mjs): payment_transfers as helpers/sql109-payment-schema.mjs builds it
 * (supabase/migrations/20260727224957 plus leg_role / wallet_id, RLS on, the aws/rls select and write
 * policies) with destination_tenant_id and speed (both in that migration), the check context columns
 * of check_intake_items and claims, a third organization, two more checks, shares and send legs in
 * every status. Run as the superuser before ownership (releaseFixture({ extra: incomingSchema() })).
 *
 * Organizations: TENANT_A (the sender, "A"), TENANT_B (the recipient, "B"), TENANT_C ("C").
 * CHECK_A is shared A -> B (active); CHECK_2 is not shared; CHECK_3 was shared A -> B and revoked.
 */
import { CHECK_A, CLAIM_A, TENANT_A, TENANT_B } from './release-sql-pg.mjs';
import { PAYMENT_SCHEMA } from './sql109-payment-schema.mjs';

export const TENANT_C = '44444444-4444-4444-8444-444444444444';
export const MEMBER_C = 'a1000000-0000-4000-8000-0000000000c1';
export const CHECK_2 = '14400000-0000-4000-8000-0000000000c2';
export const CHECK_3 = '14400000-0000-4000-8000-0000000000c3';

const leg = (n) => `14400000-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;
/** The legs addressed to B that B reads (newest first), and the ones it never reads. */
export const LEGS = Object.freeze({
  walletSubmitted: leg(1), // A -> B, CHECK_A (shared), send_wallet, submitted
  bankCompleted: leg(2), // A -> B, CHECK_A (shared), send_bank, completed
  returned: leg(3), // A -> B, CHECK_2 (not shared), send_bank, returned
  revokedShare: leg(4), // A -> B, CHECK_3 (share revoked), send_wallet, processing
  failed: leg(5), // A -> B failed
  ready: leg(6), // A -> B ready (never left)
  canceled: leg(7), // A -> B canceled
  unknown: leg(8), // A -> B unknown
  funding: leg(9), // B wallet funding (destination B, leg wallet_funding)
  self: leg(10), // B -> B send (own row)
  toC: leg(11), // A -> C
  pending: leg(12), // C -> B pending, no check
});
export const B_READS = Object.freeze([LEGS.pending, LEGS.revokedShare, LEGS.returned, LEGS.bankCompleted, LEGS.walletSubmitted]);

export function incomingSchema() {
  const t = (n) => `'2026-11-06T1${n}:00:00Z'`;
  const row = (id, tenant, dest, role, status, cents, check, at, extra = {}) => `('${id}', '${tenant}', ${dest ? `'${dest}'` : 'NULL'}, 'production', '${role}', '${status}', 'k-${id}', ${cents}, ${check ? `'${check}'` : 'NULL'}, ${at}, ${extra.submitted ? at : 'NULL'}, ${extra.completed ? at : 'NULL'}, '{"stepup_id": "secret-stepup", "request_hash": "secret-hash"}'::jsonb, 'secret description')`;
  return [PAYMENT_SCHEMA, `
ALTER TABLE public.payment_transfers ADD COLUMN destination_tenant_id uuid, ADD COLUMN speed text NOT NULL DEFAULT 'standard';
ALTER TABLE public.check_intake_items ADD COLUMN check_number text, ADD COLUMN carrier_name text, ADD COLUMN property_address text,
  ADD COLUMN funds_type text, ADD COLUMN amount numeric, ADD COLUMN detected_claim_number text;
ALTER TABLE public.claims ADD COLUMN claim_number text, ADD COLUMN policyholder_name text;
INSERT INTO public.tenants (id, name) VALUES ('${TENANT_C}', 'C');
INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES ('${MEMBER_C}', 'member-c@example.invalid', 'active');
INSERT INTO public.profiles (id, email) VALUES ('${MEMBER_C}', 'member-c@example.invalid');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ('${TENANT_C}', '${MEMBER_C}', 'owner');
UPDATE public.check_intake_items SET check_number = '1001', carrier_name = 'State Farm', property_address = '1 Main St',
  funds_type = 'dwelling', amount = 9029.35, detected_claim_number = 'D-1', payee_line = 'Deen Bandhu & A' WHERE id = '${CHECK_A}';
UPDATE public.claims SET claim_number = 'CL-1', policyholder_name = 'Deen Bandhu' WHERE id = '${CLAIM_A}';
INSERT INTO public.check_intake_items (id, tenant_id, claim_id, check_number, carrier_name, amount) VALUES
  ('${CHECK_2}', '${TENANT_A}', '${CLAIM_A}', '1002', 'Allstate', 500), ('${CHECK_3}', '${TENANT_A}', NULL, '1003', 'USAA', 700);
INSERT INTO public.shared_checks (check_id, source_tenant_id, target_tenant_id, revoked_at) VALUES
  ('${CHECK_A}', '${TENANT_A}', '${TENANT_B}', NULL), ('${CHECK_3}', '${TENANT_A}', '${TENANT_B}', now());
INSERT INTO public.payment_transfers (id, tenant_id, destination_tenant_id, environment, leg_role, status, idempotency_key, amount_cents,
  check_id, created_at, submitted_at, completed_at, provider_metadata, description) VALUES
  ${row(LEGS.walletSubmitted, TENANT_A, TENANT_B, 'send_wallet', 'submitted', 640520, CHECK_A, t(1), { submitted: true })},
  ${row(LEGS.bankCompleted, TENANT_A, TENANT_B, 'send_bank', 'completed', 190180, CHECK_A, t(2), { submitted: true, completed: true })},
  ${row(LEGS.returned, TENANT_A, TENANT_B, 'send_bank', 'returned', 5000, CHECK_2, t(3), { submitted: true })},
  ${row(LEGS.revokedShare, TENANT_A, TENANT_B, 'send_wallet', 'processing', 7000, CHECK_3, t(4), { submitted: true })},
  ${row(LEGS.failed, TENANT_A, TENANT_B, 'send_wallet', 'failed', 100, CHECK_A, t(5))},
  ${row(LEGS.ready, TENANT_A, TENANT_B, 'send_wallet', 'ready', 100, CHECK_A, t(5))},
  ${row(LEGS.canceled, TENANT_A, TENANT_B, 'send_bank', 'canceled', 100, CHECK_A, t(5))},
  ${row(LEGS.unknown, TENANT_A, TENANT_B, 'send_bank', 'unknown', 100, CHECK_A, t(5))},
  ${row(LEGS.funding, TENANT_B, TENANT_B, 'wallet_funding', 'completed', 100, null, t(5))},
  ${row(LEGS.self, TENANT_B, TENANT_B, 'send_wallet', 'completed', 100, null, t(5))},
  ${row(LEGS.toC, TENANT_A, TENANT_C, 'send_wallet', 'completed', 100, CHECK_A, t(5))},
  ${row(LEGS.pending, TENANT_C, TENANT_B, 'send_wallet', 'pending', 2500, null, t(6), { submitted: true })};`];
}
