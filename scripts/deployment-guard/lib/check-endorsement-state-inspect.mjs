/**
 * Read-only production inspect of one check whose endorsements are signed but which did not
 * advance to ready for deposit (inspect only; there is no apply). Owner report 2026-11-24: a
 * check received all endorsements, did not move to ready for deposit, and its deposit image
 * section shows no endorsed back image. The question is what finalizeEndorsementState
 * (aws/functions/api/check-endorsement.mjs) and compositeEndorsementSignatures
 * (aws/functions/api/endorsement-composite.mjs) hit for that check, without running them.
 *
 * One transaction: BEGIN READ ONLY, search_path pg_catalog, statement and lock timeouts, then
 * the fixed SELECTs in Q, then ROLLBACK. Nothing else is ever sent: the only input is the
 * check id (a uuid, bound as a parameter) and every statement text is a constant of this file
 * or of the Lambda module it mirrors (the CheckAlt eligibility SELECTs).
 *
 * The decisions are the Lambda's own pure helpers, imported, not re-implemented:
 * evaluateEndorsementCompletion, INELIGIBLE_AUTO_ADVANCE_STATUSES, decideReadyTransition,
 * isActiveLossDraft, isEndorsementSatisfied, hasUsableDrawnInk, isExceptionCompletion,
 * isCleanRasterOriginalPath, isEndorsedArtifactPath, isCheckAltArtifactPath,
 * isHistoricalCheckLocked, recoverTrustedOriginalBackPath, evaluateRearImageFreshness.
 *
 * Output (no id, name, email, amount, path, token or signature data):
 *   - check            status, check_stage, deposit_recommendation, render status labels;
 *                      deposited_at set; ineligible status; active loss draft; ready transition
 *   - images           per image column: exists, present, clean raster original, endorsed
 *                      artifact, CheckAlt artifact (booleans only, never the path)
 *   - endorsements     one entry per row in the composite's order: payee_type, status,
 *                      signature_method, presence of signature data, drawn ink, exception
 *   - completion       allSigned / anyRejected exactly as evaluateCompletionState computes them
 *   - deposits         CheckAlt deposit rows: count and the blocking row's status
 *   - recovery         recoverTrustedOriginalBackPath's { ok, error, source }; S3 existence
 *                      checks are not made (see S3_NOTE) and bounded instead
 *   - official_rear    whether the stored official rear could be reused (non-refresh path)
 *   - prediction       the first blocker in the order finalizeEndorsementState meets them
 *   - recent_events    the 20 latest check_audit_log rows: event_type and created_at only
 *
 * The signature columns never leave the database: the SELECT reduces each to 'data:image/',
 * '' , 'other' or NULL, which gives hasUsableDrawnInk the same answer as the full value.
 * Image paths and composite audit paths are read for the recovery decision and never printed.
 *
 * A failure (connecting included) reports the stage and the error's code / SQLSTATE only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok } from './errors.mjs';
import { safeErrorCode } from './mortgage-desk-access-inspect.mjs';
import { evaluateEndorsementCompletion } from '../../../aws/functions/api/check-endorsement.mjs';
import { INELIGIBLE_AUTO_ADVANCE_STATUSES } from '../../../aws/functions/api/endorsement-parity.mjs';
import {
  decideReadyTransition,
  isActiveLossDraft,
  isEndorsementSatisfied,
} from '../../../aws/functions/api/endorsement-completion.mjs';
import {
  hasUsableDrawnInk,
  isCleanRasterOriginalPath,
  isEndorsedArtifactPath,
  isExceptionCompletion,
  isHistoricalCheckLocked,
  recoverTrustedOriginalBackPath,
} from '../../../aws/functions/api/endorsement-composite.mjs';
import { isCheckAltArtifactPath } from '../../../aws/functions/api/providers/production/checkalt-image-compliance.mjs';
import { pickBlockingDeposit } from '../../../aws/functions/api/providers/production/checkalt-idempotency.mjs';
import {
  ENDORSEMENTS_ELIGIBILITY_SQL,
  PAYEES_ELIGIBILITY_SQL,
  evaluateRearImageFreshness,
} from '../../../aws/functions/api/providers/production/checkalt-eligibility.mjs';

export { safeErrorCode };

export const INSPECT_ID = 'check-endorsement-state-inspect';
export const CONFIG_REL = 'ops/deployment-guard/check-endorsement-state-inspect.json';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RECENT_EVENTS_LIMIT = 20;

/** The image columns reported (only those that exist), never their values. */
export const IMAGE_FIELDS = Object.freeze(['back_image_path', 'back_image_original_path', 'back_image_deposit_path', 'endorsed_back_image_path']);
/** The only check_intake_items columns that leave the database (to_jsonb picked by key). */
export const CHECK_KEYS = Object.freeze([
  'id', 'tenant_id', 'status', 'check_stage', 'deposited_at', 'deposit_recommendation',
  ...IMAGE_FIELDS, 'endorsement_render_meta', 'endorsement_render_status',
]);

