#!/usr/bin/env node
/**
 * Builds the static `/status.json` platform notice for
 * `.github/workflows/spa-status-notice.yml`.
 *
 * It only validates inputs and writes one local JSON file. It never talks to AWS;
 * the workflow uploads exactly that one object.
 *
 * Inputs (environment variables, so workflow inputs are never shell-interpolated):
 *   STATUS_ENVIRONMENT            staging | production
 *   STATUS_ACTION                 post | clear
 *   STATUS_TITLE                  <= 120 characters (post)
 *   STATUS_MESSAGE                <= 2000 characters (post)
 *   STATUS_SEVERITY               info | maintenance | critical (post)
 *   STATUS_STARTS_AT              optional ISO 8601 timestamp with offset
 *   STATUS_ENDS_AT                optional ISO 8601 timestamp with offset, after starts_at
 *   STATUS_REFRESH_INSTRUCTIONS   optional, <= 500 characters
 *   STATUS_CONFIRMATION           production only: POST STATUS NOTICE TO PRODUCTION
 *   GITHUB_RUN_ID                 used for the notice id
 *
 * Usage: node scripts/status-notice.mjs --out <path>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_CONFIRMATION = 'POST STATUS NOTICE TO PRODUCTION';
export const LIMITS = Object.freeze({ title: 120, message: 2000, refresh_instructions: 500 });
export const SEVERITIES = Object.freeze(['info', 'maintenance', 'critical']);
const ENVIRONMENTS = new Set(['staging', 'production']);
const ACTIONS = new Set(['post', 'clear']);
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

const refuse = (error, field) => ({ ok: false, error, ...(field ? { field } : {}) });

const isIso = (v) => ISO_TS_RE.test(v) && Number.isFinite(Date.parse(v));

const textInput = (raw, key, required) => {
  const value = String(raw ?? '').trim();
  if (!value) return required ? { error: 'missing_required_field' } : { value: null };
  if (value.length > LIMITS[key]) return { error: 'field_too_long' };
  if (CONTROL_RE.test(value)) return { error: 'invalid_characters' };
  return { value };
};

/**
 * Validates raw inputs and returns { ok: true, document } or { ok: false, error, field }.
 * `clear` always yields { announcements: [] }.
 */
export function buildStatusDocument(input = {}, { now = new Date(), runId = '' } = {}) {
  const environment = String(input.environment ?? '').trim();
  const action = String(input.action ?? '').trim();
  if (!ENVIRONMENTS.has(environment)) return refuse('invalid_environment', 'environment');
  if (!ACTIONS.has(action)) return refuse('invalid_action', 'action');
  if (environment === 'production' && String(input.confirmation ?? '') !== PRODUCTION_CONFIRMATION) {
    return refuse('production_confirmation_required', 'confirmation');
  }
  if (action === 'clear') return { ok: true, environment, action, document: { announcements: [] } };

  const title = textInput(input.title, 'title', true);
  if (title.error) return refuse(title.error, 'title');
  const message = textInput(input.message, 'message', true);
  if (message.error) return refuse(message.error, 'message');
  const refresh = textInput(input.refresh_instructions, 'refresh_instructions', false);
  if (refresh.error) return refuse(refresh.error, 'refresh_instructions');
  const severity = String(input.severity ?? '').trim();
  if (!SEVERITIES.includes(severity)) return refuse('invalid_severity', 'severity');

  const times = {};
  for (const key of ['starts_at', 'ends_at']) {
    const raw = String(input[key] ?? '').trim();
    if (!raw) continue;
    if (!isIso(raw)) return refuse('invalid_timestamp', key);
    times[key] = new Date(raw).toISOString();
  }
  const startMs = times.starts_at ? Date.parse(times.starts_at) : now.getTime();
  if (times.ends_at && !(Date.parse(times.ends_at) > startMs)) {
    return refuse('ends_at_before_starts_at', 'ends_at');
  }

  const id = /^\d{1,20}$/.test(String(runId)) ? `status-${runId}` : `status-${now.getTime()}`;
  const notice = {
    id,
    title: title.value,
    message: message.value,
    severity,
    ...(times.starts_at ? { starts_at: times.starts_at } : {}),
    ...(times.ends_at ? { ends_at: times.ends_at } : {}),
    ...(refresh.value ? { refresh_instructions: refresh.value } : {}),
    updated_at: now.toISOString(),
  };
  return { ok: true, environment, action, document: { announcements: [notice] } };
}

export function inputFromEnv(env = process.env) {
  return {
    environment: env.STATUS_ENVIRONMENT,
    action: env.STATUS_ACTION,
    title: env.STATUS_TITLE,
    message: env.STATUS_MESSAGE,
    severity: env.STATUS_SEVERITY,
    starts_at: env.STATUS_STARTS_AT,
    ends_at: env.STATUS_ENDS_AT,
    refresh_instructions: env.STATUS_REFRESH_INSTRUCTIONS,
    confirmation: env.STATUS_CONFIRMATION,
  };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? argv[outIndex + 1] : '';
  if (!out || path.basename(out) !== 'status.json') {
    console.error(JSON.stringify({ ok: false, error: 'out_must_be_status_json' }));
    return 2;
  }
  const result = buildStatusDocument(inputFromEnv(env), { runId: env.GITHUB_RUN_ID || '' });
  if (!result.ok) {
    console.error(JSON.stringify(result));
    return 2;
  }
  fs.writeFileSync(out, `${JSON.stringify(result.document, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    environment: result.environment,
    action: result.action,
    notices: result.document.announcements.length,
  }));
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
