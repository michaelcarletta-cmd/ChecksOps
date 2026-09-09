#!/usr/bin/env node
/**
 * Dry-run the endorsing child tenant_id backfill inside a single transaction
 * and always ROLLBACK. Never COMMIT. Never apply to production from this script.
 *
 *   CHECKSOPS_BACKFILL_DATABASE_URL=postgres://... node dry-run-endorsing-tenant-backfill.mjs
 *
 * Optional:
 *   CHECKSOPS_AUDIT_OUT=/tmp/endorsing-backfill-dry-run.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireFromApi = createRequire(new URL('../../functions/api/package.json', import.meta.url));
const { Client } = requireFromApi('pg');

const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';
const REPORTED = ['271682', '439969', '102931566', '129810787', '070668', '70668', '1070668'];

const connectionString = process.env.CHECKSOPS_BACKFILL_DATABASE_URL;
if (!connectionString) {
  console.error('Missing CHECKSOPS_BACKFILL_DATABASE_URL.');
  process.exit(2);
}
if (process.env.CHECKSOPS_BACKFILL_APPLY === '1') {
  console.error('Refusing apply. This script is dry-run / ROLLBACK only.');
  process.exit(2);
}

const sqlPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../sql/39_endorsing_child_tenant_backfill.sql',
);
const migrationSql = fs.readFileSync(sqlPath, 'utf8');

const localName = !connectionString.includes('://');
const ssl = localName || /localhost|127\.0\.0\.1|host=\/var\/run\/postgresql/.test(connectionString)
  ? undefined
  : { rejectUnauthorized: false };

const clientConfig = {
  connectionString: localName ? undefined : connectionString,
  application_name: 'checksops_endorsing_tenant_backfill_dry_run',
  statement_timeout: 60000,
  query_timeout: 70000,
  ssl,
};
if (localName) {
  clientConfig.host = '/var/run/postgresql';
  clientConfig.user = process.env.USER || 'ubuntu';
  clientConfig.database = connectionString;
} else if (/localhost|127\.0\.0\.1/.test(connectionString) && !/@[^@/]+:[^@/]+@/.test(connectionString)) {
  clientConfig.host = '/var/run/postgresql';
}

const client = new Client(clientConfig);

const classifySql = `
SELECT
  count(*) FILTER (WHERE child_tenant_id IS NULL AND parent_id IS NOT NULL AND parent_tenant_id IS NOT NULL) AS to_backfill,
  count(*) FILTER (WHERE child_tenant_id IS NULL AND parent_id IS NULL) AS orphan_no_parent,
  count(*) FILTER (WHERE child_tenant_id IS NULL AND parent_id IS NOT NULL AND parent_tenant_id IS NULL) AS parent_tenant_null,
  count(*) FILTER (WHERE child_tenant_id IS NOT NULL AND parent_id IS NOT NULL AND parent_tenant_id IS NOT NULL AND child_tenant_id IS DISTINCT FROM parent_tenant_id) AS mismatch,
  count(*) AS total
FROM (
  SELECT c.tenant_id AS child_tenant_id, i.id AS parent_id, i.tenant_id AS parent_tenant_id
  FROM public.$table c
  LEFT JOIN public.check_intake_items i ON i.id = c.check_id
) s
`;

const visibilitySql = `
SELECT
  (SELECT count(*) FROM public.check_intake_items WHERE tenant_id = $1 AND check_stage = 'endorsing') AS endorsing_parents,
  (SELECT count(*) FROM public.check_payees p
     JOIN public.check_intake_items i ON i.id = p.check_id
     WHERE i.tenant_id = $1 AND i.check_stage = 'endorsing' AND p.tenant_id = $1) AS tester_endorsing_payees,
  (SELECT count(*) FROM public.check_payees p
     JOIN public.check_intake_items i ON i.id = p.check_id
     WHERE i.tenant_id = $1 AND i.check_stage = 'endorsing') AS endorsing_payees_total,
  (SELECT count(*) FROM public.check_endorsements e
     JOIN public.check_intake_items i ON i.id = e.check_id
     WHERE i.tenant_id = $1 AND i.check_stage = 'endorsing' AND e.tenant_id = $1) AS tester_endorsing_endorsements,
  (SELECT count(*) FROM public.check_endorsements e
     JOIN public.check_intake_items i ON i.id = e.check_id
     WHERE i.tenant_id = $1 AND i.check_stage = 'endorsing') AS endorsing_endorsements_total,
  (SELECT count(*) FROM public.check_intake_items WHERE tenant_id = $2) AS c1c_intake,
  (SELECT count(*) FROM public.check_payees WHERE tenant_id = $2) AS c1c_payees,
  (SELECT count(*) FROM public.check_endorsements WHERE tenant_id = $2) AS c1c_endorsements
`;

const reportedSql = `
SELECT i.check_number, i.check_stage,
  (SELECT count(*) FROM public.check_payees p WHERE p.check_id = i.id) AS payees,
  (SELECT count(*) FROM public.check_payees p WHERE p.check_id = i.id AND p.tenant_id = i.tenant_id) AS payees_visible_to_parent_tenant,
  (SELECT count(*) FROM public.check_endorsements e WHERE e.check_id = i.id) AS endorsements,
  (SELECT count(*) FROM public.check_endorsements e WHERE e.check_id = i.id AND e.tenant_id = i.tenant_id) AS endorsements_visible_to_parent_tenant
FROM public.check_intake_items i
WHERE i.check_number = ANY($1::text[])
ORDER BY i.check_number, i.check_stage
`;

const notices = [];
client.on('notice', (msg) => notices.push(String(msg.message || msg)));

const out = {
  mode: 'dry-run-rollback',
  generated_at: new Date().toISOString(),
  applied: false,
  committed: false,
};

try {
  await client.connect();
  await client.query('BEGIN');
  await client.query('SET TRANSACTION READ WRITE');
  out.before = {
    payees: (await client.query(classifySql.replace('$table', 'check_payees'))).rows[0],
    endorsements: (await client.query(classifySql.replace('$table', 'check_endorsements'))).rows[0],
    visibility: (await client.query(visibilitySql, [FREEDOM, C1C])).rows[0],
    reported: (await client.query(reportedSql, [REPORTED])).rows,
  };
  await client.query(migrationSql);
  out.notices = notices;
  out.after = {
    payees: (await client.query(classifySql.replace('$table', 'check_payees'))).rows[0],
    endorsements: (await client.query(classifySql.replace('$table', 'check_endorsements'))).rows[0],
    visibility: (await client.query(visibilitySql, [FREEDOM, C1C])).rows[0],
    reported: (await client.query(reportedSql, [REPORTED])).rows,
  };
  await client.query('ROLLBACK');
  out.rolled_back = true;
  const confirm = await client.query(`
    SELECT
      (SELECT count(*) FILTER (WHERE tenant_id IS NULL) FROM public.check_payees) AS payees_null_after_rollback,
      (SELECT count(*) FILTER (WHERE tenant_id IS NULL) FROM public.check_endorsements) AS endorsements_null_after_rollback
  `);
  out.after_rollback = confirm.rows[0];
} catch (error) {
  try { await client.query('ROLLBACK'); } catch { /* ignore */ }
  out.error = String(error.message || error).slice(0, 500);
  console.error(JSON.stringify(out, null, 2));
  process.exit(1);
} finally {
  await client.end();
}

const dest = process.env.CHECKSOPS_AUDIT_OUT;
if (dest) fs.writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
