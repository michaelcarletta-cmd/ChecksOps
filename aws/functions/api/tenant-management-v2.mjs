import { withIdentity } from './data.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PERIOD_DAYS = 366;

export const PLATFORM_OWNER_SQL = `
  SELECT public.is_platform_owner() AS is_platform_owner
`;

export const TENANT_OVERVIEW_SQL = `
  SELECT
    t.id::text AS id,
    t.name,
    t.slug,
    t.subscription_status,
    t.plan_tier::text AS plan_tier,
    t.max_checks_per_month,
    t.moov_environment,
    t.per_check_billing_enabled,
    t.per_check_rate_cents,
    t.created_at,
    (SELECT count(*)::int FROM public.tenant_users tu WHERE tu.tenant_id = t.id) AS user_count
  FROM public.tenants t
  WHERE t.id = $1::uuid
  LIMIT 1
`;

export const USAGE_SQL = `
  SELECT count(*)::int AS checks_received
  FROM public.check_intake_items
  WHERE tenant_id = $1::uuid
    AND created_at >= $2::timestamptz
    AND created_at < $3::timestamptz
`;

export const USAGE_INTEGRITY_SQL = `
  WITH processed AS (
    SELECT id
    FROM public.check_intake_items
    WHERE tenant_id = $1::uuid
      AND deposited_at >= $2::timestamptz
      AND deposited_at < $3::timestamptz
  ),
  event_rows AS (
    SELECT
      e.id,
      e.check_intake_item_id,
      e.unit_price_cents,
      e.currency,
      e.status,
      c.id AS matched_check_id,
      c.tenant_id AS check_tenant_id
    FROM public.check_billing_events e
    LEFT JOIN public.check_intake_items c ON c.id = e.check_intake_item_id
    WHERE e.tenant_id = $1::uuid
      AND e.event_type = 'check_processing'
      AND e.billed_at >= $2::timestamptz
      AND e.billed_at < $3::timestamptz
  ),
  event_counts AS (
    SELECT check_intake_item_id, count(*)::int AS event_count
    FROM event_rows
    WHERE matched_check_id IS NOT NULL
      AND check_tenant_id = $1::uuid
    GROUP BY check_intake_item_id
  ),
  duplicates AS (
    SELECT COALESCE(sum(event_count - 1), 0)::int AS duplicate_events
    FROM event_counts
    WHERE event_count > 1
  )
  SELECT
    (SELECT count(*)::int FROM processed) AS processed_checks,
    count(*) FILTER (WHERE COALESCE(ec.event_count, 0) = 1)::int AS matched_checks,
    count(*) FILTER (WHERE COALESCE(ec.event_count, 0) = 0)::int AS missing_usage_events,
    (SELECT duplicate_events FROM duplicates) AS duplicate_billing_events,
    (SELECT count(*)::int FROM event_rows WHERE matched_check_id IS NULL) AS orphan_billing_events,
    (SELECT count(*)::int FROM event_rows
      WHERE status = 'failed'
         OR status = 'voided'
         OR unit_price_cents <= 0
         OR lower(currency) <> 'usd'
         OR (matched_check_id IS NOT NULL AND check_tenant_id IS DISTINCT FROM $1::uuid)
    ) AS suspicious_billing_events
  FROM processed p
  LEFT JOIN event_counts ec ON ec.check_intake_item_id = p.id
`;

export const BILLING_FEES_SQL = `
  SELECT
    count(*) FILTER (WHERE status IN ('recorded', 'reported', 'invoiced'))::int AS fee_events,
    COALESCE(sum(unit_price_cents) FILTER (
      WHERE status IN ('recorded', 'reported', 'invoiced') AND lower(currency) = 'usd'
    ), 0)::bigint AS check_and_disbursement_fees_cents,
    count(*) FILTER (
      WHERE status IN ('recorded', 'reported', 'invoiced') AND lower(currency) <> 'usd'
    )::int AS non_usd_fee_events,
    count(*) FILTER (WHERE status = 'failed')::int AS failed_fee_events
  FROM public.check_billing_events
  WHERE tenant_id = $1::uuid
    AND billed_at >= $2::timestamptz
    AND billed_at < $3::timestamptz
    AND event_type IN ('check_processing', 'actum_same_day', 'actum_instant')
`;