/** Every blocker the prediction can name, in the order finalizeEndorsementState meets them. */
export const BLOCKERS = Object.freeze([
  'check_not_found',
  'ineligible_status',
  'any_rejected',
  'not_all_signed',
  'historical_deposit_locked',
  'original_back_missing',
  'original_back_ambiguous',
  'signature_image_missing',
  'loss_draft_hold',
]);
const RECOVERY_ERRORS = new Set(['original_back_missing', 'original_back_ambiguous']);
const RECOVERY_SOURCES = new Set(['back_image_original_path', 'endorsement_render_meta', 'check_audit_log', 'back_image_path', 'sibling']);

export const S3_NOTE = 'S3 existence checks skipped: the SQL53 runner reads the transfer bucket and the admin secret only (no access to the check image bucket, no FILES_BUCKET); the inspect makes no S3 call. Recovery is run twice, with every object absent and with every object present; when both agree the answer does not depend on S3.';
export const NOT_INSPECTED = Object.freeze({
  auto_advance_flag: 'AWS_ENDORSEMENT_AUTO_ADVANCE is a Lambda environment variable; this database inspect does not read it. applyAutoAdvanceIfEligible returns without advancing when it is not "true".',
  original_back_download_render_upload: 'The composite downloads the original back, renders and uploads the JPEG (S3); a failure there (original_back_unavailable, a render error) is not visible to a database read.',
});

// The signature value reduced to what hasUsableDrawnInk distinguishes; nothing else leaves the database.
const ink = (expr) => `CASE WHEN ${expr} IS NULL THEN NULL WHEN ${expr} = '' THEN '' WHEN pg_catalog.starts_with(${expr}, 'data:image/') THEN 'data:image/' ELSE 'other' END`;
const pick = (expr) => `pg_catalog.jsonb_build_object(${['original_back_image_path', 'original_back_path', 'endorsed_back_image_path', 'composited_back_path', 'composited_path']
  .map((k) => `'${k}', ${expr} ->> '${k}'`).join(', ')})`;

export const Q = Object.freeze({
  begin: 'BEGIN READ ONLY',
  searchPath: "SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)",
  statementTimeout: "SELECT pg_catalog.set_config('statement_timeout', '20000', true)",
  lockTimeout: "SELECT pg_catalog.set_config('lock_timeout', '2000', true)",
  session: `SELECT current_user::text AS current_user, session_user::text AS session_user,
  pg_catalog.current_setting('transaction_read_only') AS transaction_read_only,
  pg_catalog.current_setting('server_version_num')::int AS server_version_num`,
  columns: `SELECT c.relname::text AS table_name, a.attname::text AS column_name
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[]) AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY 1, a.attnum`,
  // $1 check id, $2 CHECK_KEYS: only those keys of the row, and only the columns that exist.
  check: `SELECT (SELECT pg_catalog.jsonb_object_agg(e.key, e.value) FROM pg_catalog.jsonb_each(pg_catalog.to_jsonb(c)) e
    WHERE e.key = ANY($2::text[])) AS check_row
  FROM public.check_intake_items c WHERE c.id = $1::uuid LIMIT 1`,
  // evaluateCompletionState's SELECT (check-endorsement.mjs), verbatim.
  completion: 'SELECT status, payee_type FROM public.check_endorsements WHERE check_id = $1::uuid',
  // compositeEndorsementSignatures' endorsement SELECT and order, without names or signature data.
  endorsements: `SELECT e.payee_type, e.status, e.signature_method,
  ${ink('e.signature_image_url')} AS signature_image_url, ${ink('p.endorsement_image_path')} AS endorsement_image_path
  FROM public.check_endorsements e
  LEFT JOIN public.check_payees p ON p.id = e.payee_id
  WHERE e.check_id = $1::uuid
  ORDER BY e.created_at ASC NULLS LAST, e.id ASC`,
  // loadDepositsForCheck's rows, reduced to what pickBlockingDeposit reads.
  deposits: `SELECT d.status, (d.checkalt_reference IS NOT NULL AND d.checkalt_reference <> '') AS has_reference,
  (d.provider_http_attempted_at IS NOT NULL) AS provider_http_attempted,
  (d.last_status_payload -> 'provider_http_attempted') AS payload_http_attempted,
  (d.idempotency_key IS NULL OR d.idempotency_key = '') AS legacy_row
  FROM public.checkalt_deposits d
  WHERE d.tenant_id = $1::uuid AND d.check_intake_item_id = $2::uuid
  ORDER BY d.created_at ASC NULLS LAST, d.id ASC`,
  // loadCompositeAudits' SELECT (endorsement-composite.mjs), reduced to the path keys recovery reads.
  compositeAudits: `SELECT ${pick('a.event_data')} AS event_data, a.created_at
  FROM public.check_audit_log a
  WHERE a.check_id = $1::uuid AND a.event_type = 'endorsement_signatures_composited'
  ORDER BY a.created_at DESC NULLS LAST
  LIMIT 25`,
  // reuseExistingOfficialRear's loaders (checkalt-eligibility.mjs), verbatim.
  eligibilityPayees: PAYEES_ELIGIBILITY_SQL,
  eligibilityEndorsements: ENDORSEMENTS_ELIGIBILITY_SQL,
  events: `SELECT a.event_type, a.created_at
  FROM public.check_audit_log a
  WHERE a.check_id = $1::uuid
  ORDER BY a.created_at DESC NULLS LAST
  LIMIT ${RECENT_EVENTS_LIMIT}`,
  rollback: 'ROLLBACK',
});

