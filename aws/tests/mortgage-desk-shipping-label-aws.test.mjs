/**
 * Mortgage Desk shipping label on AWS (owner 2026-11-14: "Does the label upload, the tenant's Print label and the
 * agent's own open label actually work on AWS end to end?").
 *
 * Path of a label: the agent uploads checks/<check>/mortgage-ops/label-<stamp>-<name> (storage-write-auth.mjs
 * mortgage_desk grant, SQL 122), attaches it as a check file (mortgage_desk_attach_file, category
 * mortgage_ops_shipping_label) and records it on the request (mortgage_desk_update_shipping). The tenant prints it
 * through /storage/sign: storage.mjs authorizes it by that check_files row, which the tenant reads. The agent cannot
 * read the check's check_files row, so /storage/sign refuses it (403 storage_forbidden); the agent's "Open" goes
 * through the Desk API sign_url (SQL 124 e) instead, as every other Desk file read does. Fake clients only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ATTACH_FILE_SQL,
  MORTGAGE_DESK_FILE_CATEGORIES,
  MORTGAGE_DESK_REQUEST_SQL,
  MORTGAGE_DESK_UPLOAD_SQL,
  PLATFORM_OWNER_SQL,
  UPDATE_SHIPPING_SQL,
  executeMortgageDeskRpc,
  isMortgageDeskFilePath,
} from '../functions/api/mortgage-desk-return.mjs';
import { authorizeStorageWritePath } from '../functions/api/storage-write-auth.mjs';
import { BUCKET_AUTH_SQL, authorizeObject } from '../functions/api/storage.mjs';
import { USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { mortgageDeskFilePath } from '../../src/lib/mortgageDeskWrites.ts';
import { canWorkMortgageDeskRequest, signMortgageDeskFile } from '../../src/lib/mortgageDeskEsign.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const AGENT = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const TENANT_A = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const LABEL_PATH = mortgageDeskFilePath(CHECK_ID, 'UPS label (1).pdf', 'label-', 1763100000000);

/** The agent's RLS view: no check row, the request it is assigned to. */
const agentClient = ({ status = 'in_progress' } = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql === USER_ROLES_SQL) return { rows: [{ role: 'mortgage_agent' }] };
      if (sql === PLATFORM_OWNER_SQL) return { rows: [{ is_owner: false }] };
      if (sql === MORTGAGE_DESK_REQUEST_SQL) {
        return { rows: [{ id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status, assigned_employee_id: AGENT }] };
      }
      if (sql === MORTGAGE_DESK_UPLOAD_SQL) return { rows: status === 'in_progress' ? [{ '?column?': 1 }] : [] };
      if (sql === 'SELECT public.aws_can_write_check($1::uuid) AS ok') return { rows: [{ ok: false }] };
      if (sql === ATTACH_FILE_SQL) return { rows: [{ id: 'f1', check_intake_item_id: CHECK_ID, file_path: params[2], category: params[5] }] };
      if (sql === UPDATE_SHIPPING_SQL) return { rows: [{ id: REQUEST_ID, ...JSON.parse(params[1]) }] };
      // check_intake_items, check_files, ...: RLS hides the tenant's rows from the agent.
      return { rows: [] };
    },
  };
};

/** storage.mjs read rules under RLS: `visibleCheckFiles` are the check_files paths the caller can read. */
const readClient = (visibleCheckFiles) => ({
  query: async (sql, [candidates, rel] = []) => {
    if (sql === BUCKET_AUTH_SQL['claim-files'][0]) {
      return { rows: visibleCheckFiles.some((p) => p === rel || candidates.includes(p)) ? [{ '?column?': 1 }] : [] };
    }
    return { rows: [] };
  },
});

test('(a) the label path is a Desk path and the assigned agent may create it; not on a request that is not in progress', async () => {
  assert.match(LABEL_PATH, new RegExp(`^checks/${CHECK_ID}/mortgage-ops/label-1763100000000-UPS_label__1_\\.pdf$`));
  assert.equal(isMortgageDeskFilePath(LABEL_PATH, CHECK_ID), true);
  const ok = await authorizeStorageWritePath(agentClient(), 'claim-files', LABEL_PATH, AGENT);
  assert.equal(ok.ok, true);
  assert.equal(ok.strategy, 'mortgage_desk');
  assert.equal(ok.createOnly, true);
  const open = await authorizeStorageWritePath(agentClient({ status: 'open' }), 'claim-files', LABEL_PATH, AGENT);
  assert.equal(open.ok, false);
  assert.equal(open.statusCode, 403);
});