export const MORTGAGE_USAGE_SQL = `
  SELECT
    count(*) FILTER (WHERE billing_status = 'billed')::int AS billed_requests,
    COALESCE(sum(flat_fee_cents) FILTER (WHERE billing_status = 'billed'), 0)::bigint AS billed_cents,
    count(*) FILTER (WHERE billing_status = 'failed')::int AS failed_billing_requests
  FROM public.mortgage_handling_requests
  WHERE tenant_id = $1::uuid
    AND billed_at >= $2::timestamptz
    AND billed_at < $3::timestamptz
`;

export const PAYMENT_HISTORY_SQL = `
  SELECT
    id::text AS id,
    amount_cents,
    status,
    period_start::text AS period_start,
    period_end::text AS period_end,
    received_at
  FROM public.tenant_maintenance_payments
  WHERE tenant_id = $1::uuid
  ORDER BY received_at DESC
  LIMIT 10
`;

export const PAYMENT_SUMMARY_SQL = `
  SELECT
    count(*) FILTER (WHERE status = 'recorded')::int AS recorded_payments,
    COALESCE(sum(amount_cents) FILTER (WHERE status = 'recorded'), 0)::bigint AS recorded_payments_cents,
    count(*) FILTER (WHERE status = 'cleared')::int AS collected_payments,
    COALESCE(sum(amount_cents) FILTER (WHERE status = 'cleared'), 0)::bigint AS collected_payments_cents
  FROM public.tenant_maintenance_payments
  WHERE tenant_id = $1::uuid
    AND period_start < $3::date
    AND period_end >= $2::date
`;

export const PAYMENT_ACCOUNT_SQL = `
  SELECT auto_debit_enabled, verification_status, ach_authorized_at
  FROM public.tenant_billing_accounts
  WHERE tenant_id = $1::uuid
  LIMIT 1
`;

export const PROVIDER_ACCOUNTS_SQL = `
  SELECT
    environment,
    onboarding_status,
    verification_status,
    can_receive_payments,
    can_send_payments,
    can_ach_debit,
    can_ach_credit,
    restricted,
    disabled,
    CASE WHEN jsonb_typeof(requirements) = 'array'
      THEN jsonb_array_length(requirements)
      ELSE 0
    END::int AS requirements_count,
    last_synced_at
  FROM public.payment_provider_accounts
  WHERE tenant_id = $1::uuid
    AND provider = 'moov'
  ORDER BY updated_at DESC
`;

export const PROVIDER_BANK_STATUS_SQL = `
  SELECT
    count(*)::int AS total,
    count(*) FILTER (WHERE connection_status = 'connected')::int AS connected,
    count(*) FILTER (WHERE connection_status = 'pending')::int AS pending,
    count(*) FILTER (WHERE connection_status = 'disconnected')::int AS disconnected
  FROM public.payment_provider_methods
  WHERE tenant_id = $1::uuid
    AND provider = 'moov'
`;

export const CHECKALT_STATE_SQL = `
  SELECT
    a.enabled,
    a.registered_at,
    COALESCE((
      SELECT default_enabled
      FROM public.checkalt_config
      WHERE singleton = true
      LIMIT 1
    ), false) AS platform_enabled
  FROM (SELECT $1::uuid AS tenant_id) requested
  LEFT JOIN public.checkalt_tenant_accounts a ON a.tenant_id = requested.tenant_id
`;