/** Every statement the inspect may send, for the tests' allowlist. */
export const INSPECT_STATEMENTS = Object.freeze(Object.values(Q));

const T = Object.freeze({
  check_intake_items: ['id'],
  check_endorsements: ['id', 'check_id', 'tenant_id', 'payee_id', 'payee_type', 'status', 'signed_at', 'signature_image_url', 'signature_method', 'created_at'],
  check_payees: ['id', 'check_id', 'tenant_id', 'payee_type', 'endorsement_status', 'endorsed_at', 'endorsement_image_path'],
  check_audit_log: ['check_id', 'event_type', 'event_data', 'created_at'],
  checkalt_deposits: ['id', 'tenant_id', 'check_intake_item_id', 'checkalt_reference', 'status', 'provider_http_attempted_at', 'last_status_payload', 'idempotency_key', 'created_at'],
});
export const INSPECT_TABLES = Object.freeze(Object.keys(T));
/** The columns each data statement reads. */
export const STATEMENT_REQUIRES = Object.freeze({
  check: { check_intake_items: ['id'] },
  completion: { check_endorsements: ['check_id', 'status', 'payee_type'] },
  endorsements: {
    check_endorsements: ['id', 'check_id', 'payee_id', 'payee_type', 'status', 'signature_image_url', 'signature_method', 'created_at'],
    check_payees: ['id', 'endorsement_image_path'],
  },
  deposits: { checkalt_deposits: T.checkalt_deposits },
  compositeAudits: { check_audit_log: ['check_id', 'event_type', 'event_data', 'created_at'] },
  eligibilityPayees: { check_payees: ['id', 'check_id', 'tenant_id', 'payee_type', 'endorsement_status', 'endorsed_at'] },
  eligibilityEndorsements: { check_endorsements: ['id', 'check_id', 'tenant_id', 'payee_id', 'payee_type', 'status', 'signed_at'] },
  events: { check_audit_log: ['check_id', 'event_type', 'created_at'] },
});

const LABEL_RE = /^[a-z][a-z0-9_]{0,40}$/;
const label = (v) => (v === '' || v == null ? '(none)' : LABEL_RE.test(String(v)) ? String(v) : 'other');
const present = (v) => typeof v === 'string' ? v.length > 0 : v != null;
const iso = (v) => {
  const d = v instanceof Date ? v : (v == null ? null : new Date(v));
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};
const parseMeta = (value) => {
  if (!value) return {};
  if (typeof value === 'string') { try { return JSON.parse(value) || {}; } catch { return {}; } }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
};
const recoveryView = (r) => ({
  ok: r?.ok === true,
  error: r?.ok ? null : (RECOVERY_ERRORS.has(r?.error) ? r.error : 'other'),
  source: r?.ok ? (RECOVERY_SOURCES.has(r?.source) ? r.source : 'other') : null,
});

