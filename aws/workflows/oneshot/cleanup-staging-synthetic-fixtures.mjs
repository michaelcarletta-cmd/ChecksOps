/**
 * Staging-only inspect/delete of the accepted synthetic workflow fixtures.
 * Refuses production hosts. Allowlist IDs only. No wildcard deletes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  path.join(ROOT, '..', '..', 'functions', 'api', 'rds-global-bundle.pem'),
].find((p) => fs.existsSync(p));

const CHECK_IDS = [
  '546a43b8-e625-49fc-a359-03b619692f29',
  '368e8d91-bc8a-412f-89e1-5969f76b61f9',
  'ef470398-6df7-4532-b405-87ddf3dfddce',
  '31afc7c3-a9cd-436b-a902-0899dd98caae',
  'a4188a08-4583-419a-9b58-b96d8ff1fcb5',
];
const BATCH_IDS = ['37220f8e-3fb5-4cff-bd55-8575d3192518'];
const SPLIT_IDS = ['0ffb22e8-ee3a-489e-8ccf-8fdd4be779eb'];
const FAMILY_PREFIX = 'AWS-WS-COMPLETION 2026-09-23T21:57:09.630Z';

const adminClient = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn) throw new Error('ADMIN_SECRET_ARN is not configured');
  if (/checksops-production/i.test(arn)) throw new Error('refusing production admin secret');
  if (!/checksops-staging\/checksops_admin/i.test(arn)) {
    throw new Error('ADMIN_SECRET_ARN must be the staging checksops_admin secret');
  }
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) {
    throw new Error('secret username is not checksops_admin');
  }
  const host = parsed.host && parsed.host !== 'localhost'
    ? parsed.host
    : process.env.RDS_HOST;
  if (!host || !/checksops-staging/i.test(host) || /production/i.test(host)) {
    throw new Error(`refusing unexpected RDS host ${host}`);
  }
  const client = new Client({
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
    database: process.env.DATABASE_NAME || 'checksops',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000,
    query_timeout: 120000,
  });
  await client.connect();
  return { client, host };
};

const tableExists = async (client, name) => {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [name],
  );
  return rows.length > 0;
};

const cols = async (client, table) => {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
};

const inspectChecks = async (client) => {
  const { rows } = await client.query(
    `SELECT id, check_number, carrier_name, status, check_stage, claim_id, tenant_id, amount, created_at, updated_at
     FROM public.check_intake_items WHERE id = ANY($1::uuid[])`,
    [CHECK_IDS],
  );
  return rows;
};

const familyOthers = async (client) => {
  const { rows } = await client.query(
    `SELECT id, check_number, carrier_name, status, check_stage, claim_id
     FROM public.check_intake_items
     WHERE NOT (id = ANY($1::uuid[]))
       AND (
         carrier_name LIKE 'AWS-WS-COMPLETION%'
         OR check_number LIKE 'WS-UI-%'
         OR id = ANY($2::uuid[])
       )
     ORDER BY created_at`,
    [CHECK_IDS, [
      'd2102bb2-a3ab-4b95-b84c-4b941615b8a1',
      '8ef769b9-5710-48e0-a64c-a54cdfa2bff3',
      '8189e8f5-dfb1-4e2a-b159-4f1658050c0c',
      '98ab21ff-456f-4b17-ba36-603f95612069',
    ]],
  );
  return rows;
};

const collectDependents = async (client, checkIds) => {
  const found = {};
  const add = (table, rows) => {
    found[table] = (found[table] || []).concat(rows);
  };

  const probes = [
    ['check_payees', 'check_id'],
    ['check_endorsements', 'check_id'],
    ['check_endorsement_events', 'check_id'],
    ['check_messages', 'check_id'],
    ['check_message_reads', 'check_id'],
    ['check_files', 'check_intake_item_id'],
    ['check_audit_log', 'check_id'],
    ['check_review_decisions', 'check_id'],
    ['check_eligibility_results', 'check_id'],
    ['check_payment_directions', 'check_id'],
    ['shared_checks', 'check_id'],
    ['deposit_items', 'check_id'],
    ['disbursement_batches', 'check_intake_item_id'],
    ['mortgage_handling_requests', 'check_intake_item_id'],
    ['loss_draft_tracking', 'check_intake_item_id'],
    ['check_cases', 'check_id'],
    ['notifications', 'check_id'],
    ['in_app_notifications', 'check_id'],
    ['signature_requests', 'check_id'],
    ['endorsement_tokens', 'check_id'],
    ['check_endorsement_tokens', 'check_id'],
    ['aws_workflow_events', 'check_id'],
    ['aws_partner_check_payees', 'check_id'],
    ['aws_partner_check_endorsements', 'check_id'],
  ];

  for (const [table, col] of probes) {
    if (!(await tableExists(client, table))) continue;
    const c = await cols(client, table);
    if (!c.has(col)) continue;
    const idCol = c.has('id') ? 'id' : col;
    const extra = ['status', 'amount', 'action', 'kind', 'path', 'file_path', 'storage_path', 'batch_id']
      .filter((name) => c.has(name));
    const select = [idCol, col, ...extra].filter((v, i, a) => a.indexOf(v) === i);
    const { rows } = await client.query(
      `SELECT ${select.map((n, i) => `${n} AS c${i}`).join(', ')} FROM public.${table} WHERE ${col} = ANY($1::uuid[])`,
      [checkIds],
    );
    add(table, rows.map((row) => {
      const out = {};
      select.forEach((name, i) => { out[name] = row[`c${i}`]; });
      return out;
    }));
  }

  const batchIds = [
    ...BATCH_IDS,
    ...(found.disbursement_batches || []).map((r) => r.id).filter(Boolean),
  ];
  const depositItemIds = (found.deposit_items || []).map((r) => r.id).filter(Boolean);
  const depositBatchIds = [
    ...(found.deposit_items || []).map((r) => r.batch_id).filter(Boolean),
  ];

  if (batchIds.length && await tableExists(client, 'disbursement_splits')) {
    const { rows } = await client.query(
      `SELECT id, batch_id, amount, status, external_check_number, recipient_name
       FROM public.disbursement_splits
       WHERE batch_id = ANY($1::uuid[]) OR id = ANY($2::uuid[])`,
      [batchIds, SPLIT_IDS],
    );
    add('disbursement_splits', rows);
  }
  if (depositItemIds.length && await tableExists(client, 'deposit_audit_log')) {
    const { rows } = await client.query(
      `SELECT id, deposit_item_id, batch_id, action, amount
       FROM public.deposit_audit_log WHERE deposit_item_id = ANY($1::uuid[])`,
      [depositItemIds],
    );
    add('deposit_audit_log', rows);
  }
  if (depositBatchIds.length && await tableExists(client, 'deposit_batches')) {
    const { rows } = await client.query(
      `SELECT id, status, created_by FROM public.deposit_batches WHERE id = ANY($1::uuid[])`,
      [depositBatchIds],
    );
    add('deposit_batches', rows);
  }

  // audit / activity rows that store check id in jsonb or entity_id
  for (const [table, col] of [
    ['audit_events', 'entity_id'],
    ['activity_log', 'entity_id'],
    ['app_events', 'entity_id'],
  ]) {
    if (!(await tableExists(client, table))) continue;
    const c = await cols(client, table);
    if (!c.has(col)) continue;
    const { rows } = await client.query(
      `SELECT id FROM public.${table} WHERE ${col} = ANY($1::uuid[])`,
      [checkIds],
    );
    add(table, rows);
  }

  return found;
};

const syntheticOk = (row) => {
  const carrier = String(row.carrier_name || '');
  const number = String(row.check_number || '');
  const id = String(row.id);
  const family = carrier === FAMILY_PREFIX || carrier.startsWith('AWS-WS-COMPLETION');
  const uiNumber = /^WS-UI-/.test(number);
  const phase1 = id === 'a4188a08-4583-419a-9b58-b96d8ff1fcb5';
  return {
    ok: !row.claim_id && (family || uiNumber || phase1),
    family,
    uiNumber,
    phase1,
    claimLinked: Boolean(row.claim_id),
  };
};

const deletePlan = (dependents) => {
  const order = [
    'disbursement_splits',
    'disbursement_batches',
    'deposit_audit_log',
    'deposit_items',
    'deposit_batches',
    'check_endorsement_events',
    'check_endorsements',
    'check_payees',
    'check_messages',
    'check_message_reads',
    'check_files',
    'check_audit_log',
    'check_review_decisions',
    'check_eligibility_results',
    'check_payment_directions',
    'shared_checks',
    'signature_requests',
    'endorsement_tokens',
    'check_endorsement_tokens',
    'notifications',
    'in_app_notifications',
    'aws_workflow_events',
    'aws_partner_check_payees',
    'aws_partner_check_endorsements',
    'mortgage_handling_requests',
    'check_cases',
    'audit_events',
    'activity_log',
    'app_events',
    'check_intake_items',
  ];
  return order
    .filter((table) => (dependents[table] || []).length)
    .map((table) => ({ table, count: dependents[table].length, ids: dependents[table].map((r) => r.id).filter(Boolean) }));
};

export const handler = async (event = {}) => {
  const apply = event.apply === true || event.apply === 'true';
  const { client, host } = await adminClient();
  try {
    const checks = await inspectChecks(client);
    const others = await familyOthers(client);
    const proofs = checks.map((row) => ({ ...row, synthetic: syntheticOk(row) }));
    const dependents = await collectDependents(client, checks.map((r) => r.id));
    dependents.check_intake_items = checks.map((r) => ({ id: r.id }));
    const plan = deletePlan(dependents);
    const depositBatchIds = (dependents.deposit_batches || []).map((r) => r.id).filter(Boolean);
    let foreignDepositItems = [];
    if (depositBatchIds.length) {
      const allowItemIds = (dependents.deposit_items || []).map((r) => r.id);
      foreignDepositItems = (await client.query(
        `SELECT id, batch_id, check_id FROM public.deposit_items
         WHERE batch_id = ANY($1::uuid[]) AND NOT (id = ANY($2::uuid[]))`,
        [depositBatchIds, allowItemIds],
      )).rows;
    }
    const allSynthetic = proofs.length === CHECK_IDS.length && proofs.every((p) => p.synthetic.ok);
    const missing = CHECK_IDS.filter((id) => !checks.some((r) => r.id === id));
    let deleted = null;
    if (apply) {
      if (!allSynthetic || foreignDepositItems.length) {
        return {
          ok: false,
          error: foreignDepositItems.length
            ? 'refusing delete: deposit batch has non-allowlisted items'
            : 'refusing delete: not all allowlisted checks proven synthetic/staging',
          host,
          proofs,
          missing,
          foreignDepositItems,
        };
      }
      await client.query('BEGIN');
      try {
        const counts = {};
        for (const step of plan) {
          if (step.table === 'check_intake_items') {
            const { rowCount } = await client.query(
              `DELETE FROM public.check_intake_items
               WHERE id = ANY($1::uuid[]) AND claim_id IS NULL`,
              [CHECK_IDS],
            );
            counts[step.table] = rowCount;
            continue;
          }
          const ids = step.ids;
          if (!ids.length) continue;
          const { rowCount } = await client.query(
            `DELETE FROM public.${step.table} WHERE id = ANY($1::uuid[])`,
            [ids],
          );
          counts[step.table] = rowCount;
        }
        await client.query('COMMIT');
        deleted = counts;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    const remaining = apply ? await inspectChecks(client) : checks;
    const remainingDeps = apply ? await collectDependents(client, CHECK_IDS) : dependents;
    return {
      ok: allSynthetic && (!apply || remaining.length === 0),
      environment: 'staging',
      host,
      apply,
      allowlistedCheckIds: CHECK_IDS,
      allowlistedBatchIds: BATCH_IDS,
      allowlistedSplitIds: SPLIT_IDS,
      proofs,
      missing,
      dependents: Object.fromEntries(Object.entries(dependents).map(([k, v]) => [k, v.length])),
      dependentRows: dependents,
      plan,
      deleted,
      remainingAfter: remaining.map((r) => r.id),
      remainingDependentCounts: Object.fromEntries(
        Object.entries(remainingDeps).map(([k, v]) => [k, v.length]),
      ),
      familyOthersRetained: others,
      foreignDepositItems,
      productionTargeted: false,
      wildcardDelete: false,
    };
  } finally {
    await client.end();
  }
};