export const PROVIDER_ERRORS_SQL = `
  SELECT
    count(*) FILTER (WHERE provider = 'moov')::int AS moov_error_events,
    count(*) FILTER (WHERE provider = 'checkalt')::int AS checkalt_error_events,
    max(received_at) AS last_error_at
  FROM (
    SELECT 'moov'::text AS provider, received_at
    FROM public.payment_webhook_events
    WHERE tenant_id = $1::uuid
      AND provider = 'moov'
      AND processing_error IS NOT NULL
    UNION ALL
    SELECT 'checkalt'::text AS provider, e.received_at
    FROM public.checkalt_webhook_events e
    JOIN public.checkalt_deposits d ON d.checkalt_reference = e.checkalt_reference
    WHERE d.tenant_id = $1::uuid
      AND e.process_error IS NOT NULL
  ) provider_errors
`;

export const OPERATIONS_SQL = `
  SELECT
    (SELECT count(*)::int FROM public.check_intake_items
      WHERE tenant_id = $1::uuid) AS checks_total,
    (SELECT count(*)::int FROM public.check_intake_items
      WHERE tenant_id = $1::uuid AND ocr_status = 'completed') AS ocr_completed,
    (SELECT count(*)::int FROM public.check_intake_items
      WHERE tenant_id = $1::uuid AND ocr_status = 'failed') AS ocr_failed,
    (SELECT count(*)::int FROM public.check_intake_items
      WHERE tenant_id = $1::uuid AND ocr_status IN ('pending', 'processing')) AS ocr_pending,
    (SELECT count(*)::int
      FROM public.check_files f
      JOIN public.check_intake_items c ON c.id = f.check_intake_item_id
      WHERE c.tenant_id = $1::uuid) AS files_total,
    (SELECT COALESCE(sum(f.file_size), 0)::bigint
      FROM public.check_files f
      JOIN public.check_intake_items c ON c.id = f.check_intake_item_id
      WHERE c.tenant_id = $1::uuid AND f.file_size IS NOT NULL) AS known_file_bytes,
    (SELECT count(*)::int
      FROM public.check_files f
      JOIN public.check_intake_items c ON c.id = f.check_intake_item_id
      WHERE c.tenant_id = $1::uuid AND f.file_size IS NULL) AS unknown_file_sizes,
    (SELECT count(*)::int
      FROM public.signature_requests sr
      JOIN public.check_intake_items c ON c.id = sr.check_intake_item_id
      WHERE c.tenant_id = $1::uuid) AS signature_requests_total,
    (SELECT count(*)::int
      FROM public.signature_requests sr
      JOIN public.check_intake_items c ON c.id = sr.check_intake_item_id
      WHERE c.tenant_id = $1::uuid AND sr.status IN ('pending', 'in_progress')) AS signature_requests_open,
    (SELECT count(*)::int
      FROM public.mortgage_handling_requests
      WHERE tenant_id = $1::uuid) AS mortgage_ops_total,
    (SELECT count(*)::int
      FROM public.mortgage_handling_requests
      WHERE tenant_id = $1::uuid AND status IN ('requested', 'in_progress')) AS mortgage_ops_open,
    (SELECT count(*)::int
      FROM public.deposit_items d
      JOIN public.check_intake_items c ON c.id = d.check_id
      WHERE c.tenant_id = $1::uuid) AS deposits_total,
    (SELECT count(*)::int
      FROM public.deposit_items d
      JOIN public.check_intake_items c ON c.id = d.check_id
      WHERE c.tenant_id = $1::uuid
        AND d.status::text NOT IN ('succeeded', 'failed', 'returned', 'reconciled')) AS deposits_open,
    (SELECT count(*)::int FROM public.disbursement_splits
      WHERE tenant_id = $1::uuid) AS disbursements_total,
    (SELECT count(*)::int FROM public.disbursement_splits
      WHERE tenant_id = $1::uuid AND status IS DISTINCT FROM 'settled') AS disbursements_open
`;