/** The deposit rows pickBlockingDeposit / isHistoricalCheckLocked read, rebuilt from the reduced SELECT. */
export function depositRows(rows = []) {
  return rows.map((x) => ({
    status: x.status,
    checkalt_reference: x.has_reference === true ? 'present' : null,
    provider_http_attempted_at: x.provider_http_attempted === true ? 'present' : null,
    last_status_payload: { provider_http_attempted: x.payload_http_attempted ?? null },
    idempotency_key: x.legacy_row === true ? null : 'present',
  }));
}

/**
 * recoverTrustedOriginalBackPath without S3: once with every object absent, once with every
 * object present. Determined when no existence check was needed or both runs agree.
 */
export async function recoverWithoutS3(check, audits) {
  const runWith = async (exists) => {
    let checks = 0;
    const result = await recoverTrustedOriginalBackPath(check, {
      loadCompositeAudits: async () => audits || [],
      objectExists: async () => { checks += 1; return exists; },
    });
    return { result: recoveryView(result), checks };
  };
  const absent = await runWith(false);
  const every = await runWith(true);
  const needed = Math.max(absent.checks, every.checks);
  const same = JSON.stringify(absent.result) === JSON.stringify(every.result);
  if (needed === 0 || same) {
    return { ...absent.result, determined: true, s3: needed === 0 ? 'not_needed' : 'skipped', s3_checks_skipped: needed };
  }
  return {
    ok: null, error: null, source: null, determined: false, s3: 'skipped', s3_checks_skipped: needed,
    if_every_object_absent: absent.result, if_every_object_present: every.result,
  };
}

/**
 * Pure: the blockers in the order finalizeEndorsementState (refreshOfficialRear, the signing
 * path) meets them. predicted_blocker is the first, or 'none'.
 */
export function predictBlockers({ check, completion, endorsements = [], locked, recovery }) {
  const blockers = [];
  const undetermined = [];
  if (!check) return { predicted_blocker: 'check_not_found', blockers: ['check_not_found'], undetermined };
  if (INELIGIBLE_AUTO_ADVANCE_STATUSES.has(String(check.status || '')) || Boolean(check.deposited_at)) blockers.push('ineligible_status');
  if (!completion) undetermined.push('completion');
  else {
    if (completion.anyRejected) blockers.push('any_rejected');
    if (!completion.allSigned) blockers.push('not_all_signed');
  }
  if (locked === true) blockers.push('historical_deposit_locked');
  else if (locked == null) undetermined.push('historical_deposit_lock');
  if (!recovery || recovery.determined !== true) undetermined.push('original_back_recovery');
  else if (!recovery.ok) blockers.push(RECOVERY_ERRORS.has(recovery.error) ? recovery.error : 'original_back_missing');
  if (endorsements.some((row) => row.blocks_composite)) blockers.push('signature_image_missing');
  // applyAutoAdvanceIfEligible holds on decideReadyTransition's hold_loss_draft or on
  // isActiveLossDraft; listed whenever the check is in an active loss draft, even when an
  // earlier blocker means the advance is not reached yet.
  const decision = decideReadyTransition(check, {
    allRequiredSatisfied: completion?.allSigned === true,
    anyRejected: completion?.anyRejected === true,
  });
  if (decision.action === 'hold_loss_draft' || isActiveLossDraft(check)) blockers.push('loss_draft_hold');
  // Ordered as finalizeEndorsementState meets them (BLOCKERS order).
  blockers.sort((a, b) => BLOCKERS.indexOf(a) - BLOCKERS.indexOf(b));
  // A database-side check that could not be decided: the prediction is 'undetermined', not
  // 'none', with the outcomes it could have.
  const possible = recovery && recovery.determined === false
    ? [...new Set([recovery.if_every_object_absent, recovery.if_every_object_present].filter((x) => x && !x.ok).map((x) => x.error))]
    : [];
  const open = undetermined.length > 0;
  undetermined.push(...Object.keys(NOT_INSPECTED));
  return {
    predicted_blocker: blockers[0] || (open ? 'undetermined' : 'none'),
    blockers,
    ...(possible.length ? { possible_blockers: possible } : {}),
    undetermined,
  };
}

/** One endorsement row (reduced) as reported: labels and booleans only. */
export function endorsementEntry(row, index) {
  const status = String(row.status || '').toLowerCase();
  const drawn = hasUsableDrawnInk(row);
  const exception = isExceptionCompletion(row);
  return {
    index,
    payee_type: label(row.payee_type),
    status: label(row.status),
    signature_method: label(row.signature_method),
    signature_image_url_present: present(row.signature_image_url),
    endorsement_image_path_present: present(row.endorsement_image_path),
    has_usable_drawn_ink: drawn,
    is_exception_completion: exception,
    satisfied: isEndorsementSatisfied(row),
    // compositeEndorsementSignatures' missingDrawn: signed, not an exception, no drawn ink.
    blocks_composite: status === 'signed' && !exception && !drawn,
  };
}

