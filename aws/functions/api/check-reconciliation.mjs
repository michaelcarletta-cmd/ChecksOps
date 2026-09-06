/**
 * Nightly / on-demand check reconciliation (Class A, non-financial).
 * Detects stale checks, missing loss-draft rows, and dashboard count mismatch.
 * Skips S3 orphan walks. Does not move money.
 */
import { withIdentityWrite } from './data.mjs';
import { USER_ROLES_SQL, TENANT_MEMBERSHIP_SQL } from './identity.mjs';

const DASHBOARD_BUCKETS = [
  'uploaded',
  'needs_review',
  'endorsing',
  'endorsements_in_progress',
  'approved_for_deposit',
  'loss_draft_required',
  'branch_deposit_required',
  'deposited',
];

const safeQuery = async (client, sql, params = []) => {
  try {
    return await client.query(sql, params);
  } catch {
    return { rows: [], rowCount: 0 };
  }
};

const isStaff = (roles = []) => {
  const set = new Set(roles.map((role) => String(role || '').toLowerCase()));
  return set.has('admin') || set.has('owner') || set.has('manager') || set.has('staff') || set.has('mortgage_agent');
};

export const buildReconciliationAlerts = ({
  stuck = [],
  missingLossDraft = [],
  total = 0,
  bucketSum = 0,
} = {}) => {
  const alerts = [];
  for (const row of stuck) {
    if (!row.is_overdue) continue;
    alerts.push({
      alert_type: 'stale_status',
      severity: Number(row.hours_in_status) > Number(row.sla_hours || 0) * 2 ? 'critical' : 'warning',
      check_intake_item_id: row.id,
      tenant_id: row.tenant_id || null,
      details: {
        status: row.status,
        hours_in_status: row.hours_in_status,
        sla_hours: row.sla_hours,
      },
    });
  }
  for (const row of missingLossDraft) {
    alerts.push({
      alert_type: 'missing_loss_draft_row',
      severity: 'warning',
      check_intake_item_id: row.id,
      tenant_id: row.tenant_id || null,
      details: { payee_line: row.payee_line || null },
    });
  }
  if (Number(total) !== Number(bucketSum)) {
    alerts.push({
      alert_type: 'dashboard_count_mismatch',
      severity: 'critical',
      check_intake_item_id: null,
      tenant_id: null,
      details: { total, bucket_sum: bucketSum, missing: Number(total) - Number(bucketSum) },
    });
  }
  return alerts;
};

export const filterAlertsForTenants = (alerts, tenantIds, isAdmin) => {
  if (isAdmin || !tenantIds?.length) return alerts;
  const allowed = new Set(tenantIds);
  return alerts.filter((alert) => !alert.tenant_id || allowed.has(alert.tenant_id));
};

export const runCheckReconciliation = async ({ client, mapping, spoof }) => {
  const roles = (await safeQuery(client, USER_ROLES_SQL, [mapping.application_user_id])).rows
    .map((row) => row.role);
  const memberships = (await safeQuery(client, TENANT_MEMBERSHIP_SQL, [mapping.application_user_id])).rows;
  const tenantIds = memberships.map((row) => row.tenant_id).filter(Boolean);
  const admin = roles.map((role) => String(role).toLowerCase()).includes('admin');
  if (!admin && !isStaff(roles) && !tenantIds.length) {
    return { ok: false, statusCode: 403, error: 'forbidden', spoofFieldsIgnored: spoof };
  }

  const stuck = (await safeQuery(client, 'SELECT * FROM public.get_stuck_checks()')).rows;
  const mortgage = (await safeQuery(
    client,
    `SELECT c.id, c.payee_line, c.tenant_id
     FROM public.check_intake_items c
     WHERE COALESCE(c.mortgage_monitoring_type, 'not_set') IS DISTINCT FROM 'not_set'
       AND NOT EXISTS (
         SELECT 1 FROM public.loss_draft_tracking l
         WHERE l.check_intake_item_id = c.id
       )`,
  )).rows;
  const scopedStuck = admin ? stuck : stuck.filter((row) => !row.tenant_id || tenantIds.includes(row.tenant_id));
  const scopedMortgage = admin ? mortgage : mortgage.filter((row) => tenantIds.includes(row.tenant_id));

  const totalSql = admin
    ? 'SELECT count(*)::int AS n FROM public.check_intake_items'
    : 'SELECT count(*)::int AS n FROM public.check_intake_items WHERE tenant_id = ANY($1::uuid[])';
  const bucketSql = admin
    ? 'SELECT count(*)::int AS n FROM public.check_intake_items WHERE status = $1'
    : 'SELECT count(*)::int AS n FROM public.check_intake_items WHERE status = $1 AND tenant_id = ANY($2::uuid[])';
  const total = (await safeQuery(client, totalSql, admin ? [] : [tenantIds])).rows[0]?.n || 0;
  let bucketSum = 0;
  for (const status of DASHBOARD_BUCKETS) {
    const n = (await safeQuery(client, bucketSql, admin ? [status] : [status, tenantIds])).rows[0]?.n || 0;
    bucketSum += n;
  }

  const alerts = filterAlertsForTenants(
    buildReconciliationAlerts({
      stuck: scopedStuck,
      missingLossDraft: scopedMortgage,
      total,
      bucketSum,
    }),
    tenantIds,
    admin,
  );

  let inserted = 0;
  for (const alert of alerts) {
    if (alert.check_intake_item_id) {
      const existing = (await safeQuery(
        client,
        `SELECT 1 FROM public.check_reconciliation_alerts
         WHERE check_intake_item_id = $1::uuid
           AND alert_type = $2
           AND COALESCE(resolved, false) = false
         LIMIT 1`,
        [alert.check_intake_item_id, alert.alert_type],
      )).rows[0];
      if (existing) continue;
    }
    await safeQuery(
      client,
      `INSERT INTO public.check_reconciliation_alerts (
         alert_type, severity, check_intake_item_id, details
       ) VALUES ($1, $2, $3::uuid, $4::jsonb)`,
      [alert.alert_type, alert.severity, alert.check_intake_item_id, JSON.stringify(alert.details || {})],
    );
    inserted += 1;
  }

  return {
    ok: true,
    statusCode: 200,
    total_checked: total,
    alerts_found: alerts.length,
    alerts_inserted: inserted,
    orphan_storage_skipped: true,
    spoofFieldsIgnored: spoof,
  };
};

export const handleCheckReconciliation = (event, deps = {}) => (
  withIdentityWrite(event, (ctx) => runCheckReconciliation(ctx), deps)
);