export const RECENT_ACTIVITY_SQL = `
  SELECT created_at, event_type AS action, actor_id::text AS actor_id
  FROM public.check_audit_log
  WHERE tenant_id = $1::uuid
  UNION ALL
  SELECT da.created_at, da.action, da.actor_id::text AS actor_id
  FROM public.deposit_audit_log da
  JOIN public.deposit_items d ON d.id = da.deposit_item_id
  JOIN public.check_intake_items c ON c.id = d.check_id
  WHERE c.tenant_id = $1::uuid
  UNION ALL
  SELECT created_at, 'mortgage_ops_' || status AS action, requested_by::text AS actor_id
  FROM public.mortgage_handling_requests
  WHERE tenant_id = $1::uuid
  UNION ALL
  SELECT created_at, 'disbursement_' || status AS action, NULL::text AS actor_id
  FROM public.disbursement_splits
  WHERE tenant_id = $1::uuid
  ORDER BY created_at DESC
  LIMIT 12
`;

export const ADMIN_AUDIT_SQL = `
  SELECT id::text AS id, created_at, user_id::text AS actor_id, action, record_type,
         old_values, new_values
  FROM public.audit_logs
  WHERE record_id = $1
  ORDER BY created_at DESC
  LIMIT 20
`;

const numberValue = (value, field) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`invalid_${field}`);
  return number;
};

const firstRow = (result, field) => {
  const row = result?.rows?.[0];
  if (!row) throw new Error(`missing_${field}`);
  return row;
};

export const resolvePeriod = (query = {}, now = new Date()) => {
  const startInput = query.period_start;
  const endInput = query.period_end;
  if ((startInput && !endInput) || (!startInput && endInput)) {
    return { ok: false };
  }
  let start;
  let end;
  if (startInput && endInput) {
    const iso = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
    if (!iso.test(startInput) || !iso.test(endInput)) return { ok: false };
    start = new Date(startInput);
    end = new Date(endInput);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
      return { ok: false };
    }
  } else {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  }
  const duration = end.getTime() - start.getTime();
  if (duration <= 0 || duration > MAX_PERIOD_DAYS * DAY_MS) return { ok: false };
  return { ok: true, start: start.toISOString(), end: end.toISOString() };
};

const safeAuditFields = new Set([
  'name',
  'subscription_status',
  'plan_tier',
  'max_checks_per_month',
  'per_check_billing_enabled',
  'per_check_rate_cents',
  'monthly_rate_cents',
  'moov_environment',
]);

const safeAuditValue = (value) => {
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string') return value.slice(0, 100);
  return undefined;
};

export const redactAuditValues = (value) => {
  let record = value;
  if (typeof value === 'string') {
    try { record = JSON.parse(value); } catch { return {}; }
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return {};
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => safeAuditFields.has(key))
      .map(([key, entry]) => [key, key === 'name' && typeof entry === 'string'
        && (/@/.test(entry) || /(?:password|secret|token|account|routing)/i.test(entry))
        ? undefined
        : safeAuditValue(entry)])
      .filter(([, entry]) => entry !== undefined),
  );
};

const safeLabel = (value, fallback = 'event') => {
  const raw = String(value || '');
  if (/(?:secret|token|password|credential|routing|account|bank|ssn|ein|email|phone|api.?key|authorization)/i.test(raw)
    || /@|[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(raw)) return fallback;
  const label = raw.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80);
  return label || fallback;
};

const safeAuditAction = (value) => {
  const action = String(value || '').toLowerCase();
  return new Set([
    'created', 'updated', 'deleted', 'insert', 'update', 'delete',
    'tenant_created', 'tenant_updated', 'tenant_deleted', 'status_changed',
    'billing_updated', 'plan_changed', 'configuration_updated',
  ]).has(action) ? action : 'other';
};

const safeActorId = (value) => UUID_RE.test(String(value || '')) ? String(value) : null;