function imageReport(check, have) {
  return Object.fromEntries(IMAGE_FIELDS.map((field) => {
    const exists = have.has(`check_intake_items.${field}`);
    const value = check?.[field];
    return [field, {
      column_exists: exists,
      present: exists && present(value),
      clean_raster_original: exists && present(value) && isCleanRasterOriginalPath(value),
      endorsed_artifact: exists && present(value) && isEndorsedArtifactPath(value),
      checkalt_artifact: exists && present(value) && isCheckAltArtifactPath(value),
    }];
  }));
}

const section = (r, key, value) => (r[key] === undefined ? { read: false, reason: r.skipped?.[key] || 'not_read' } : { read: true, ...value() });

/** Pure (apart from the S3-free recovery result passed in): builds the report from the rows. */
export function buildReport(r) {
  const session = r.session?.[0] || {};
  const have = new Set((r.columns || []).map((c) => `${c.table_name}.${c.column_name}`));
  const check = r.check === undefined ? undefined : (r.check?.[0]?.check_row || null);
  const head = {
    inspect: INSPECT_ID,
    read_only: true,
    transaction_read_only: session.transaction_read_only === 'on',
    current_user: session.current_user,
    session_user: session.session_user,
    server_major_version: Math.floor(Number(session.server_version_num || 0) / 10000),
    question: 'why did this check, with its endorsements signed, not advance to ready for deposit with an endorsed back image?',
    check_found: check === undefined ? null : Boolean(check),
  };
  if (!check) {
    return {
      ...head,
      ...(check === undefined ? { check: { read: false, reason: r.skipped?.check || 'not_read' } } : {}),
      prediction: check === null
        ? predictBlockers({ check: null })
        : { predicted_blocker: 'none', blockers: [], undetermined: ['check'] },
    };
  }
  const completion = r.completion === undefined ? null : evaluateEndorsementCompletion(r.completion);
  const endorsements = r.endorsements === undefined ? null : r.endorsements.map(endorsementEntry);
  const deposits = r.deposits === undefined ? (check.tenant_id ? null : []) : depositRows(r.deposits);
  const locked = deposits == null ? (isHistoricalCheckLocked(check, []) ? true : null) : isHistoricalCheckLocked(check, deposits);
  const blocking = deposits ? pickBlockingDeposit(deposits) : null;
  const meta = parseMeta(check.endorsement_render_meta);
  const ineligibleStatus = INELIGIBLE_AUTO_ADVANCE_STATUSES.has(String(check.status || ''));
  const decision = decideReadyTransition(check, {
    allRequiredSatisfied: completion?.allSigned === true,
    anyRejected: completion?.anyRejected === true,
  });
  return {
    ...head,
    check: {
      status: label(check.status),
      check_stage: have.has('check_intake_items.check_stage') ? label(check.check_stage) : 'column_missing',
      deposit_recommendation: have.has('check_intake_items.deposit_recommendation') ? label(check.deposit_recommendation) : 'column_missing',
      deposited_at_set: Boolean(check.deposited_at),
      status_in_ineligible_auto_advance_statuses: ineligibleStatus,
      ineligible_for_auto_advance: ineligibleStatus || Boolean(check.deposited_at),
      active_loss_draft: isActiveLossDraft(check),
      ready_transition: label(decision.action),
      endorsement_render_status: have.has('check_intake_items.endorsement_render_status') ? label(check.endorsement_render_status) : 'column_missing',
      endorsement_render_meta: {
        present: Object.keys(meta).length > 0,
        has_original_back_path: Boolean(meta.original_back_image_path || meta.original_back_path),
        has_endorsed_back_path: Boolean(meta.endorsed_back_image_path),
        has_rear_fingerprint: Boolean(meta.checkalt_rear_fingerprint),
        invalidated: Boolean(meta.invalidated_at),
      },
    },
    images: imageReport(check, have),
    endorsements: section(r, 'endorsements', () => ({ count: endorsements.length, rows: endorsements })),
    completion: section(r, 'completion', () => ({ rows: r.completion.length, allSigned: completion.allSigned, anyRejected: completion.anyRejected })),
    deposits: deposits == null
      ? { read: false, reason: r.skipped?.deposits || 'not_read' }
      : {
        read: r.deposits !== undefined,
        ...(r.deposits === undefined ? { reason: 'no_tenant_id' } : {}),
        count: deposits.length,
        blocking: blocking ? { status: label(blocking.status), has_reference: Boolean(blocking.checkalt_reference) } : null,
      },
    historical_deposit_locked: locked,
    recovery: r.recovery || { read: false, reason: r.skipped?.compositeAudits || 'not_read' },
    official_rear: r.officialRear || { read: false, reason: 'not_read' },
    prediction: predictBlockers({ check, completion, endorsements: endorsements || [], locked, recovery: r.recovery }),
    s3_note: S3_NOTE,
    not_inspected: NOT_INSPECTED,
    recent_events: section(r, 'events', () => ({
      limit: RECENT_EVENTS_LIMIT,
      rows: r.events.map((x) => ({ event_type: label(x.event_type), created_at: iso(x.created_at) })),
    })),
  };
}

