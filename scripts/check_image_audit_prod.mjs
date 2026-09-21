#!/usr/bin/env node
/**
 * Read-only production audit for check image integrity.
 *
 * Requires:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY (read-only role strongly recommended)
 *
 * This script NEVER writes to production and NEVER outputs signed URLs.
 */
import { createClient } from '@supabase/supabase-js';

const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
};

const SUPABASE_URL = required('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = required('SUPABASE_SERVICE_ROLE_KEY');
const BUCKET = process.env.CHECKSOPS_CLAIM_FILES_BUCKET || 'claim-files';

const isGenerated = (p) =>
  !!p && (
    /_endorsed(?:_\d+)?\.[^.]+$/i.test(p) ||
    /endorsed_deposit_[^/]+\.[^.]+$/i.test(p) ||
    /\.svg(\?|$)/i.test(p) ||
    /\.checkalt\.jpg(\?|$)/i.test(p)
  );

const normalizePath = (p) => {
  if (!p) return null;
  const raw = String(p).trim();
  if (!raw) return null;
  // strip query strings from legacy URLs stored in columns
  return raw.split('?')[0];
};

const classify = (row) => {
  const back = normalizePath(row.back_image_path);
  const backOriginal = normalizePath(row.back_image_original_path);
  const backDeposit = normalizePath(row.back_image_deposit_path);
  const issues = [];

  if (!back && !backOriginal) {
    issues.push('missing_back_paths');
  }
  if (!backOriginal && back && !isGenerated(back)) {
    issues.push('missing_back_image_original_path');
  }
  if (backOriginal && isGenerated(backOriginal)) {
    issues.push('generated_artifact_as_original');
  }
  if (backOriginal && back && backOriginal !== back && !isGenerated(back)) {
    issues.push('reupload_current_original_mismatch');
  }
  if (backDeposit && !isGenerated(backDeposit)) {
    issues.push('deposit_path_not_generated');
  }
  return issues;
};

const main = async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  let offset = 0;
  const page = 1000;
  const totals = {
    audited: 0,
    healthy: 0,
    missing_back_image_original_path: 0,
    generated_artifact_as_original: 0,
    reupload_current_original_mismatch: 0,
    missing_back_paths: 0,
    deposit_path_not_generated: 0,
  };
  const findings = [];

  for (;;) {
    const { data, error } = await supabase
      .from('check_intake_items')
      .select('id, tenant_id, check_number, claim_id, front_image_path, back_image_path, back_image_original_path, back_image_deposit_path, updated_at')
      .order('id', { ascending: true })
      .range(offset, offset + page - 1);
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) break;
    for (const row of rows) {
      totals.audited += 1;
      const issues = classify(row);
      if (!issues.length) totals.healthy += 1;
      for (const issue of issues) {
        if (issue in totals) totals[issue] += 1;
      }
      if (issues.length) {
        findings.push({
          id: row.id,
          tenant_id: row.tenant_id,
          check_number: row.check_number,
          claim_id: row.claim_id,
          issues,
          paths: {
            front_image_path: normalizePath(row.front_image_path),
            back_image_path: normalizePath(row.back_image_path),
            back_image_original_path: normalizePath(row.back_image_original_path),
            back_image_deposit_path: normalizePath(row.back_image_deposit_path),
          },
        });
      }
    }
    offset += rows.length;
  }

  console.log(JSON.stringify({
    ok: true,
    bucket: BUCKET,
    totals,
    findings_count: findings.length,
    findings: findings.slice(0, 500),
    truncated: findings.length > 500,
    notes: 'This report is DB-only. Add storage existence checks once storage credentials are provided.',
  }, null, 2));
};

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});