test('(b) the label is attached as a check file and recorded on the request', async () => {
  assert.ok(MORTGAGE_DESK_FILE_CATEGORIES.includes('mortgage_ops_shipping_label'));
  const client = agentClient();
  const mapping = { application_user_id: AGENT };
  const attached = await executeMortgageDeskRpc({
    client,
    mapping,
    name: 'mortgage_desk_attach_file',
    args: {
      _request_id: REQUEST_ID, _file_name: 'UPS label (1).pdf', _file_path: LABEL_PATH, _file_type: 'application/pdf',
      _file_size: 1024, _category: 'mortgage_ops_shipping_label', _description: 'Shipping label',
    },
  });
  assert.equal(attached.error, undefined);
  assert.equal(attached.data.file_path, LABEL_PATH);
  const updated = await executeMortgageDeskRpc({
    client,
    mapping,
    name: 'mortgage_desk_update_shipping',
    args: {
      _request_id: REQUEST_ID,
      _fields: {
        shipping_label_path: LABEL_PATH, shipping_label_name: 'UPS label (1).pdf', shipping_label_carrier: 'UPS',
        shipping_label_tracking: '1Z999', mail_to_name: null, mail_to_address: null,
      },
    },
  });
  assert.equal(updated.error, undefined);
  assert.equal(updated.data.shipping_label_path, LABEL_PATH);
});

test('(c) the tenant signs the label through /storage/sign by its check_files row; (d) the agent cannot', async () => {
  const tenant = await authorizeObject(readClient([LABEL_PATH]), 'claim-files', LABEL_PATH);
  assert.equal(tenant.authorized, true);
  const agent = await authorizeObject(readClient([]), 'claim-files', LABEL_PATH);
  assert.equal(agent.authorized, false);
  assert.equal(agent.reason, 'not_authorized');
});

test('(d) the agent opens the label through the Desk API sign_url with the request id', async () => {
  const calls = [];
  const client = {
    functions: {
      invoke: async (name, { body }) => {
        calls.push({ name, body });
        return { data: { ok: true, signedUrl: 'https://s3.example/label?sig=1' }, error: null };
      },
    },
  };
  const out = await signMortgageDeskFile(client, { requestId: REQUEST_ID, path: LABEL_PATH });
  assert.deepEqual(out, { signedUrl: 'https://s3.example/label?sig=1', error: null });
  assert.deepEqual(calls, [{ name: 'mortgage-desk-esign', body: { action: 'sign_url', request_id: REQUEST_ID, path: LABEL_PATH } }]);
});

test('the Desk request page wires the label upload and open to the AWS paths', () => {
  const page = read('src/pages/mortgage-ops/MortgageOpsRequestDetail.tsx');
  const start = page.indexOf('const uploadShippingLabel = async');
  const end = page.indexOf('const saveShippingCost = async');
  assert.ok(start > 0 && end > start);
  const block = page.slice(start, end);
  // The request's check id when the check row is not readable, as uploadDoc does.
  assert.match(block, /const checkId = check\?\.id \|\| req\?\.check_intake_item_id;/);
  assert.match(block, /mortgageDeskFilePath\(checkId, file\.name, "label-"\)/);
  assert.doesNotMatch(block, /check\.id/);
  // Refused before any upload when the server would refuse it (SQL 122: assigned agent, in progress).
  assert.match(block, /if \(mortgageUsesAwsBackend && !canWorkMortgageDeskRequest\(req, user\.id, false\)\)/);
  assert.match(block, /category: "mortgage_ops_shipping_label"/);
  // The agent's Open signs through the Desk API on AWS; the generic storage sign stays for the legacy backend only.
  const open = block.slice(block.indexOf('const openShippingLabel = async'));
  assert.match(open, /if \(mortgageUsesAwsBackend\) \{[\s\S]*?signMortgageDeskFile\(deskEsignClient, \{\s*requestId: req\.id,\s*path: req\.shipping_label_path,/);
  assert.ok(open.indexOf('signMortgageDeskFile(') < open.indexOf('.createSignedUrl('));
  assert.equal(canWorkMortgageDeskRequest({ status: 'in_progress', assigned_employee_id: AGENT }, AGENT, false), true);
  assert.equal(canWorkMortgageDeskRequest({ status: 'open', assigned_employee_id: null }, AGENT, false), false);
});

test('the tenant card prints the label through the tenant storage sign (unchanged)', () => {
  const card = read('src/components/loss-draft/MortgageDeskShippingCard.tsx');
  assert.match(card, /\.from\("claim-files"\)\s*\n\s*\.createSignedUrl\(req\.shipping_label_path, 3600\)/);
});
