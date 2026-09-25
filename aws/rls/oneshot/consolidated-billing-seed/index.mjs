/**
 * Staging-only synthetic tenant + $109.50 usage seed.
 * Never touches Freedom production tenant or production RDS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const SLUG = process.env.SYNTHETIC_SLUG || 'synthetic-consolidated-billing';
const NAME = 'SYNTHETIC Consolidated Monthly Billing';
const OWNER = process.env.OWNER_USER_ID || '233c588f-dc33-4307-8c3f-3da49c9fd2b3';
const TESTER = process.env.TESTER_USER_ID || '';
const MODE = process.env.SEED_MODE || 'seed10950';
const PERIOD = process.env.BILLING_PERIOD || '2026-09';

const adminClient = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops_admin/i.test(arn)) throw new Error('ADMIN_SECRET_ARN must be checksops_admin');
  if (/production/i.test(arn) || /prod/i.test(process.env.RDS_HOST || '')) {
    throw new Error('refusing_production_sql');
  }
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  const host = parsed.host && parsed.host !== 'localhost' ? parsed.host : process.env.RDS_HOST;
  if (!String(host).includes('checksops-staging')) throw new Error(`refusing_non_staging_host:${host}`);
  const client = new Client({
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
    database: process.env.DATABASE_NAME || 'checksops',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000,
    query_timeout: 60000,
  });
  await client.connect();
  return client;
};

const cols = async (client, table) => {
  const rows = (await client.query(
    `SELECT column_name, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  )).rows;
  return new Map(rows.map((r) => [r.column_name, r]));
};

const hasCol = (map, name) => map.has(name);

export const handler = async () => {
  let client;
  try {
    client = await adminClient();
  } catch (error) {
    return { ok: false, phase: 'connect', error: String(error.message || error).slice(0, 500) };
  }
  try {
    await client.query('SET default_transaction_read_only = off');
    const existing = (await client.query(
      'SELECT id, slug FROM public.tenants WHERE slug = $1 LIMIT 1',
      [SLUG],
    )).rows[0];
    const tenantId = existing?.id || (await client.query(
      'INSERT INTO public.tenants (name, slug) VALUES ($1, $2) RETURNING id',
      [NAME, SLUG],
    )).rows[0].id;
    if (tenantId === FREEDOM) throw new Error('refusing_freedom_tenant');

    const tenantCols = await cols(client, 'tenants');
    const tenantSets = [
      'name = $2',
      "subscription_status = 'active'",
    ];
    const tenantParams = [tenantId, NAME];
    let i = 3;
    if (hasCol(tenantCols, 'is_test_account')) {
      tenantSets.push(`is_test_account = true`);
    }
    if (hasCol(tenantCols, 'moov_environment')) {
      tenantSets.push(`moov_environment = 'sandbox'`);
    }
    if (MODE === 'seed10950' || MODE === 'config') {
      if (hasCol(tenantCols, 'monthly_rate_cents')) {
        tenantSets.push(`monthly_rate_cents = $${i++}`);
        tenantParams.push(10000);
      }
      if (hasCol(tenantCols, 'referral_discount_cents')) {
        tenantSets.push(`referral_discount_cents = $${i++}`);
        tenantParams.push(500);
      }
      if (hasCol(tenantCols, 'per_check_rate_cents')) {
        tenantSets.push(`per_check_rate_cents = $${i++}`);
        tenantParams.push(400);
      }
      if (hasCol(tenantCols, 'next_day_rate_cents')) {
        tenantSets.push(`next_day_rate_cents = $${i++}`);
        tenantParams.push(75);
      }
      if (hasCol(tenantCols, 'same_day_rate_cents')) {
        tenantSets.push(`same_day_rate_cents = $${i++}`);
        tenantParams.push(100);
      }
    }
    if (MODE === 'promo50' && hasCol(tenantCols, 'next_day_rate_cents')) {
      tenantSets.push('next_day_rate_cents = 50');
    }
    await client.query(`UPDATE public.tenants SET ${tenantSets.join(', ')} WHERE id = $1::uuid`, tenantParams);

    await client.query(
      `INSERT INTO public.tenant_billing_settings (tenant_id, billing_enabled, billing_day_of_month)
       VALUES ($1::uuid, true, 1)
       ON CONFLICT (tenant_id) DO UPDATE SET
         billing_enabled = true,
         billing_day_of_month = 1,
         updated_at = now()`,
      [tenantId],
    );
    await client.query(
      `INSERT INTO public.tenant_users (user_id, tenant_id, role)
       SELECT $1::uuid, $2::uuid, 'admin'
       WHERE NOT EXISTS (
         SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid
       )`,
      [OWNER, tenantId],
    );
    if (TESTER) {
      await client.query(
        `INSERT INTO public.tenant_users (user_id, tenant_id, role)
         SELECT $1::uuid, $2::uuid, 'admin'
         WHERE NOT EXISTS (
           SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid
         )`,
        [TESTER, tenantId],
      );
    }

    const accountId = 'synth-consolidated-billing-acct';
    const methodId = 'synth-consolidated-billing-pm';
    const accounts = await cols(client, 'payment_provider_accounts');
    if (hasCol(accounts, 'provider_account_id')) {
      await client.query(
        `INSERT INTO public.payment_provider_accounts
           (tenant_id, provider, environment, provider_account_id, account_type, display_name,
            onboarding_status, verification_status, last_synced_at)
         VALUES ($1::uuid, 'moov', 'sandbox', $2, 'business', $3, 'active', 'verified', now())
         ON CONFLICT (tenant_id, provider, environment) DO UPDATE SET
           provider_account_id = EXCLUDED.provider_account_id,
           onboarding_status = 'active',
           last_synced_at = now()`,
        [tenantId, accountId, NAME],
      ).catch(async () => {
        const existingAcct = (await client.query(
          `SELECT id FROM public.payment_provider_accounts
           WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = 'sandbox' LIMIT 1`,
          [tenantId],
        )).rows[0];
        if (existingAcct) {
          await client.query(
            `UPDATE public.payment_provider_accounts
             SET provider_account_id = $2, onboarding_status = 'active', verification_status = 'verified'
             WHERE id = $1::uuid`,
            [existingAcct.id, accountId],
          );
        }
      });
    }

    await client.query(
      `INSERT INTO public.payment_provider_methods
         (tenant_id, provider, environment, provider_account_id, provider_bank_account_id,
          provider_payment_method_id, holder_name, last_four, verification_status,
          connection_status, can_send, can_receive, is_default, connected_at)
       VALUES ($1::uuid, 'moov', 'sandbox', $2, $3, $4, $5, '0001', 'verified', 'connected', true, true, true, now())
       ON CONFLICT DO NOTHING`,
      [tenantId, accountId, methodId, methodId, NAME],
    ).catch(() => {});
    const method = (await client.query(
      `SELECT provider_payment_method_id FROM public.payment_provider_methods
       WHERE tenant_id = $1::uuid AND provider_payment_method_id = $2 LIMIT 1`,
      [tenantId, methodId],
    )).rows[0];
    if (!method) {
      await client.query(
        `INSERT INTO public.payment_provider_methods
           (tenant_id, provider, environment, provider_account_id, provider_bank_account_id,
            provider_payment_method_id, holder_name, last_four, verification_status,
            connection_status, can_send, can_receive, is_default, connected_at)
         VALUES ($1::uuid, 'moov', 'sandbox', $2, $3, $4, $5, '0001', 'verified', 'connected', true, true, true, now())`,
        [tenantId, accountId, methodId, methodId, NAME],
      ).catch(() => {});
    }

    const authExisting = (await client.query(
      'SELECT id FROM public.tenant_billing_accounts WHERE tenant_id = $1::uuid',
      [tenantId],
    )).rows[0];
    if (authExisting) {
      await client.query(
        `UPDATE public.tenant_billing_accounts SET
           auto_debit_enabled = true,
           ach_authorized_at = COALESCE(ach_authorized_at, now()),
           ach_authorized_by = COALESCE(ach_authorized_by, $2::uuid),
           provider_payment_method_id = $3,
           provider_account_id = $4,
           provider_environment = 'sandbox',
           account_number_last4 = '0001',
           verification_status = 'verified',
           updated_at = now()
         WHERE tenant_id = $1::uuid`,
        [tenantId, OWNER, methodId, accountId],
      );
    } else {
      await client.query(
        `INSERT INTO public.tenant_billing_accounts (
           tenant_id, account_holder_name, account_number_last4, account_type, entity_type,
           auto_debit_enabled, ach_authorized_at, ach_authorized_by, verification_status,
           provider_payment_method_id, provider_bank_account_id, provider_account_id,
           provider_environment, nickname
         ) VALUES (
           $1::uuid, $2, '0001', 'checking', 'business',
           true, now(), $3::uuid, 'verified',
           $4, $4, $5, 'sandbox', 'SYNTHETIC staging funding'
         )`,
        [tenantId, NAME, OWNER, methodId, accountId],
      );
    }

    const result = {
      ok: true,
      mode: MODE,
      tenantId,
      slug: SLUG,
      synthetic: true,
      freedomUntouched: true,
      created: !existing,
    };

    if (MODE === 'config') {
      const tenant = (await client.query(
        `SELECT monthly_rate_cents, referral_discount_cents, per_check_rate_cents,
                next_day_rate_cents, same_day_rate_cents
         FROM public.tenants WHERE id = $1::uuid`,
        [tenantId],
      )).rows[0];
      return { ...result, tenant };
    }

    const intakeCols = await cols(client, 'check_intake_items');
    const eventCols = await cols(client, 'check_billing_events');
    const transferCols = await cols(client, 'payment_transfers');
    const intakeNullable = eventCols.get('check_intake_item_id')?.is_nullable === 'YES';

    const insertCheck = async (label) => {
      const fields = [];
      const values = [];
      const params = [];
      let n = 1;
      const add = (col, val) => {
        if (!hasCol(intakeCols, col)) return;
        fields.push(col);
        values.push(`$${n++}`);
        params.push(val);
      };
      add('tenant_id', tenantId);
      add('front_image_path', `synthetic://consolidated-billing/${label}.png`);
      add('status', 'uploaded');
      add('payee_line', `SYNTHETIC ${label}`);
      add('amount', 100);
      add('check_number', label);
      if (!fields.length) throw new Error('check_intake_items has no insertable columns');
      const row = (await client.query(
        `INSERT INTO public.check_intake_items (${fields.join(',')}) VALUES (${values.join(',')}) RETURNING id`,
        params,
      )).rows[0];
      return row.id;
    };

    const insertEvent = async ({
      eventType, unit, billedAt, period, checkId = null, transferId = null, sourceKind = null, sourceId = null,
    }) => {
      const fields = ['tenant_id', 'event_type', 'unit_price_cents', 'currency', 'status', 'billed_at'];
      const params = [tenantId, eventType, unit, 'usd', 'recorded', billedAt];
      let n = 7;
      const add = (col, val) => {
        if (!hasCol(eventCols, col)) return;
        fields.push(col);
        params.push(val);
      };
      if (hasCol(eventCols, 'billing_period')) add('billing_period', period);
      if (hasCol(eventCols, 'source_kind')) add('source_kind', sourceKind || eventType);
      if (hasCol(eventCols, 'source_id')) add('source_id', sourceId || transferId || checkId);
      if (hasCol(eventCols, 'payment_transfer_id')) add('payment_transfer_id', transferId);
      if (hasCol(eventCols, 'check_intake_item_id')) {
        if (checkId) add('check_intake_item_id', checkId);
        else if (!intakeNullable) {
          const dummy = await insertCheck(`dummy-${eventType}-${Date.now()}`);
          add('check_intake_item_id', dummy);
        }
      }
      const placeholders = fields.map((_, idx) => `$${idx + 1}`);
      const row = (await client.query(
        `INSERT INTO public.check_billing_events (${fields.join(',')}) VALUES (${placeholders.join(',')})
         RETURNING id, event_type, unit_price_cents, billed_at, billing_period, payment_transfer_id`,
        params,
      )).rows[0];
      return row;
    };

    if (MODE === 'seed10950') {
      await client.query(
        `DELETE FROM public.check_billing_events
         WHERE tenant_id = $1::uuid
           AND billing_period = $2
           AND invoice_id IS NULL`,
        [tenantId, PERIOD],
      ).catch(() => {});
      const sept = '2026-09-15T16:00:00.000Z';
      const checks = [];
      for (const label of ['chk-a', 'chk-b', 'chk-c']) {
        const checkId = await insertCheck(label);
        checks.push(await insertEvent({
          eventType: 'check_processing', unit: 400, billedAt: sept, period: PERIOD, checkId, sourceId: checkId,
        }));
      }
      const insertTransfer = async (speed, key) => {
        const fields = ['tenant_id', 'provider', 'environment', 'status', 'idempotency_key', 'amount_cents', 'speed', 'completed_at'];
        const params = [tenantId, 'moov', 'sandbox', 'completed', key, 25000, speed, sept];
        if (hasCol(transferCols, 'requested_speed')) {
          fields.push('requested_speed');
          params.push(speed);
        }
        if (hasCol(transferCols, 'currency')) {
          fields.push('currency');
          params.push('USD');
        }
        if (hasCol(transferCols, 'description')) {
          fields.push('description');
          params.push(`SYNTHETIC ${speed} ${key}`);
        }
        const placeholders = fields.map((_, idx) => `$${idx + 1}`);
        return (await client.query(
          `INSERT INTO public.payment_transfers (${fields.join(',')}) VALUES (${placeholders.join(',')})
           ON CONFLICT DO NOTHING
           RETURNING id, speed, status, completed_at`,
          params,
        )).rows[0] || (await client.query(
          `SELECT id, speed, status, completed_at FROM public.payment_transfers
           WHERE tenant_id = $1::uuid AND idempotency_key = $2 LIMIT 1`,
          [tenantId, key],
        )).rows[0];
      };
      const nd1 = await insertTransfer('standard', `synth-nd-1-${PERIOD}`);
      const nd2 = await insertTransfer('standard', `synth-nd-2-${PERIOD}`);
      const sd1 = await insertTransfer('same_day', `synth-sd-1-${PERIOD}`);
      const nextDay = [
        await insertEvent({
          eventType: 'moov_next_day', unit: 75, billedAt: sept, period: PERIOD,
          transferId: nd1.id, sourceId: nd1.id,
        }),
        await insertEvent({
          eventType: 'moov_next_day', unit: 75, billedAt: sept, period: PERIOD,
          transferId: nd2.id, sourceId: nd2.id,
        }),
      ];
      const sameDay = [
        await insertEvent({
          eventType: 'moov_same_day', unit: 100, billedAt: sept, period: PERIOD,
          transferId: sd1.id, sourceId: sd1.id,
        }),
      ];
      const oct = await insertTransfer('standard', 'synth-nd-oct-2026-10');
      await client.query(
        `UPDATE public.payment_transfers SET completed_at = '2026-10-05T16:00:00.000Z', created_at = '2026-10-05T16:00:00.000Z'
         WHERE id = $1::uuid`,
        [oct.id],
      );
      await insertEvent({
        eventType: 'moov_next_day', unit: 75, billedAt: '2026-10-05T16:00:00.000Z', period: '2026-10',
        transferId: oct.id, sourceId: oct.id,
      });

      const legacyExisting = (await client.query(
        `SELECT id, amount_cents, billing_period, status, provider_transfer_id
         FROM public.tenant_maintenance_payments
         WHERE tenant_id = $1::uuid AND amount_cents = 1 AND (billing_period IS NULL OR billing_period = '')
         LIMIT 1`,
        [tenantId],
      )).rows[0];
      let legacy = legacyExisting;
      if (!legacy) {
        legacy = (await client.query(
          `INSERT INTO public.tenant_maintenance_payments (
             tenant_id, amount_cents, monthly_rate_cents, discount_cents,
             period_start, period_end, billing_period, method, status,
             idempotence_key, notes
           ) VALUES (
             $1::uuid, 1, 1, 0, NULL, NULL, NULL, 'moov_ach', 'submitted',
             $2, 'SYNTHETIC period-less provider-less $0.01 legacy row. Not Freedom.'
           ) RETURNING id, amount_cents, billing_period, status, provider_transfer_id`,
          [tenantId, `legacy-penny-${tenantId}`],
        )).rows[0];
      }

      result.usage = {
        checks: checks.map((r) => ({ id: r.id, unit: r.unit_price_cents })),
        nextDay: nextDay.map((r) => ({ id: r.id, unit: r.unit_price_cents, transfer: r.payment_transfer_id })),
        sameDay: sameDay.map((r) => ({ id: r.id, unit: r.unit_price_cents, transfer: r.payment_transfer_id })),
        octoberTransferId: oct.id,
      };
      result.legacyPenny = {
        id: legacy.id,
        amount_cents: legacy.amount_cents,
        billing_period: legacy.billing_period,
        status: legacy.status,
        provider_transfer_id: legacy.provider_transfer_id,
        freedomRowUntouched: true,
      };
    }

    if (MODE === 'promo50') {
      const billedAt = new Date().toISOString();
      const key = `synth-nd-promo-${Date.now()}`;
      const fields = ['tenant_id', 'provider', 'environment', 'status', 'idempotency_key', 'amount_cents', 'speed', 'completed_at'];
      const params = [tenantId, 'moov', 'sandbox', 'completed', key, 15000, 'standard', billedAt];
      if (hasCol(transferCols, 'requested_speed')) {
        fields.push('requested_speed');
        params.push('standard');
      }
      const placeholders = fields.map((_, idx) => `$${idx + 1}`);
      const transfer = (await client.query(
        `INSERT INTO public.payment_transfers (${fields.join(',')}) VALUES (${placeholders.join(',')}) RETURNING id`,
        params,
      )).rows[0];
      const event = await insertEvent({
        eventType: 'moov_next_day', unit: 50, billedAt, period: PERIOD,
        transferId: transfer.id, sourceId: transfer.id,
      });
      result.promoLine = { transferId: transfer.id, eventId: event.id, unit_price_cents: event.unit_price_cents };
    }

    const tenant = (await client.query(
      `SELECT id, name, slug, monthly_rate_cents, referral_discount_cents, per_check_rate_cents,
              next_day_rate_cents, same_day_rate_cents
       FROM public.tenants WHERE id = $1::uuid`,
      [tenantId],
    )).rows[0];
    const counts = (await client.query(
      `SELECT event_type, count(*)::int AS n, sum(unit_price_cents)::int AS cents
       FROM public.check_billing_events
       WHERE tenant_id = $1::uuid AND billing_period = $2
       GROUP BY 1 ORDER BY 1`,
      [tenantId, PERIOD],
    )).rows;
    return { ...result, tenant, periodCounts: counts };
  } catch (error) {
    return { ok: false, error: String(error.message || error).slice(0, 800) };
  } finally {
    await client.end();
  }
};
