/**
 * Storage delete and move authorization (storage-write-auth.mjs BUCKET_WRITE_AUTH_SQL) and the check
 * write gate (aws_can_write_check) run against PostgreSQL 16 with the real AWS RLS helpers and SQL 90's
 * write helpers (owner-tenant members only). Audit finding 3: a partner tenant that reads a check
 * shared with it, and the platform owner that reads every tenant's, must not write its objects.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUCKET_WRITE_AUTH_SQL } from '../functions/api/storage-write-auth.mjs';
import { pathCandidates } from '../functions/api/storage-paths.mjs';
import { applyBaseSchema, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL90 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/90_users_only_tenant_roles.sql'), 'utf8');
// SQL 90's aws_is_tenant_member, aws_can_write_tenant, aws_can_write_check and aws_can_write_claim, as applied.
const SQL90_WRITE_HELPERS = SQL90.slice(
  SQL90.indexOf('CREATE OR REPLACE FUNCTION public.aws_is_tenant_member(_tenant_id uuid)'),
  SQL90.indexOf('CREATE OR REPLACE FUNCTION public.aws_tenant_has_no_members(_tenant_id uuid)'),
);

const OWNER_TENANT = '11111111-1111-4111-8111-111111111111';
const PARTNER_TENANT = '22222222-2222-4222-8222-222222222222';
const OWNER_MEMBER = 'a1000000-0000-4000-8000-000000000001';
const PARTNER_MEMBER = 'a1000000-0000-4000-8000-000000000002';
const PLATFORM_OWNER = 'a1000000-0000-4000-8000-00000000000b';
const CONTRACTOR = 'a1000000-0000-4000-8000-00000000000c';
const CHECK = '55555555-5555-4555-8555-555555555555';
const CLAIM = '66666666-6666-4666-8666-666666666666';
const DEPOSIT_ITEM = '77777777-7777-4777-8777-777777777777';
const LOSS_DRAFT = '88888888-8888-4888-8888-888888888888';

const SCHEMA = `
  ALTER TABLE public.check_intake_items
    ADD COLUMN front_image_path text, ADD COLUMN back_image_path text, ADD COLUMN back_image_original_path text,
    ADD COLUMN back_image_deposit_path text, ADD COLUMN endorsement_packet_path text;
  ALTER TABLE public.signature_requests ADD COLUMN document_path text, ADD COLUMN final_pdf_path text;
  CREATE TABLE public.check_files (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_intake_item_id uuid, file_path text);
  CREATE TABLE public.claim_files (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid, file_path text);
  CREATE TABLE public.homeowner_check_uploads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), file_path text, contractor_user_id uuid, converted_check_id uuid);
  CREATE TABLE public.cash_job_attachments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, file_path text);
  CREATE TABLE public.deposit_attachments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deposit_item_id uuid, file_path text);
  CREATE TABLE public.loss_draft_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), loss_draft_id uuid, file_path text);
  CREATE TABLE public.tenant_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, file_path text);
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO checksops;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO checksops;
  GRANT USAGE ON SCHEMA auth TO checksops;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO checksops;

  INSERT INTO public.tenants (id, name) VALUES ('${OWNER_TENANT}', 'Freedom'), ('${PARTNER_TENANT}', 'C1C');
  INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES
    ('${OWNER_MEMBER}', 'member@freedom.test', 'active'), ('${PARTNER_MEMBER}', 'member@c1c.test', 'active'),
    ('${PLATFORM_OWNER}', 'checksopsadmin@gmail.com', 'active'), ('${CONTRACTOR}', 'contractor@test', 'active');
  INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
    ('${OWNER_TENANT}', '${OWNER_MEMBER}', 'user'), ('${PARTNER_TENANT}', '${PARTNER_MEMBER}', 'user');
  INSERT INTO public.check_intake_items (id, tenant_id, claim_id, front_image_path, back_image_path, back_image_deposit_path, endorsement_packet_path)
    VALUES ('${CHECK}', '${OWNER_TENANT}', '${CLAIM}', 'checks/${CHECK}/front.jpg', 'checks/${CHECK}/back.jpg',
            'checks/${CHECK}/back_endorsed.jpg', 'checks/${CHECK}/packet.svg');
  INSERT INTO public.shared_checks (check_id, source_tenant_id, target_tenant_id) VALUES ('${CHECK}', '${OWNER_TENANT}', '${PARTNER_TENANT}');
  INSERT INTO public.claims (id, org_id) VALUES ('${CLAIM}', '${OWNER_TENANT}');
  INSERT INTO public.deposit_items (id, check_id) VALUES ('${DEPOSIT_ITEM}', '${CHECK}');
  INSERT INTO public.loss_draft_tracking (id, claim_id) VALUES ('${LOSS_DRAFT}', '${CLAIM}');
  INSERT INTO public.signature_requests (id, check_intake_item_id, document_path, final_pdf_path)
    VALUES (gen_random_uuid(), '${CHECK}', 'checks/${CHECK}/sig/doc.pdf', 'checks/${CHECK}/sig/final.pdf');
  INSERT INTO public.check_files (check_intake_item_id, file_path) VALUES ('${CHECK}', 'checks/${CHECK}/files/estimate.pdf');
  INSERT INTO public.claim_files (claim_id, file_path) VALUES ('${CLAIM}', 'claims/${CLAIM}/photo.jpg');
  INSERT INTO public.homeowner_check_uploads (file_path, contractor_user_id, converted_check_id) VALUES ('homeowner/${CHECK}/up.jpg', '${CONTRACTOR}', '${CHECK}');
  INSERT INTO public.cash_job_attachments (tenant_id, file_path) VALUES ('${OWNER_TENANT}', 'cash-jobs/job-1/a.pdf');
  INSERT INTO public.deposit_attachments (deposit_item_id, file_path) VALUES ('${DEPOSIT_ITEM}', '${DEPOSIT_ITEM}/slip.pdf');
  INSERT INTO public.loss_draft_documents (loss_draft_id, file_path) VALUES ('${LOSS_DRAFT}', '${CLAIM}/${LOSS_DRAFT}/doc-1/form.pdf');
  INSERT INTO public.tenant_documents (tenant_id, file_path) VALUES ('${OWNER_TENANT}', '${OWNER_TENANT}/library/mortgage/w9.pdf');
`;

// One object per write rule: [bucket, object path].
const OBJECTS = [
  ['claim-files', `checks/${CHECK}/files/estimate.pdf`],
  ['claim-files', `claims/${CLAIM}/photo.jpg`],
  ['claim-files', `checks/${CHECK}/front.jpg`],
  ['claim-files', `checks/${CHECK}/back_endorsed.deposit2.jpg`],
  ['claim-files', `checks/${CHECK}/front.checkalt.jpg`],
  ['claim-files', `checks/${CHECK}/sig/final.pdf`],
  ['claim-files', 'cash-jobs/job-1/a.pdf'],
  ['endorsement-packets', `checks/${CHECK}/packet.svg`],
  ['deposit-attachments', `${DEPOSIT_ITEM}/slip.pdf`],
  ['loss-draft-documents', `${CLAIM}/${LOSS_DRAFT}/doc-1/form.pdf`],
  ['tenant-documents', `${OWNER_TENANT}/library/mortgage/w9.pdf`],
];
const HOMEOWNER_OBJECT = ['claim-files', `homeowner/${CHECK}/up.jpg`];

test('PostgreSQL 16: only the owner tenant may write, delete or move a shared check\'s objects', { timeout: 120000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-storage-write-auth-', 63400);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  const api = new pg.Client({ host: server.host, port: server.port, user: 'checksops', database: 'postgres' });
  try {
    await applyBaseSchema(admin, { through: 76 });
    await admin.query(SQL90_WRITE_HELPERS);
    await admin.query(SCHEMA);
    await api.connect();
    const as = async (userId) => api.query("SELECT set_config('request.app_user_id', $1, false)", [userId]);
    const writable = async ([bucket, objectPath]) => {
      for (const sql of BUCKET_WRITE_AUTH_SQL[bucket]) {
        if ((await api.query(sql, [pathCandidates(bucket, objectPath), objectPath])).rows.length) return true;
      }
      return false;
    };
    const canWriteCheck = async () => (await api.query('SELECT public.aws_can_write_check($1::uuid) AS ok', [CHECK])).rows[0].ok;

    await as(OWNER_MEMBER);
    assert.equal(await canWriteCheck(), true);
    for (const object of [...OBJECTS, HOMEOWNER_OBJECT]) assert.equal(await writable(object), true, `owner member ${object.join(' ')}`);

    // The partner reads the shared check (shared_checks, active) and the platform owner reads every
    // tenant's; neither writes it.
    for (const [who, userId] of [['partner member', PARTNER_MEMBER], ['platform owner', PLATFORM_OWNER]]) {
      await as(userId);
      assert.equal(await canWriteCheck(), false, who);
      for (const object of OBJECTS) assert.equal(await writable(object), false, `${who} ${object.join(' ')}`);
    }
    // homeowner_check_uploads keeps its own write policy (24_complete_write_policies.sql): the
    // platform owner and the uploading contractor may remove an upload; a partner may not.
    await as(PARTNER_MEMBER);
    assert.equal(await writable(HOMEOWNER_OBJECT), false);
    await as(PLATFORM_OWNER);
    assert.equal(await writable(HOMEOWNER_OBJECT), true);
    await as(CONTRACTOR);
    assert.equal(await writable(HOMEOWNER_OBJECT), true);

    // A path that merely ends with a stored key does not match.
    await as(OWNER_MEMBER);
    assert.equal(await writable(['claim-files', `x/checks/${CHECK}/front.jpg`]), false);
  } finally {
    await api.end().catch(() => {});
    await admin.end().catch(() => {});
    server.stop();
  }
});