const integritySummary = (row) => {
  const summary = {
    processedChecks: numberValue(row.processed_checks, 'processed_checks'),
    matchedChecks: numberValue(row.matched_checks, 'matched_checks'),
    missingUsageEvents: numberValue(row.missing_usage_events, 'missing_usage_events'),
    orphanBillingEvents: numberValue(row.orphan_billing_events, 'orphan_billing_events'),
    duplicateBillingEvents: numberValue(row.duplicate_billing_events, 'duplicate_billing_events'),
    suspiciousBillingEvents: numberValue(row.suspicious_billing_events, 'suspicious_billing_events'),
  };
  const hasDiscrepancies = Object.entries(summary)
    .some(([key, value]) => key !== 'processedChecks' && value > 0);
  return { ...summary, status: hasDiscrepancies ? 'discrepancies' : 'reconciled' };
};

const paymentHistory = (rows) => rows.map((row) => ({
  id: row.id,
  amountCents: numberValue(row.amount_cents, 'payment_amount_cents'),
  status: safeLabel(row.status, 'unknown'),
  periodStart: row.period_start,
  periodEnd: row.period_end,
  receivedAt: row.received_at,
}));

export const runTenantManagementV2 = async ({
  client,
  tenantId,
  period,
  environment = process.env.CHECKSOPS_ENV || 'unknown',
}) => {
  const owner = firstRow(await client.query(PLATFORM_OWNER_SQL), 'platform_owner');
  if (owner.is_platform_owner !== true) {
    return { ok: false, statusCode: 403, error: 'platform_owner_required' };
  }

  const tenantResult = await client.query(TENANT_OVERVIEW_SQL, [tenantId]);
  const tenant = tenantResult?.rows?.[0];
  if (!tenant) return { ok: false, statusCode: 404, error: 'tenant_not_found' };
  if (String(tenant.id).toLowerCase() !== String(tenantId).toLowerCase()) {
    return { ok: false, statusCode: 503, error: 'tenant_scope_mismatch' };
  }

  const rangeParams = [tenantId, period.start, period.end];
  const usage = firstRow(await client.query(USAGE_SQL, rangeParams), 'usage');
  const integrity = firstRow(await client.query(USAGE_INTEGRITY_SQL, rangeParams), 'integrity');
  const fees = firstRow(await client.query(BILLING_FEES_SQL, rangeParams), 'billing_fees');
  const mortgageUsage = firstRow(await client.query(MORTGAGE_USAGE_SQL, rangeParams), 'mortgage_usage');
  const payments = (await client.query(PAYMENT_HISTORY_SQL, [tenantId])).rows;
  const paymentTotals = firstRow(
    await client.query(PAYMENT_SUMMARY_SQL, rangeParams),
    'payment_summary',
  );
  const billingAccountResult = await client.query(PAYMENT_ACCOUNT_SQL, [tenantId]);
  const providerAccounts = (await client.query(PROVIDER_ACCOUNTS_SQL, [tenantId])).rows;
  const bankConnections = firstRow(
    await client.query(PROVIDER_BANK_STATUS_SQL, [tenantId]),
    'provider_bank_status',
  );
  const checkAltResult = await client.query(CHECKALT_STATE_SQL, [tenantId]);
  const checkAltState = firstRow(checkAltResult, 'checkalt_state');
  const providerErrors = firstRow(
    await client.query(PROVIDER_ERRORS_SQL, [tenantId]),
    'provider_errors',
  );
  const operations = firstRow(await client.query(OPERATIONS_SQL, [tenantId]), 'operations');
  const recentActivity = (await client.query(RECENT_ACTIVITY_SQL, [tenantId])).rows;
  const auditEntries = (await client.query(ADMIN_AUDIT_SQL, [tenantId])).rows;
  const paymentAccount = billingAccountResult.rows[0] || null;
  const history = paymentHistory(payments);

  const maxChecks = tenant.max_checks_per_month == null
    ? null
    : numberValue(tenant.max_checks_per_month, 'monthly_allowance');
  const checksReceived = numberValue(usage.checks_received, 'checks_received');
  const checkFeesCents = numberValue(fees.check_and_disbursement_fees_cents, 'check_fees_cents');
  const mortgageFeesCents = numberValue(mortgageUsage.billed_cents, 'mortgage_fees_cents');
  const nonUsdFeeEvents = numberValue(fees.non_usd_fee_events, 'non_usd_fee_events');
  const moovAccounts = providerAccounts.map((account) => {
    const restricted = account.restricted === true;
    const disabled = account.disabled === true;
    const hasCapability = [
      account.can_receive_payments,
      account.can_send_payments,
      account.can_ach_debit,
      account.can_ach_credit,
    ].some((capability) => capability === true);
    const readiness = restricted || disabled
      ? 'blocked'
      : account.verification_status === 'verified' && hasCapability
        ? 'ready'
        : 'not_ready';
    return {
      environment: safeLabel(account.environment, 'unknown'),
      onboardingStatus: safeLabel(account.onboarding_status, 'unknown'),
      verificationStatus: safeLabel(account.verification_status, 'unknown'),
      capabilities: {
        receivePayments: account.can_receive_payments === true,
        sendPayments: account.can_send_payments === true,
        achDebit: account.can_ach_debit === true,
        achCredit: account.can_ach_credit === true,
      },
      restricted,
      disabled,
      requirementsCount: numberValue(account.requirements_count, 'provider_requirements'),
      lastSyncedAt: account.last_synced_at,
      readiness,
    };
  });
  const checkAlt = checkAltState.enabled === null ? null : checkAltState;
  const checkAltPlatformEnabled = checkAltState.platform_enabled === true;
  const integrityResult = integritySummary(integrity);
  const fileCount = numberValue(operations.files_total, 'files_total');
  const unknownFileSizes = numberValue(operations.unknown_file_sizes, 'unknown_file_sizes');
  const allFileSizesKnown = unknownFileSizes === 0;

  return {
    ok: true,
    readOnly: true,
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.subscription_status,
      plan: tenant.plan_tier,
      environment,
      createdAt: tenant.created_at,
      userCount: numberValue(tenant.user_count, 'user_count'),
    },
    period,
    usage: {
      checksReceived,
      monthlyAllowance: maxChecks,
      remainingAllowance: maxChecks === null ? null : Math.max(0, maxChecks - checksReceived),
      perCheckBillingEnabled: tenant.per_check_billing_enabled === true,
      configuredPerCheckRateCents: tenant.per_check_rate_cents == null
        ? null
        : numberValue(tenant.per_check_rate_cents, 'per_check_rate'),
    },
    integrity: integrityResult,
    billing: {
      feeEvents: numberValue(fees.fee_events, 'fee_events'),
      checkAndDisbursementFeesCents: checkFeesCents,
      mortgageFeesCents,
      chargesCents: nonUsdFeeEvents === 0 ? checkFeesCents + mortgageFeesCents : null,
      nonUsdFeeEvents,
      failedFeeEvents: numberValue(fees.failed_fee_events, 'failed_fee_events')
        + numberValue(mortgageUsage.failed_billing_requests, 'failed_mortgage_billing'),
      recordedPaymentsCents: numberValue(paymentTotals.recorded_payments_cents, 'recorded_payments_cents'),
      collectedPaymentsCents: numberValue(paymentTotals.collected_payments_cents, 'collected_payments_cents'),
      outstandingCents: null,
      outstandingStatus: 'unavailable',
      autoDebit: paymentAccount ? {
        enabled: paymentAccount.auto_debit_enabled === true,
        verificationStatus: safeLabel(paymentAccount.verification_status, 'unknown'),
        authorizedAt: paymentAccount.ach_authorized_at,
      } : null,
      paymentHistory: history,
    },
    providers: {
      moov: moovAccounts,
      moovBankConnections: {
        total: numberValue(bankConnections.total, 'bank_connections'),
        connected: numberValue(bankConnections.connected, 'connected_bank_connections'),
        pending: numberValue(bankConnections.pending, 'pending_bank_connections'),
        disconnected: numberValue(bankConnections.disconnected, 'disconnected_bank_connections'),
      },
      checkAlt: checkAlt ? {
        enabled: checkAltPlatformEnabled && checkAlt.enabled === true,
        tenantEnabled: checkAlt.enabled === true,
        platformEnabled: checkAltPlatformEnabled,
        registeredAt: checkAlt.registered_at,
        readiness: !checkAltPlatformEnabled
          ? 'disabled'
          : checkAlt.enabled === true && Boolean(checkAlt.registered_at)
            ? 'configured'
            : 'not_ready',
      } : {
        enabled: false,
        tenantEnabled: false,
        platformEnabled: checkAltPlatformEnabled,
        registeredAt: null,
        readiness: checkAltPlatformEnabled ? 'not_configured' : 'disabled',
      },
      providerErrors: (() => {
        const moov = numberValue(providerErrors.moov_error_events, 'moov_provider_errors');
        const checkAlt = numberValue(providerErrors.checkalt_error_events, 'checkalt_provider_errors');
        return {
          status: moov + checkAlt > 0 ? 'errors_recorded' : 'none_recorded',
          moov,
          checkAlt,
          lastErrorAt: providerErrors.last_error_at,
        };
      })(),
    },
    operations: {
      checksTotal: numberValue(operations.checks_total, 'checks_total'),
      files: {
        count: fileCount,
        bytes: allFileSizesKnown
          ? numberValue(operations.known_file_bytes, 'file_bytes')
          : null,
        unknownSizeCount: unknownFileSizes,
      },
      ocr: {
        completed: numberValue(operations.ocr_completed, 'ocr_completed'),
        failed: numberValue(operations.ocr_failed, 'ocr_failed'),
        pending: numberValue(operations.ocr_pending, 'ocr_pending'),
      },
      signatures: {
        total: numberValue(operations.signature_requests_total, 'signature_requests'),
        open: numberValue(operations.signature_requests_open, 'open_signature_requests'),
      },
      mortgageOps: {
        total: numberValue(operations.mortgage_ops_total, 'mortgage_ops_total'),
        open: numberValue(operations.mortgage_ops_open, 'mortgage_ops_open'),
      },
      deposits: {
        total: numberValue(operations.deposits_total, 'deposits_total'),
        open: numberValue(operations.deposits_open, 'open_deposits'),
      },
      disbursements: {
        total: numberValue(operations.disbursements_total, 'disbursements_total'),
        open: numberValue(operations.disbursements_open, 'open_disbursements'),
      },
      recentActivity: recentActivity.map((row) => ({
        at: row.created_at,
        action: safeLabel(row.action),
        actorId: safeActorId(row.actor_id),
      })),
    },
    auditHistory: auditEntries.map((entry) => ({
      at: entry.created_at,
      actorId: safeActorId(entry.actor_id),
      action: safeAuditAction(entry.action),
      recordType: safeLabel(entry.record_type, 'record'),
      before: redactAuditValues(entry.old_values),
      after: redactAuditValues(entry.new_values),
    })),
  };
};

export const handleTenantManagementV2 = async (event, deps = {}) => {
  const tenantId = String(event?.queryStringParameters?.tenant_id || '').trim();
  if (!UUID_RE.test(tenantId)) {
    return { ok: false, statusCode: 400, error: 'valid_tenant_id_required' };
  }
  const normalizedTenantId = tenantId.toLowerCase();
  const period = resolvePeriod(event?.queryStringParameters || {}, deps.now || new Date());
  if (!period.ok) {
    return { ok: false, statusCode: 400, error: 'invalid_period' };
  }
  const runIdentity = deps.withIdentity || withIdentity;
  return runIdentity(
    event,
    ({ client }) => runTenantManagementV2({
      client,
      tenantId: normalizedTenantId,
      period: { start: period.start, end: period.end },
      environment: deps.environment || process.env.CHECKSOPS_ENV || 'unknown',
    }),
    { ...deps, write: false, commit: false },
  );
};