export function loadInspectConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, CONFIG_REL), 'utf8'));
}

/** reuseExistingOfficialRear's decision without S3 (the object's existence is not checked). */
function officialRearView(check, payees, endorsements) {
  const deposit = check?.back_image_deposit_path;
  if (!deposit || !isCheckAltArtifactPath(deposit)) return { read: true, reusable: false, error: 'official_rear_missing', reason: 'deposit_path_not_checkalt_artifact' };
  if (!check?.id || !check?.tenant_id) return { read: true, reusable: false, error: 'official_rear_missing', reason: 'no_tenant_id' };
  if (!payees || !endorsements) return { read: false, reason: 'columns_missing' };
  const freshness = evaluateRearImageFreshness(check, payees, endorsements);
  if (!freshness.ok) return { read: true, reusable: false, error: label(freshness.error), reason: label(freshness.reason) };
  return { read: true, reusable: null, fingerprint: 'fresh', object_exists: 'skipped' };
}

/**
 * Runs the inspect on a connected client: BEGIN READ ONLY ... ROLLBACK of the fixed statements
 * in Q only. A data statement runs only when every column it reads exists, and only when the
 * check is found. Returns the structured result; never throws.
 */
export async function inspectCheckEndorsementState({ connect, checkId }) {
  if (typeof checkId !== 'string' || !UUID_RE.test(checkId)) {
    return fail(CODES.INVALID_MANIFEST, 'check endorsement state inspect needs a uuid check id');
  }
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
    const r = { skipped: {} };
    r.session = await rows(Q.session);
    if (r.session?.[0]?.transaction_read_only !== 'on') {
      return fail(CODES.UNRELATED_MUTATION, 'check endorsement state inspect refused: the transaction is not read-only');
    }
    r.columns = await rows(Q.columns, [[...INSPECT_TABLES]]);
    const have = new Set(r.columns.map((c) => `${c.table_name}.${c.column_name}`));
    const missing = (key) => Object.entries(STATEMENT_REQUIRES[key]).flatMap(([t, cols]) => cols.filter((c) => !have.has(`${t}.${c}`)).map((c) => `${t}.${c}`));
    const read = async (key, params) => {
      const gone = missing(key);
      if (gone.length) { r.skipped[key] = `columns_missing:${gone.join(',')}`; return undefined; }
      r[key] = await rows(Q[key], params);
      return r[key];
    };
    await read('check', [checkId, [...CHECK_KEYS]]);
    const check = r.check?.[0]?.check_row || null;
    if (!check) return ok(buildReport(r));

    await read('completion', [checkId]);
    await read('endorsements', [checkId]);
    if (check.tenant_id) await read('deposits', [check.tenant_id, checkId]);
    const audits = await read('compositeAudits', [checkId]);
    if (audits !== undefined) r.recovery = await recoverWithoutS3(check, audits);
    if (check.back_image_deposit_path && isCheckAltArtifactPath(check.back_image_deposit_path) && check.tenant_id) {
      const payees = await read('eligibilityPayees', [checkId, check.tenant_id]);
      const endorsements = await read('eligibilityEndorsements', [checkId, check.tenant_id]);
      r.officialRear = officialRearView(check, payees, endorsements);
    } else {
      r.officialRear = officialRearView(check, null, null);
    }
    await read('events', [checkId]);
    return ok(buildReport(r));
  } catch (error) {
    return fail(CODES.UNRELATED_MUTATION, 'check endorsement state inspect failed', {
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
