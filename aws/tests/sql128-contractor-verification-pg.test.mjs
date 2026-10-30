/**
 * SQL 128 (aws/workflows/sql/128_contractor_verification_from_compliance.sql) on PostgreSQL 16, on
 * the release fixture with the supabase contractor tier functions restored
 * (helpers/sql128-contractor-verification-schema.mjs): which Compliance & Docs uploads count.
 *
 *   - before: contractor_verification_status fails (contractor_documents is gone) and so does a
 *     contractor review insert (recompute_tier_on_reviews);
 *   - after, the right uploads count: a legacy 'w9' or library W-9 of the contractor's own tenant;
 *     a stored or sent Moov W-9; a library certificate of insurance that has not expired; a sent
 *     Moov insurance upload;
 *   - and the wrong ones do not: another tenant's W-9 (the supabase OR matched any contractor's
 *     'w9%' row), a pending or rejected Moov upload, an expired library insurance, any upload for
 *     a contractor with no tenant;
 *   - a missing profile returns {found:false}; the result keys are the supabase ones; a review
 *     insert now recomputes the tier (guest -> verified with W-9, insurance and license);
 *   - EXECUTE: checksops can call it, authenticated cannot.
 * The executor path and the fingerprint are aws/tests/release-sql128-executor.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import {
  PROFILE_A,
  PROFILE_B,
  PROFILE_C,
  SQL128_FILE,
  TENANT_A,
  TENANT_B,
  contractorVerificationSchema,
} from './helpers/sql128-contractor-verification-schema.mjs';

const SQL128 = fs.readFileSync(SQL128_FILE, 'utf8');
const MISSING_PROFILE = 'c0000000-0000-4000-8000-0000000000ff';
const CHECK_KEYS = ['avg_rating', 'avg_rating_ok', 'coi_current', 'days_on_platform', 'days_on_platform_ok', 'admin_payment_attested',
  'license_on_file', 'no_open_disputes', 'review_count', 'review_count_ok', 'w9_on_file'].sort();
const TOP_KEYS = ['checks', 'current_tier', 'eligible_pro', 'eligible_verified', 'found', 'pro_approved_at', 'verified_at'].sort();

test('PostgreSQL 16: SQL 128 makes contractor verification read the Compliance & Docs uploads of the contractor\'s own tenants', { timeout: 600000 }, async (t) => {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const fx = await releaseFixture(pg, 'pg-sql128-', 59790, { extra: contractorVerificationSchema() });
  const { admin, connectAs } = fx;
  try {
    const status = async (profile) => (await admin.query('SELECT public.contractor_verification_status($1::uuid) AS s', [profile])).rows[0].s;
    const checks = async (profile) => {
      const { w9_on_file: w9, coi_current: coi } = (await status(profile)).checks;
      return { w9, coi };
    };
    const review = (profile) => admin.query(`INSERT INTO public.contractor_reviews (contractor_id, rating) VALUES ($1::uuid, 5)`, [profile]);

    // Before: the function and the review trigger both fail on the dropped table.
    await assert.rejects(status(PROFILE_A), /contractor_documents/);
    await assert.rejects(review(PROFILE_B), /contractor_documents/);

    const owner = await connectAs('checksops_admin');
    try {
      await owner.query(SQL128);
      await owner.query(SQL128); // idempotent
    } finally {
      await owner.end();
    }

    // A missing profile; the result keys as supabase returns them.
    assert.deepEqual(await status(MISSING_PROFILE), { found: false });
    const a = await status(PROFILE_A);
    assert.deepEqual(Object.keys(a).sort(), TOP_KEYS);
    assert.deepEqual(Object.keys(a.checks).sort(), CHECK_KEYS);
    assert.equal(a.found, true);

    // TENANT_A's legacy 'w9' (fixture seed) counts for MEMBER_A's profile, and for no one else:
    // not for TENANT_B's member, not for a contractor with no tenant.
    assert.deepEqual(await checks(PROFILE_A), { w9: true, coi: false });
    assert.deepEqual(await checks(PROFILE_B), { w9: false, coi: false });
    assert.deepEqual(await checks(PROFILE_C), { w9: false, coi: false });

    // Moov W-9 of TENANT_B: pending and rejected do not count; stored does.
    await admin.query(`INSERT INTO public.moov_compliance_documents (tenant_id, environment, purpose, status) VALUES ($1::uuid, 'production', 'w9', 'pending_upload'),
      ($1::uuid, 'production', 'w9', 'rejected')`, [TENANT_B]);
    assert.deepEqual(await checks(PROFILE_B), { w9: false, coi: false });
    await admin.query(`INSERT INTO public.moov_compliance_documents (tenant_id, environment, purpose, status) VALUES ($1::uuid, 'sandbox', 'w9', 'stored')`, [TENANT_B]);
    assert.deepEqual(await checks(PROFILE_B), { w9: true, coi: false });
    assert.deepEqual(await checks(PROFILE_C), { w9: false, coi: false });

    // Library insurance of TENANT_B: expired does not count; not expired does.
    await admin.query(`INSERT INTO public.tenant_documents (tenant_id, doc_type, file_path, file_name, expires_at)
      VALUES ($1::uuid, 'library:mortgage:certificate-of-insurance', 'b/coi-old.pdf', 'COI old.pdf', CURRENT_DATE - 1)`, [TENANT_B]);
    assert.deepEqual(await checks(PROFILE_B), { w9: true, coi: false });
    await admin.query(`INSERT INTO public.tenant_documents (tenant_id, doc_type, file_path, file_name, expires_at)
      VALUES ($1::uuid, 'library:mortgage:general-liability-insurance', 'b/gl.pdf', 'GL.pdf', CURRENT_DATE + 30)`, [TENANT_B]);
    assert.deepEqual(await checks(PROFILE_B), { w9: true, coi: true });
    // Another tenant's insurance still does not count for MEMBER_A.
    assert.deepEqual(await checks(PROFILE_A), { w9: true, coi: false });

    // A sent Moov insurance upload counts; a library W-9 counts.
    await admin.query(`INSERT INTO public.moov_compliance_documents (tenant_id, environment, purpose, status) VALUES ($1::uuid, 'production', 'insurance', 'sent')`, [TENANT_A]);
    assert.deepEqual(await checks(PROFILE_A), { w9: true, coi: true });
    await admin.query(`DELETE FROM public.tenant_documents WHERE tenant_id = $1::uuid AND doc_type = 'w9'`, [TENANT_A]);
    assert.deepEqual(await checks(PROFILE_A), { w9: false, coi: true });
    await admin.query(`INSERT INTO public.tenant_documents (tenant_id, doc_type, file_path, file_name) VALUES ($1::uuid, 'library:mortgage:w-9', 'a/w9.pdf', 'W-9.pdf')`, [TENANT_A]);
    assert.deepEqual(await checks(PROFILE_A), { w9: true, coi: true });

    // A review insert recomputes the tier: W-9, insurance and license -> verified.
    assert.equal((await admin.query('SELECT tier FROM public.contractor_profiles WHERE id = $1::uuid', [PROFILE_B])).rows[0].tier, 'guest');
    await review(PROFILE_B);
    const b = (await admin.query('SELECT tier, verified_at FROM public.contractor_profiles WHERE id = $1::uuid', [PROFILE_B])).rows[0];
    assert.equal(b.tier, 'verified');
    assert.ok(b.verified_at);
    // PROFILE_C has a license but no documents: a review keeps it guest.
    await review(PROFILE_C);
    assert.equal((await admin.query('SELECT tier FROM public.contractor_profiles WHERE id = $1::uuid', [PROFILE_C])).rows[0].tier, 'guest');
    assert.equal((await status(PROFILE_B)).eligible_verified, true);
    assert.equal((await status(PROFILE_B)).eligible_pro, false);

    // EXECUTE: the API login can call it; authenticated cannot.
    const api = await connectAs('checksops');
    try {
      const viaApi = (await api.query('SELECT public.contractor_verification_status($1::uuid) AS s', [PROFILE_B])).rows[0].s;
      assert.equal(viaApi.checks.w9_on_file, true);
    } finally {
      await api.end();
    }
    const privileges = (await admin.query(`SELECT has_function_privilege('checksops', 'public.contractor_verification_status(uuid)', 'EXECUTE') AS checksops,
      has_function_privilege('authenticated', 'public.contractor_verification_status(uuid)', 'EXECUTE') AS authenticated,
      to_regprocedure('public._trg_recompute_contractor_tier_from_docs()') IS NULL AS docs_dropped`)).rows[0];
    assert.deepEqual(privileges, { checksops: true, authenticated: false, docs_dropped: true });
  } finally {
    await fx.close();
  }
});
