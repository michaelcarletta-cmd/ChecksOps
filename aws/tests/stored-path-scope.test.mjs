/**
 * Stored file paths are storage read grants (storage.mjs authorizes any object
 * a visible row holds exactly). Writers must accept only paths inside the
 * row's own scope, never a free-text pointer at another tenant's key.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  executeCashJobAttachments,
  executeLossDraftDocuments,
  executeTenantDocuments,
} from '../functions/api/write-app-metadata.mjs';

const USER = 'b0000000-0000-4000-8000-000000000001';
const TENANT = 'a0000000-0000-4000-8000-000000000001';
const OTHER_TENANT = 'a0000000-0000-4000-8000-000000000002';
const JOB = 'c0000000-0000-4000-8000-000000000001';
const OTHER_JOB = 'c0000000-0000-4000-8000-000000000002';
const CLAIM = 'd0000000-0000-4000-8000-000000000001';
const DRAFT = 'e0000000-0000-4000-8000-000000000001';
const DOC = 'f0000000-0000-4000-8000-000000000001';
const VICTIM_CHECK = `checks/c1000000-0000-4000-8000-000000000009/front.jpg`;
const mapping = { application_user_id: USER };

function fakeClient({ role = 'admin', jobTenant = TENANT } = {}) {
  const writes = [];
  return {
    writes,
    async query(sql, params = []) {
      const text = String(sql);
      if (/FROM public\.tenant_users/.test(text)) {
        return { rows: params[1] === TENANT ? [{ role, '?column?': 1 }] : [] };
      }
      if (/FROM public\.cash_jobs/.test(text)) {
        return { rows: params[0] === JOB && params[1] === jobTenant ? [{ '?column?': 1 }] : [] };
      }
      if (/FROM public\.loss_draft_documents d/.test(text)) {
        return { rows: [{ id: DOC, loss_draft_id: DRAFT, claim_id: CLAIM, check_intake_item_id: null, tenant_id: TENANT }] };
      }
      if (/FROM public\.user_roles|FROM public\.mortgage_handling_requests/.test(text)) return { rows: [] };
      if (/^\s*(INSERT|UPDATE)/.test(text)) {
        writes.push({ text, params });
        return { rows: [{ id: 'row' }] };
      }
      throw new Error(`unexpected SQL ${text.slice(0, 70)}`);
    },
  };
}

test('cash-job attachments: only {tenant}/cash-jobs/{job}/ paths of the caller\'s own job', async () => {
  const insert = (client, values) => executeCashJobAttachments({
    client, mapping, op: 'insert', values: { tenant_id: TENANT, cash_job_id: JOB, file_name: 'f.jpg', ...values },
  });
  const ok = fakeClient();
  assert.equal((await insert(ok, { file_path: `${TENANT}/cash-jobs/${JOB}/1_front.jpg` })).error, undefined);
  assert.equal(ok.writes.length, 1);
  for (const file_path of [
    VICTIM_CHECK,
    `${OTHER_TENANT}/cash-jobs/${JOB}/1_front.jpg`,
    `${TENANT}/cash-jobs/${OTHER_JOB}/1_front.jpg`,
    `${TENANT}/cash-jobs/${JOB}/../../${VICTIM_CHECK}`,
    `${TENANT}/library/x.pdf`,
  ]) {
    const client = fakeClient();
    const result = await insert(client, { file_path });
    assert.ok(result.error, file_path);
    assert.equal(client.writes.length, 0, file_path);
  }
  // The job must belong to the caller's tenant.
  const foreignJob = fakeClient({ jobTenant: OTHER_TENANT });
  assert.equal((await insert(foreignJob, { file_path: `${TENANT}/cash-jobs/${JOB}/1.jpg` })).error, 'rls_denied');
  assert.equal(foreignJob.writes.length, 0);
});

test('library documents: only the caller\'s own {tenant}/library/ paths', async () => {
  const insert = (client, file_path) => executeTenantDocuments({
    client, mapping, op: 'insert',
    values: { tenant_id: TENANT, doc_type: 'library:mortgage:w-9', file_path, file_name: 'x.pdf' },
  });
  for (const file_path of [`${OTHER_TENANT}/library/other/x.pdf`, VICTIM_CHECK, `${TENANT}/x.pdf`]) {
    const client = fakeClient();
    const result = await insert(client, file_path);
    assert.equal(result.error, 'path_not_allowlisted', file_path);
    assert.equal(client.writes.length, 0, file_path);
  }
  const ok = fakeClient();
  const result = await insert(ok, `${TENANT}/library/mortgage/1-a.pdf`);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(ok.writes.length, 1);
});

test('loss-draft documents: only the draft\'s own upload folder or its claim\'s generated documents', async () => {
  const update = (client, file_path) => executeLossDraftDocuments({
    client, mapping, op: 'update', values: { file_path }, filters: [{ column: 'id', op: 'eq', value: DOC }],
  });
  for (const file_path of [
    `${CLAIM}/${DRAFT}/${DOC}/1-a.pdf`,
    `docs/${TENANT}/${CLAIM}/release-1.pdf`,
    `checks/${CLAIM}/checksops-templates/release.pdf`,
  ]) {
    const client = fakeClient();
    const result = await update(client, file_path);
    assert.equal(result.error, undefined, `${file_path}: ${JSON.stringify(result)}`);
    assert.equal(client.writes.length, 1, file_path);
  }
  for (const file_path of [
    VICTIM_CHECK,
    `${CLAIM}/e0000000-0000-4000-8000-000000000009/${DOC}/1-a.pdf`,
    `docs/${TENANT}/d0000000-0000-4000-8000-000000000009/release.pdf`,
    `${OTHER_TENANT}/library/x.pdf`,
  ]) {
    const client = fakeClient();
    const result = await update(client, file_path);
    assert.equal(result.error, 'path_not_allowlisted', file_path);
    assert.equal(client.writes.length, 0, file_path);
  }
  // Clearing the file stays allowed.
  const clear = fakeClient();
  assert.equal((await update(clear, null)).error, undefined);
});
