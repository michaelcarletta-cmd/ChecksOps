/**
 * Authorization for the staging-only VPC SQL executor.
 *
 * This is not a weakening of sql-apply. evaluateSqlApply still requires
 * expected AND live definition hashes. The executor path is a separate
 * deployment_type so a VPC receipt cannot skip that collision check.
 *
 * Immediately-before live hashing happens inside the VPC executor via
 * evaluateSqlCollision. This module only binds the authorization package.
 */
import { CODES, errorEntry, fail, failMany, ok } from './errors.mjs';
import { validateWorkstreamIdentity } from './identity.mjs';

export const SQL_EXECUTOR_DEPLOYMENT_TYPE = 'sql-executor-invoke';
export const SQL_EXECUTOR_COMPONENT = 'staging-sql';
export const SQL_EXECUTOR_FUNCTION = 'checksops-staging-guarded-sql-executor';
export const FORBIDDEN_EXECUTOR_FUNCTIONS = Object.freeze([
  'checksops-staging-api',
  'checksops-staging-sql44-2d41',
  'checksops-production-prep-api',
  'checksops-production-origin-verify',
]);

export const AUTHORIZED_SQL44 = Object.freeze({
  filename: 'aws/write-path/sql/44_claim_ledger_link_or_create.sql',
  migration_id: '44_claim_ledger_link_or_create',
  commit: '0d965fb5a6ec190cc0b5e8edf29352a917382b30',
  source_sha256: '059f10e936f27439b9fddae7030b76fe594d6538087de389ab07950fefdf8763',
  intended_replacement_sha256: '059f10e936f27439b9fddae7030b76fe594d6538087de389ab07950fefdf8763',
  function_identity: 'public.claim_ledger_link_or_create(uuid,uuid,text,text)',
  sql43_function_identity: 'public.review_save_detected_claim_number(uuid,uuid,text)',
  expected_sql43_definition_sha256: '31a3d2fb20033987a3bdde93f102573c36acc99ae3969e84ad4dc50c916f4806',
});

export const AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS = Object.freeze({
  filename: 'supabase/migrations/20261001231500_tenant_users_same_check_permissions.sql',
  migration_id: '20261001231500_tenant_users_same_check_permissions',
  commit: '6b222b63c955e8c47569ef3704541303680c649e',
  source_sha256: '573ec6a0178d04a041e053aeb724560950b504d162b6f113563bec5108a0e518',
  intended_replacement_sha256: '573ec6a0178d04a041e053aeb724560950b504d162b6f113563bec5108a0e518',
  function_identities: Object.freeze([
    'public.user_can_move_tenant_checks(uuid,uuid)',
    'public.admin_override_check_status(uuid,text,uuid)',
  ]),
});

export const AUTHORIZED_SQL53 = Object.freeze({
  filename: 'aws/workflows/sql/53_claim_settlement_breakdown.sql',
  migration_id: '53_claim_settlement_breakdown',
  commit: '8de7888606b00e7d9a5f0776f2f9c4afe7c14fd1',
  source_sha256: '5a8f8bc35c69f2b339c78f3637d6bb1c606117967e3ab9d83b5dec1d37561197',
  intended_replacement_sha256: '6542c3f6fb3f7d50b758b3d7352fe6fb49cbe8cd2bd5c6061dbc35a6e9fccf52',
  function_identity: 'public.save_claim_settlement_breakdown(uuid,uuid,jsonb)',
  absent_live_definition_sha256: '0000000000000000000000000000000000000000000000000000000000000000',
  preserved_function_identities: Object.freeze([
    'public.sync_homeowner_ledger_from_check()',
    'public.aws_can_write_claim(uuid)',
    'public.hle_on_check_intake_insert()',
  ]),
});

// Replace-only: the live July definition (9f6ec2dc…) is the only accepted
// starting point. See ops/deployment-guard/ledger-20261007193200-staging-authorization.json.
export const AUTHORIZED_LEDGER_20261007193200 = Object.freeze({
  filename: 'supabase/migrations/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql',
  migration_id: '20261007193200_skip_claim_ledger_event_for_endorsement_stage',
  commit: 'b303311836fd597583929a792123c8f8f302fc89',
  source_sha256: '1a9e6d54c67d2068ba9497f10fcf6956c1699b3005e679b72c3cc3bf2e37878b',
  intended_replacement_sha256: '03fcea3c87b8ed087222b4071cbe36542df00dfca5c21ea44d20dc113a1047a2',
  expected_live_definition_sha256: '9f6ec2dc9a5bcb7b7651d5b556788eb73ba5b567d457196fe82544f98aca8699',
  function_identity: 'public.sync_homeowner_ledger_from_check()',
  preserved_function_definition_sha256: Object.freeze({
    'public.hle_on_check_intake_insert()': 'bdd9ec4b45b79ef3b3b21c5f18c2785d901edc606695fbc84f0daedecff5ff48',
    'public.aws_can_write_claim(uuid)': '0a7e62b26bf4dd07ce9c06a104773d472ccff6b5a0207d338de4ba594eb32caf',
  }),
  trigger_table: 'public.check_intake_items',
  required_ledger_triggers: Object.freeze({
    trg_hle_check_intake_insert: 'hle_on_check_intake_insert',
    trg_sync_homeowner_ledger_ins: 'sync_homeowner_ledger_from_check',
    trg_sync_homeowner_ledger_upd: 'sync_homeowner_ledger_from_check',
  }),
});

// Column privilege grant. The "definition" is the canonical privilege state
// string, hashed: AMOUNT_GRANT_STATE_TEXT.absent before, .granted after.
export const AMOUNT_GRANT_STATE_TEXT = Object.freeze({
  absent: 'checksops UPDATE (amount) ON public.check_intake_items: absent',
  granted: 'checksops UPDATE (amount) ON public.check_intake_items: granted',
});
export const AUTHORIZED_SQL71_AMOUNT_GRANT = Object.freeze({
  filename: 'aws/workflows/sql/71_review_amount_column_grant.sql',
  migration_id: '71_review_amount_column_grant',
  commit: 'a04461398e3250d49399ab1e3fc5cfa0e911cbb7',
  source_sha256: 'ada473038b3771232b9c9a290629362ad67ab31e0985bbc2d260aeafcda78966',
  expected_live_definition_sha256: '2d96f50bae23aac3c9893656a4e68eccb1f1c298d5c1085753dd1472e1a3df2a',
  intended_replacement_sha256: 'ff8e86f95a78474068f6b083087ac6fdad7af321aff9a6536ca38faadf5d35a9',
  grantee: 'checksops',
  table: 'public.check_intake_items',
  column: 'amount',
});

// SQL 72 adds five tenant-member payment write policies. The "definition" is
// the canonical presence state of exactly those policies, hashed: all absent
// before, all present (well-formed) after. Every other policy on the three
// tables must be byte-identical before and after.
export const MEMBER_PAYMENT_POLICIES = Object.freeze([
  Object.freeze({ table: 'payment_event_log', name: 'aws_member_insert_payment_event_log', cmd: 'INSERT' }),
  Object.freeze({ table: 'payment_transfers', name: 'aws_member_insert_payment_transfers', cmd: 'INSERT' }),
  Object.freeze({ table: 'payment_transfers', name: 'aws_member_update_payment_transfers', cmd: 'UPDATE' }),
  Object.freeze({ table: 'payment_wallets', name: 'aws_member_insert_payment_wallets', cmd: 'INSERT' }),
  Object.freeze({ table: 'payment_wallets', name: 'aws_member_update_payment_wallets', cmd: 'UPDATE' }),
]);
export const MEMBER_PAYMENT_REQUIRED_FUNCTIONS = Object.freeze([
  'aws_financial_execution_active',
  'aws_is_authenticated',
  'aws_user_tenant_ids',
]);
/** `states`: one state for all five policies, or one per MEMBER_PAYMENT_POLICIES row. */
export function memberPaymentPolicyStateText(states = 'absent') {
  return MEMBER_PAYMENT_POLICIES
    .map((row, index) => `public.${row.table}.${row.name} ${row.cmd} TO authenticated: ${Array.isArray(states) ? states[index] : states}`)
    .join('\n');
}
export const AUTHORIZED_SQL72_MEMBER_PAYMENT_WRITES = Object.freeze({
  filename: 'aws/workflows/sql/72_member_payment_writes.sql',
  migration_id: '72_member_payment_writes',
  commit: '2ed4d26daff49341191e8abe6eacdceabec6701f',
  source_sha256: '5ed4d507f2b85c16d9a9cd8fccad6649325823f08b6ea5a79c2554712ee6fe7b',
  expected_live_definition_sha256: 'febc45bed8d64bb2001708bc83bba41b943063bec19c1165a2ca58daffdcfd26',
  intended_replacement_sha256: '57233f0f1fa7f204741f979779d91f92085204d9e1a31129d126f255cd26485b',
  tables: Object.freeze(['public.payment_event_log', 'public.payment_transfers', 'public.payment_wallets']),
});

// SQL 76 guards tenant_partnerships activation: a BEFORE INSERT OR UPDATE
// trigger (only the invitee side, or a statement inside
// aws_connect_partner_by_code, can make a row live) and the retirement of five
// Supabase-era write/admin policies. The "definition" is the canonical state
// text of exactly those objects, hashed. Each object is classified against the
// embedded file (guard function and trigger: absent | pinned | different;
// each retired policy: present | absent). The marker line records that
// aws_connect_partner_by_code carries no SET checksops.partnership_writer
// (missing_function | unset | pinned | different); SQL 76 no longer sets one
// (Postgres 15+ refuses it to a non-superuser), so it stays unset before and
// after. Every other policy and trigger on tenant_partnerships, and the rest of
// aws_connect_partner_by_code, must be byte-identical before and after.
export const PARTNERSHIP_CONSENT_GUARD_FUNCTION = 'public.aws_tenant_partnership_consent_guard()';
export const PARTNERSHIP_CONSENT_TRIGGER = 'aws_tenant_partnership_consent_guard';
export const PARTNERSHIP_CONNECT_FUNCTION = 'public.aws_connect_partner_by_code(text, uuid)';
export const PARTNERSHIP_WRITER_SETTING = 'checksops.partnership_writer';
export const PARTNERSHIP_WRITER_VALUE = 'aws_connect_partner_by_code';
export const PARTNERSHIP_RETIRED_POLICIES = Object.freeze([
  'Inviter can create partnerships',
  'Partners can update partnerships',
  'Admins can create any partnership',
  'Admins can view any partnership',
  'Admins can update any partnership',
]);
export const PARTNERSHIP_CONSENT_REQUIRED_FUNCTIONS = Object.freeze([
  'aws_can_write_tenant',
  'aws_user_tenant_ids',
]);
/**
 * `state.policies`: one state for all five retired policies, or one per
 * PARTNERSHIP_RETIRED_POLICIES row.
 */
// sha256 of aws_connect_partner_by_code's body (prosrc) in aws/rls/sql/32_partner_share_lifecycle.sql.
// SQL 76 makes that function the trusted writer, so its live body must be exactly
// the reviewed one (a test re-derives this from the file).
export const PARTNERSHIP_CONNECT_BODY_SHA256 = '1d8e36deefc46bf447b57f13d510a8a9184f61783c8e181fef4150384c327a08';
export const PARTNERSHIP_CONNECT_CONFIG = Object.freeze(['search_path=public', 'row_security=off']);
/**
 * `connect`: aws_connect_partner_by_code itself (SECURITY DEFINER, the SQL 32 body
 * and config apart from the marker): pinned | different | missing_function.
 * `otherTriggers`: none | present (any other trigger on tenant_partnerships could
 * run after the guard and change the row).
 */
export function partnershipConsentStateText({
  guard = 'absent',
  trigger = 'absent',
  marker = 'unset',
  policies = 'present',
  connect = 'pinned',
  otherTriggers = 'none',
} = {}) {
  return [
    `${PARTNERSHIP_CONSENT_GUARD_FUNCTION} RETURNS trigger: ${guard}`,
    `public.tenant_partnerships trigger ${PARTNERSHIP_CONSENT_TRIGGER} BEFORE INSERT OR UPDATE FOR EACH ROW: ${trigger}`,
    `public.tenant_partnerships other triggers: ${otherTriggers}`,
    `${PARTNERSHIP_CONNECT_FUNCTION} body and config: ${connect}`,
    `${PARTNERSHIP_CONNECT_FUNCTION} SET ${PARTNERSHIP_WRITER_SETTING}: ${marker}`,
    ...PARTNERSHIP_RETIRED_POLICIES.map((name, index) => (
      `public.tenant_partnerships policy "${name}": ${Array.isArray(policies) ? policies[index] : policies}`
    )),
  ].join('\n');
}
export const PARTNERSHIP_CONSENT_APPLIED_STATE = Object.freeze({
  guard: 'pinned',
  trigger: 'pinned',
  marker: 'unset',
  policies: 'absent',
  connect: 'pinned',
  otherTriggers: 'none',
});
// A later guarded production apply tool (SQL 72's used the phrase
// CREATE_MEMBER_PAYMENT_WRITE_POLICIES) would use GUARD_PARTNERSHIP_ACTIVATION.
export const SQL76_PROPOSED_AUTHORIZATION_PHRASE = 'GUARD_PARTNERSHIP_ACTIVATION';
export const AUTHORIZED_SQL76_PARTNERSHIP_CONSENT = Object.freeze({
  filename: 'aws/workflows/sql/76_tenant_partnership_invitee_consent.sql',
  migration_id: '76_tenant_partnership_invitee_consent',
  // The commit that authored the current file bytes. Re-pin if the branch is
  // rebased or squashed before it reaches main.
  commit: 'efbd03b2d3d8187c1dbd15344f786ec81f05ae89',
  source_sha256: '47ef66fa3b66b07ad1c3fe6a3accc7dc1696efeb85a2d3ca3b3bb9a001f7f3c7',
  // Reviewed live value: guarded staging SQL executor read-live run 38541967571
  // (2026-10-14) reported LIVE_DEFINITION_SHA256 7c5276d8…: guard and trigger
  // absent, marker unset, connect function pinned, no other triggers, and the
  // five retired policies already absent. Equals
  // sha256(partnershipConsentStateText({ policies: 'absent' })). The first apply
  // (run 38548817869) failed on the marker statement and rolled back, so this
  // is still the pre-apply state; the next read-live re-confirms it.
  expected_live_definition_sha256: '7c5276d8d04973c51f28238ec32091d77b01613c79dc8961d4dbc4bfd92d20d8',
  // Code-derived: sha256(partnershipConsentStateText(PARTNERSHIP_CONSENT_APPLIED_STATE)).
  intended_replacement_sha256: '2f195230b952217546297d932445cb8954b81441ed30222e711b50688a09df3e',
  table: 'public.tenant_partnerships',
});

// SQL 77 grants SELECT, INSERT, DELETE on public.check_stakeholders to checksops
// and authenticated. The "definition" is the canonical state text of exactly
// those grantees' direct SELECT/INSERT/UPDATE/DELETE table privileges (from the
// table ACL), hashed. Every other ACL entry must be identical before and after.
export const STAKEHOLDER_GRANT_TABLE = 'public.check_stakeholders';
export const STAKEHOLDER_GRANTEES = Object.freeze(['checksops', 'authenticated']);
export const STAKEHOLDER_GRANT_PRIVILEGES = Object.freeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
/** `state[grantee][privilege]` is 'granted' | 'absent' (missing reads as absent). */
export function stakeholderGrantStateText(state = {}) {
  return STAKEHOLDER_GRANTEES.flatMap((grantee) => STAKEHOLDER_GRANT_PRIVILEGES.map((privilege) => (
    `${grantee} ${privilege} ON ${STAKEHOLDER_GRANT_TABLE}: ${state?.[grantee]?.[privilege] === 'granted' ? 'granted' : 'absent'}`
  ))).join('\n');
}
export const STAKEHOLDER_GRANT_APPLIED_STATE = Object.freeze(Object.fromEntries(STAKEHOLDER_GRANTEES.map((grantee) => [
  grantee,
  Object.freeze({ SELECT: 'granted', INSERT: 'granted', UPDATE: 'absent', DELETE: 'granted' }),
])));
export const AUTHORIZED_SQL77_CHECK_STAKEHOLDERS_GRANT = Object.freeze({
  filename: 'aws/workflows/sql/77_check_stakeholders_write_grant.sql',
  migration_id: '77_check_stakeholders_write_grant',
  // The commit that authored the current file bytes. Re-pin if the branch is
  // rebased or squashed before it reaches main.
  commit: 'b70fadfb1e50baa0c5a32a0b17ecda8edd3981ed',
  source_sha256: 'ed7f1c809b8c66c63e60c4d3504b3cbcbf8088ad1336f418b72a26f528029ec1',
  // Staging read-live (run 38569427366, 2026-10-14): checksops SELECT only,
  // authenticated nothing, no UPDATE anywhere.
  expected_live_definition_sha256: '714659325ea58a54fdc2ad39b35224308f8f9df92629c3c53b8e3c6fe3faa4e7',
  // Code-derived: sha256(stakeholderGrantStateText(STAKEHOLDER_GRANT_APPLIED_STATE)).
  intended_replacement_sha256: 'e4d49fface305abc732bb225824e4f113e4a0a6ef4f5f2a145bdf3b0324043d1',
  table: STAKEHOLDER_GRANT_TABLE,
});

// SQL 78 creates public.check_partner_stakeholder_removals. The "definition" is
// the canonical state text of that table (columns, constraints, indexes, RLS,
// policies, non-owner ACL, whether the executor role owns it), hashed; while the table is
// absent it is the fixed absent text below. The owner's own ACL entries and the
// owner's name are left out so the text does not depend on the role name or on
// the server version's owner privilege set (PostgreSQL 17+ adds MAINTAIN), and
// PostgreSQL 18 NOT NULL constraint rows are covered by the column lines.
export const PARTNER_STAKEHOLDER_REMOVALS_TABLE = 'public.check_partner_stakeholder_removals';
export const PARTNER_STAKEHOLDER_REMOVALS_ABSENT_TEXT = `table ${PARTNER_STAKEHOLDER_REMOVALS_TABLE}: absent`;
/**
 * `state` is { present, columns: [{name,type,not_null,default}], constraints:
 * [{name,def}], indexes: [{name,def}], rls_enabled, rls_forced, policies: [{name,permissive,cmd,roles,
 * using,with_check}], acl: [{grantee,privilege,grantable}], owner_is_executor }.
 */
export function partnerStakeholderRemovalsStateText(state = {}) {
  if (state?.present !== true) return PARTNER_STAKEHOLDER_REMOVALS_ABSENT_TEXT;
  const lines = [`table ${PARTNER_STAKEHOLDER_REMOVALS_TABLE}: present`];
  for (const column of state.columns || []) {
    lines.push(`column ${column.name} ${column.type}${column.not_null ? ' not null' : ''}${column.default == null ? '' : ` default ${column.default}`}`);
  }
  for (const constraint of [...(state.constraints || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    lines.push(`constraint ${constraint.name}: ${constraint.def}`);
  }
  for (const index of [...(state.indexes || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    lines.push(`index ${index.name}: ${index.def}`);
  }
  lines.push(`row level security: ${state.rls_enabled === true ? 'enabled' : 'disabled'}`);
  lines.push(`force row level security: ${state.rls_forced === true ? 'on' : 'off'}`);
  for (const policy of [...(state.policies || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    lines.push(`policy ${policy.name} ${policy.permissive === false ? 'restrictive' : 'permissive'} ${policy.cmd} to ${[...(policy.roles || [])].sort().join(',')} using ${policy.using ?? '-'} with check ${policy.with_check ?? '-'}`);
  }
  for (const entry of [...(state.acl || [])].map((row) => `grant ${row.grantee} ${row.privilege}${row.grantable === true ? ' with grant option' : ''}`).sort()) {
    lines.push(entry);
  }
  lines.push(`owner: ${state.owner_is_executor === true ? 'executor role' : 'another role'}`);
  return lines.join('\n');
}
export const AUTHORIZED_SQL78_PARTNER_STAKEHOLDER_REMOVALS = Object.freeze({
  filename: 'aws/workflows/sql/78_check_partner_stakeholder_removals.sql',
  migration_id: '78_check_partner_stakeholder_removals',
  // The commit that authored the current file bytes. Re-pin if the branch is
  // rebased or squashed before it reaches main.
  commit: '0d08a894c635c8790347e2e6e14b5383a0e3bef1',
  source_sha256: 'd4a33174a546e0623f22397db93eb4c622214f6ff2336e65c110449162797420',
  // Code-derived: the table does not exist before SQL 78, so the pre-apply
  // state is sha256(PARTNER_STAKEHOLDER_REMOVALS_ABSENT_TEXT). A staging
  // read-live run should confirm it before apply.
  expected_live_definition_sha256: '4031dea6c0fbb70af1b17befa7ffb161fec40227cda080cd87c222dec674d269',
  // The state read back after applying the file on PostgreSQL 16 as a
  // non-superuser owner whose default privileges are as expected (aws/tests/sql78-check-partner-stakeholder-removals-executor.test.mjs).
  intended_replacement_sha256: '3d650a56a2fd8a4ccfaeaf795ac0de8c4d0b849a748c1769400397d62e92dd40',
  table: PARTNER_STAKEHOLDER_REMOVALS_TABLE,
});

// SQL 79 adds tenant-member INSERT and DELETE policies to public.check_stakeholders
// and public.check_partner_stakeholder_removals. The "definition" is the
// canonical state text of both tables' row-level security (enabled, forced,
// whether the executor role owns the table, every policy as pg_get_expr prints
// it with only pg_catalog on the search_path) plus the sha256 of
// pg_get_functiondef for the two functions the new policies call, hashed. The
// function hashes pin aws_user_tenant_ids() to the reviewed body (tenant_users
// rows of auth.uid() only, no partner or shared tenants).
export const MEMBER_STAKEHOLDER_TABLES = Object.freeze([STAKEHOLDER_GRANT_TABLE, PARTNER_STAKEHOLDER_REMOVALS_TABLE]);
export const MEMBER_STAKEHOLDER_FUNCTIONS = Object.freeze(['public.aws_user_tenant_ids()', 'public.aws_is_authenticated()']);
// sha256(pg_get_functiondef) on PostgreSQL 16 of the definitions in
// aws/rls/sql/02_helpers.sql and aws/rls/sql/20_write_helpers.sql.
export const MEMBER_STAKEHOLDER_FUNCTION_SHA256 = Object.freeze({
  'public.aws_user_tenant_ids()': 'd18f604e0b82c2a71625a0f49311f3d1cfebd5d25830bb4d790333a8b598a42f',
  'public.aws_is_authenticated()': '5bfd3730b011857480c77910bf44e8736418c7537df24338a7e66d682dc43800',
});
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
/**
 * `state` is { tables: { [table]: { present, rls_enabled, rls_forced,
 * owner_is_executor, policies: [{name,permissive,cmd,roles,using,with_check}] } },
 * functions: { [signature]: sha256 | null } }.
 */
export function memberStakeholderWritesStateText(state = {}) {
  const lines = [];
  for (const table of MEMBER_STAKEHOLDER_TABLES) {
    const row = state?.tables?.[table];
    if (row?.present !== true) {
      lines.push(`table ${table}: absent`);
      continue;
    }
    lines.push(`table ${table}: present`);
    lines.push(`${table} row level security: ${row.rls_enabled === true ? 'enabled' : 'disabled'}`);
    lines.push(`${table} force row level security: ${row.rls_forced === true ? 'on' : 'off'}`);
    lines.push(`${table} owner: ${row.owner_is_executor === true ? 'executor role' : 'another role'}`);
    for (const policy of [...(row.policies || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      lines.push(`${table} policy ${policy.name} ${policy.permissive === false ? 'restrictive' : 'permissive'} ${policy.cmd} to ${[...(policy.roles || [])].sort().join(',')} using ${policy.using ?? '-'} with check ${policy.with_check ?? '-'}`);
    }
  }
  for (const signature of MEMBER_STAKEHOLDER_FUNCTIONS) {
    const hash = state?.functions?.[signature];
    lines.push(`function ${signature}: ${SHA256_HEX_RE.test(String(hash || '')) ? `definition sha256 ${hash}` : 'absent'}`);
  }
  return lines.join('\n');
}
const reviewedPolicy = (name, cmd, using, withCheck) => Object.freeze({
  name, permissive: true, cmd, roles: Object.freeze(['authenticated']), using, with_check: withCheck,
});
// As PostgreSQL 16 prints them (aws/rls/sql/12_final_select_policies.sql,
// 24_complete_write_policies.sql, aws/workflows/sql/78 and 79).
const STAKEHOLDER_SELECT_EXPR = '(public.aws_is_cross_tenant_reader() OR public.aws_can_access_tenant(tenant_id))';
const STAKEHOLDER_WRITE_EXPR = 'public.aws_can_write_tenant(tenant_id)';
export const MEMBER_STAKEHOLDER_MEMBER_EXPR = '(public.aws_is_authenticated() AND (tenant_id IN ( SELECT public.aws_user_tenant_ids() AS aws_user_tenant_ids)))';
// check_stakeholders inserts also need a manual link on a check the row's tenant owns.
export const MEMBER_STAKEHOLDER_LINK_INSERT_EXPR = "(public.aws_is_authenticated() AND (tenant_id IN ( SELECT public.aws_user_tenant_ids() AS aws_user_tenant_ids)) AND (EXISTS ( SELECT 1\n   FROM public.check_intake_items c\n  WHERE ((c.id = check_stakeholders.check_intake_item_id) AND (c.tenant_id = check_stakeholders.tenant_id)))) AND (added_via = 'manual'::text))";
const MEMBER_STAKEHOLDER_SHORT = Object.freeze({
  [STAKEHOLDER_GRANT_TABLE]: 'check_stakeholders',
  [PARTNER_STAKEHOLDER_REMOVALS_TABLE]: 'check_partner_stakeholder_removals',
});
/** The two policies each table has before SQL 79. */
export const MEMBER_STAKEHOLDER_REVIEWED_POLICIES = Object.freeze(Object.fromEntries(MEMBER_STAKEHOLDER_TABLES.map((table) => [table, Object.freeze([
  reviewedPolicy(`aws_select_${MEMBER_STAKEHOLDER_SHORT[table]}`, 'SELECT', STAKEHOLDER_SELECT_EXPR, null),
  reviewedPolicy(`aws_write_${MEMBER_STAKEHOLDER_SHORT[table]}`, 'ALL', STAKEHOLDER_WRITE_EXPR, STAKEHOLDER_WRITE_EXPR),
])])));
/** The four policies SQL 79 adds, by table. */
export const MEMBER_STAKEHOLDER_NEW_POLICIES = Object.freeze(Object.fromEntries(MEMBER_STAKEHOLDER_TABLES.map((table) => [table, Object.freeze([
  reviewedPolicy(`aws_member_insert_${MEMBER_STAKEHOLDER_SHORT[table]}`, 'INSERT', null,
    table === STAKEHOLDER_GRANT_TABLE ? MEMBER_STAKEHOLDER_LINK_INSERT_EXPR : MEMBER_STAKEHOLDER_MEMBER_EXPR),
  reviewedPolicy(`aws_member_delete_${MEMBER_STAKEHOLDER_SHORT[table]}`, 'DELETE', MEMBER_STAKEHOLDER_MEMBER_EXPR, null),
])])));
const memberStakeholderState = (withNew) => ({
  tables: Object.fromEntries(MEMBER_STAKEHOLDER_TABLES.map((table) => [table, {
    present: true,
    rls_enabled: true,
    rls_forced: false,
    owner_is_executor: true,
    policies: [...MEMBER_STAKEHOLDER_REVIEWED_POLICIES[table], ...(withNew ? MEMBER_STAKEHOLDER_NEW_POLICIES[table] : [])],
  }])),
  functions: { ...MEMBER_STAKEHOLDER_FUNCTION_SHA256 },
});
export const MEMBER_STAKEHOLDER_PRE_STATE = Object.freeze(memberStakeholderState(false));
export const MEMBER_STAKEHOLDER_APPLIED_STATE = Object.freeze(memberStakeholderState(true));
export const AUTHORIZED_SQL79_MEMBER_STAKEHOLDER_WRITES = Object.freeze({
  filename: 'aws/workflows/sql/79_member_stakeholder_writes.sql',
  migration_id: '79_member_stakeholder_writes',
  // The commit that authored the current file bytes. Re-pin if the branch is
  // rebased or squashed before it reaches main.
  commit: '41a3231a211fda0d0bde8a8346e0496e0d7d43c6',
  source_sha256: '87556017ffbb97625af328c55cc468f1938566ad5760eac883375c187c1d1231',
  // Code-derived: sha256(memberStakeholderWritesStateText(MEMBER_STAKEHOLDER_PRE_STATE)),
  // the state SQL 12/24/77/78 leave. A staging read-live run should confirm it before apply.
  expected_live_definition_sha256: 'd9bc8921d75864abe9af5bf404f237fb561bc2c1cad21339e7f60decd0a6f0a4',
  // Code-derived: sha256(memberStakeholderWritesStateText(MEMBER_STAKEHOLDER_APPLIED_STATE)),
  // re-derived from the real catalog by aws/tests/sql79-member-stakeholder-writes-executor.test.mjs.
  intended_replacement_sha256: '878d6441902edf8050b01daf25b2d43a01bdfde62d17490550c4d7217a5baba7',
  table: STAKEHOLDER_GRANT_TABLE,
  tables: MEMBER_STAKEHOLDER_TABLES,
});

// SQL 80 CREATE OR REPLACEs the SQL 38 SECURITY DEFINER function
// public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) so tenant
// owner/admin/manager/operator (not viewer) can save auto_approve_enabled and
// auto_approve_max_cents, and replaces its comment. Its REVOKE/GRANT lines
// restate SQL 38's EXECUTE grants, so the function ACL must not change. The
// "definition" is the canonical state text of the function: present, how many
// functions carry its name (any schema; no overloads), the sha256 of
// pg_get_functiondef, SECURITY DEFINER, proconfig, whether the executor role
// owns it, the sha256 of its comment and every non-owner ACL entry.
export const CHECKALT_AUTO_DEPOSIT_FUNCTION = 'public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb)';
export const CHECKALT_AUTO_DEPOSIT_FUNCTION_NAME = 'aws_save_checkalt_tenant_auto_deposit';
export const CHECKALT_AUTO_DEPOSIT_TABLE = 'public.checkalt_tenant_accounts';
export const CHECKALT_AUTO_DEPOSIT_SQL38_FILE = 'aws/rls/sql/38_checkalt_auto_deposit_persist.sql';
export const CHECKALT_AUTO_DEPOSIT_CONFIG = Object.freeze(['search_path=public', 'row_security=off']);
export const CHECKALT_AUTO_DEPOSIT_GRANTEES = Object.freeze(['authenticated', 'checksops']);
// sha256(pg_get_functiondef) and sha256(obj_description) on PostgreSQL 16 of
// the SQL 38 and SQL 80 files, re-derived by
// aws/tests/sql80-checkalt-member-auto-deposit-executor.test.mjs.
export const CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256 = Object.freeze({
  sql38: 'b7989db70a0376b9ef7957fd8c6e6a47d8ac64155715eb662a300f91b5636e37',
  sql80: '97c5bddc1ada170530fc7da9fe2cd4e3998a037571dd71d0dbe1a89bf03ab9c5',
});
export const CHECKALT_AUTO_DEPOSIT_COMMENT_SHA256 = Object.freeze({
  sql38: 'fc9384c2a1152af8424d2b5f57dab894bcf74ef2466587779374fbb6ce83d47c',
  sql80: '05ad30345f0fb94b446bb6238e01c99fbecdcd3d53cf60fcfa36ba3fe45d9520',
});
/**
 * `state` is { exists, overload_count, definition_sha256, security_definer,
 * config: text[], owner_is_executor, comment_sha256, acl: [{grantee,
 * privilege_type, is_grantable}] } (acl without the owner's own entries).
 */
export function checkaltAutoDepositStateText(state = {}) {
  const fn = CHECKALT_AUTO_DEPOSIT_FUNCTION;
  if (state?.exists !== true) {
    return [`function ${fn}: absent`, `functions named ${CHECKALT_AUTO_DEPOSIT_FUNCTION_NAME}: ${Number(state?.overload_count) || 0}`].join('\n');
  }
  const lines = [
    `function ${fn}: present`,
    `functions named ${CHECKALT_AUTO_DEPOSIT_FUNCTION_NAME}: ${Number(state.overload_count) || 0}`,
    `${fn} definition sha256 ${SHA256_HEX_RE.test(String(state.definition_sha256 || '')) ? state.definition_sha256 : 'unreadable'}`,
    `${fn} security definer: ${state.security_definer === true ? 'on' : 'off'}`,
    `${fn} config: ${(state.config || []).join(',') || '-'}`,
    `${fn} owner: ${state.owner_is_executor === true ? 'executor role' : 'another role'}`,
    `${fn} comment sha256 ${SHA256_HEX_RE.test(String(state.comment_sha256 || '')) ? state.comment_sha256 : 'none'}`,
  ];
  const acl = (state.acl || []).map((entry) => `${fn} acl ${entry.grantee} ${entry.privilege_type}${entry.is_grantable === true ? ' with grant option' : ''}`);
  return [...lines, ...acl.sort()].join('\n');
}
const checkaltAutoDepositState = (version) => ({
  exists: true,
  overload_count: 1,
  definition_sha256: CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256[version],
  security_definer: true,
  config: [...CHECKALT_AUTO_DEPOSIT_CONFIG],
  owner_is_executor: true,
  comment_sha256: CHECKALT_AUTO_DEPOSIT_COMMENT_SHA256[version],
  acl: CHECKALT_AUTO_DEPOSIT_GRANTEES.map((grantee) => ({ grantee, privilege_type: 'EXECUTE', is_grantable: false })),
});
/** What SQL 38 leaves (EXECUTE for checksops and authenticated only, no PUBLIC). */
export const CHECKALT_AUTO_DEPOSIT_PRE_STATE = Object.freeze(checkaltAutoDepositState('sql38'));
/** What SQL 80 leaves: only the definition and the comment differ. */
export const CHECKALT_AUTO_DEPOSIT_APPLIED_STATE = Object.freeze(checkaltAutoDepositState('sql80'));
export const AUTHORIZED_SQL80_CHECKALT_MEMBER_AUTO_DEPOSIT = Object.freeze({
  filename: 'aws/workflows/sql/80_checkalt_member_auto_deposit.sql',
  migration_id: '80_checkalt_member_auto_deposit',
  // The commit that authored the current file bytes (merged in PR #957).
  commit: '4a7c1053f5f766eaf600e68427d72fbbdc701032',
  source_sha256: '3ca77bf4d3bfe0d09645bec2d8bf86517f60a0804935fe6aff68a61f92747352',
  // Code-derived: sha256(checkaltAutoDepositStateText(CHECKALT_AUTO_DEPOSIT_PRE_STATE)),
  // the state SQL 38 leaves. A staging read-live run should confirm it before apply.
  expected_live_definition_sha256: '3ef657f48750ee96813e7d718ffa10314a71f660560dbc20bc41687c79770847',
  // Code-derived: sha256(checkaltAutoDepositStateText(CHECKALT_AUTO_DEPOSIT_APPLIED_STATE)),
  // re-derived from the real catalog by aws/tests/sql80-checkalt-member-auto-deposit-executor.test.mjs.
  intended_replacement_sha256: '5ad9a81cfc01ba8affc165b42986c1a6e7ce87c5f61df6a5ebcac293e00fa0db',
  function_identity: CHECKALT_AUTO_DEPOSIT_FUNCTION,
  table: CHECKALT_AUTO_DEPOSIT_TABLE,
});

// SQL 81 creates the SECURITY DEFINER function
// public.aws_register_checkalt_tenant_account(uuid, jsonb), the platform-owner
// -only writer of a tenant's production Check Alt depositor identity, its
// comment, REVOKE ALL ... FROM PUBLIC and GRANT EXECUTE ... TO checksops,
// authenticated. The function does not exist before (pre-state: absent, no
// function of that name in any schema). The state text has the same shape as
// SQL 80's: present, how many functions carry its name (any schema), the
// sha256 of pg_get_functiondef, SECURITY DEFINER, proconfig, whether the
// executor role owns it, the sha256 of its comment and every non-owner ACL entry.
export const CHECKALT_REGISTER_FUNCTION = 'public.aws_register_checkalt_tenant_account(uuid, jsonb)';
export const CHECKALT_REGISTER_FUNCTION_NAME = 'aws_register_checkalt_tenant_account';
export const CHECKALT_REGISTER_TABLE = 'public.checkalt_tenant_accounts';
export const CHECKALT_REGISTER_CONFIG = Object.freeze(['search_path=public', 'row_security=off']);
export const CHECKALT_REGISTER_GRANTEES = Object.freeze(['authenticated', 'checksops']);
// Columns the function body writes or returns; ON CONFLICT (tenant_id) also needs a unique tenant_id.
export const CHECKALT_REGISTER_COLUMNS = Object.freeze([
  'tenant_id', 'sso_user_id', 'deposit_account_number', 'first_name', 'last_name', 'email',
  'enabled', 'registered_at', 'last_register_payload', 'updated_at',
]);
// sha256(pg_get_functiondef) and sha256(obj_description) on PostgreSQL 16 of the
// SQL 81 file, re-derived by aws/tests/sql81-checkalt-depositor-register-executor.test.mjs.
export const CHECKALT_REGISTER_DEFINITION_SHA256 = Object.freeze({
  sql81: 'd1f781edb9e8665748da96b28a8afca54279fa43cf603c526f4200524d104a78',
});
export const CHECKALT_REGISTER_COMMENT_SHA256 = Object.freeze({
  sql81: 'e48465b4e9badfe5435ffcfc7162770b95746954b95c71eb9a9e304570bc435b',
});
/** Same `state` shape as checkaltAutoDepositStateText. */
export function checkaltRegisterStateText(state = {}) {
  const fn = CHECKALT_REGISTER_FUNCTION;
  if (state?.exists !== true) {
    return [`function ${fn}: absent`, `functions named ${CHECKALT_REGISTER_FUNCTION_NAME}: ${Number(state?.overload_count) || 0}`].join('\n');
  }
  const lines = [
    `function ${fn}: present`,
    `functions named ${CHECKALT_REGISTER_FUNCTION_NAME}: ${Number(state.overload_count) || 0}`,
    `${fn} definition sha256 ${SHA256_HEX_RE.test(String(state.definition_sha256 || '')) ? state.definition_sha256 : 'unreadable'}`,
    `${fn} security definer: ${state.security_definer === true ? 'on' : 'off'}`,
    `${fn} config: ${(state.config || []).join(',') || '-'}`,
    `${fn} owner: ${state.owner_is_executor === true ? 'executor role' : 'another role'}`,
    `${fn} comment sha256 ${SHA256_HEX_RE.test(String(state.comment_sha256 || '')) ? state.comment_sha256 : 'none'}`,
  ];
  const acl = (state.acl || []).map((entry) => `${fn} acl ${entry.grantee} ${entry.privilege_type}${entry.is_grantable === true ? ' with grant option' : ''}`);
  return [...lines, ...acl.sort()].join('\n');
}
/** Before SQL 81: no function of that name in any schema. */
export const CHECKALT_REGISTER_PRE_STATE = Object.freeze({ exists: false, overload_count: 0 });
/** What SQL 81 leaves: the reviewed function, EXECUTE for checksops and authenticated only (no PUBLIC). */
export const CHECKALT_REGISTER_APPLIED_STATE = Object.freeze({
  exists: true,
  overload_count: 1,
  definition_sha256: CHECKALT_REGISTER_DEFINITION_SHA256.sql81,
  security_definer: true,
  config: [...CHECKALT_REGISTER_CONFIG],
  owner_is_executor: true,
  comment_sha256: CHECKALT_REGISTER_COMMENT_SHA256.sql81,
  acl: CHECKALT_REGISTER_GRANTEES.map((grantee) => ({ grantee, privilege_type: 'EXECUTE', is_grantable: false })),
});
export const AUTHORIZED_SQL81_CHECKALT_PRODUCTION_REGISTER = Object.freeze({
  filename: 'aws/workflows/sql/81_checkalt_production_register.sql',
  migration_id: '81_checkalt_production_register',
  // The commit that authored the current file bytes (PR #972).
  commit: 'e13efe6632753d3a50e4c37cd6162fb9a175a586',
  source_sha256: '88aafdacf83ea382e4b2f0c56da8d8c2048d36773ada18c49874e807cdbd8fbe',
  // Code-derived: sha256(checkaltRegisterStateText(CHECKALT_REGISTER_PRE_STATE)), the
  // function absent. A staging read-live run should confirm it before apply.
  expected_live_definition_sha256: 'e12fdf2fe609d474a9cc215c018cce922cc2a63edfd18f7b5988ce21d1903f37',
  // Code-derived: sha256(checkaltRegisterStateText(CHECKALT_REGISTER_APPLIED_STATE)),
  // re-derived from the real catalog by aws/tests/sql81-checkalt-depositor-register-executor.test.mjs.
  intended_replacement_sha256: '36623ccebd920a9c6316da7f787ad99126e474656877e01b5854e099ce661225',
  function_identity: CHECKALT_REGISTER_FUNCTION,
  table: CHECKALT_REGISTER_TABLE,
});

export const AUTHORIZED_SQL39 = Object.freeze({
  filename: 'aws/rls/sql/39_tmp_write_policy_reconcile.sql',
  migration_id: '39_tmp_write_policy_reconcile',
  commit: 'f2df6f9bed6ae3ddca9fce39668aa117de796de1',
  source_sha256: 'a3ec9922d33cf75fc554ac9bdd3e7c1b14429112f38ce23f517d64e06b9442a9',
  intended_replacement_sha256: 'a3ec9922d33cf75fc554ac9bdd3e7c1b14429112f38ce23f517d64e06b9442a9',
  table: 'public.tenant_maintenance_payments',
  policy_name: 'aws_write_tenant_maintenance_payments',
  job_policy_name: 'aws_write_tenant_maintenance_payments_job',
});

export const AUTHORIZED_SQL40 = Object.freeze({
  filename: 'aws/rls/sql/40_collection_v2_synthetic_uat_cleanup.sql',
  migration_id: '40_collection_v2_synthetic_uat_cleanup',
  commit: '5ae0a41db7ebe727527060139befb4ba31240144',
  source_sha256: '9f691e72da8e3490489854f685f470884441e61e2475b91e92fec55fd80b5de8',
  intended_replacement_sha256: '40a486ede83069b6b640ef4c4b06b88585be2b30102673bccde22238b185405d',
  expected_live_fixture_sha256: '48c32f695046582285a5dd97433a52da528ad8be0f6b33c2d46c3395a51e98f0',
  table: 'public.tenant_maintenance_payments',
});

export const AUTHORIZED_STAGING_SQL = Object.freeze([
  AUTHORIZED_SQL44,
  AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS,
  AUTHORIZED_SQL53,
  AUTHORIZED_SQL39,
  AUTHORIZED_SQL40,
  AUTHORIZED_LEDGER_20261007193200,
  AUTHORIZED_SQL71_AMOUNT_GRANT,
  AUTHORIZED_SQL72_MEMBER_PAYMENT_WRITES,
  AUTHORIZED_SQL76_PARTNERSHIP_CONSENT,
  AUTHORIZED_SQL77_CHECK_STAKEHOLDERS_GRANT,
  AUTHORIZED_SQL78_PARTNER_STAKEHOLDER_REMOVALS,
  AUTHORIZED_SQL79_MEMBER_STAKEHOLDER_WRITES,
  AUTHORIZED_SQL80_CHECKALT_MEMBER_AUTO_DEPOSIT,
  AUTHORIZED_SQL81_CHECKALT_PRODUCTION_REGISTER,
]);

export function pinIdentifiersMatch(input = {}, pin = {}) {
  const hasFile = Boolean(input.filename);
  const hasMigration = Boolean(input.migration_id);
  const fileOk = input.filename === pin.filename;
  const migrationOk = input.migration_id === pin.migration_id;
  if (hasFile && hasMigration) return fileOk && migrationOk;
  if (hasFile) return fileOk;
  if (hasMigration) return migrationOk;
  return false;
}

export function isSql53AuthorizedMigration(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL53);
}

export function isLedger20261007193200(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_LEDGER_20261007193200);
}

export function isSql71AmountGrant(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL71_AMOUNT_GRANT);
}

export function isSql72MemberPaymentWrites(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL72_MEMBER_PAYMENT_WRITES);
}

export function isSql76PartnershipConsent(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL76_PARTNERSHIP_CONSENT);
}

export function isSql77CheckStakeholdersGrant(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL77_CHECK_STAKEHOLDERS_GRANT);
}

export function isSql78PartnerStakeholderRemovals(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL78_PARTNER_STAKEHOLDER_REMOVALS);
}

export function isSql79MemberStakeholderWrites(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL79_MEMBER_STAKEHOLDER_WRITES);
}

export function isSql80CheckaltMemberAutoDeposit(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL80_CHECKALT_MEMBER_AUTO_DEPOSIT);
}

export function isSql81CheckaltProductionRegister(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL81_CHECKALT_PRODUCTION_REGISTER);
}

export function isSql39(input = {}) {
  return input.filename === AUTHORIZED_SQL39.filename
    || input.migration_id === AUTHORIZED_SQL39.migration_id;
}

export function isSql40(input = {}) {
  return input.filename === AUTHORIZED_SQL40.filename
    || input.migration_id === AUTHORIZED_SQL40.migration_id;
}

export function isTenantUsersSameCheckPermissions(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS);
}

export function isSql44AuthorizedMigration(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL44);
}

export function resolveAuthorizedMigration(input = {}) {
  if (isSql53AuthorizedMigration(input)) return AUTHORIZED_SQL53;
  if (isLedger20261007193200(input)) return AUTHORIZED_LEDGER_20261007193200;
  if (isSql71AmountGrant(input)) return AUTHORIZED_SQL71_AMOUNT_GRANT;
  if (isSql72MemberPaymentWrites(input)) return AUTHORIZED_SQL72_MEMBER_PAYMENT_WRITES;
  if (isSql76PartnershipConsent(input)) return AUTHORIZED_SQL76_PARTNERSHIP_CONSENT;
  if (isSql77CheckStakeholdersGrant(input)) return AUTHORIZED_SQL77_CHECK_STAKEHOLDERS_GRANT;
  if (isSql78PartnerStakeholderRemovals(input)) return AUTHORIZED_SQL78_PARTNER_STAKEHOLDER_REMOVALS;
  if (isSql79MemberStakeholderWrites(input)) return AUTHORIZED_SQL79_MEMBER_STAKEHOLDER_WRITES;
  if (isSql80CheckaltMemberAutoDeposit(input)) return AUTHORIZED_SQL80_CHECKALT_MEMBER_AUTO_DEPOSIT;
  if (isSql81CheckaltProductionRegister(input)) return AUTHORIZED_SQL81_CHECKALT_PRODUCTION_REGISTER;
  if (isSql40(input)) return AUTHORIZED_SQL40;
  if (isSql39(input)) return AUTHORIZED_SQL39;
  if (isTenantUsersSameCheckPermissions(input)) return AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS;
  if (isSql44AuthorizedMigration(input)) return AUTHORIZED_SQL44;
  return null;
}

export function requireAuthorizedMigration(input = {}) {
  const authorized = resolveAuthorizedMigration(input);
  if (!authorized) {
    return fail(
      CODES.SQL_COLLISION,
      'authorization package is not bound to an allowlisted staging SQL file',
      {
        filename: input.filename || null,
        migration_id: input.migration_id || null,
      },
    );
  }
  return ok({ allowlist_entry: authorized });
}

export function classifySql53CreateLive(input = {}, pin = AUTHORIZED_SQL53) {
  const liveHash = SHA256_RE.test(String(input.live_definition_sha256 || ''))
    ? input.live_definition_sha256
    : null;
  const absentHash = pin.absent_live_definition_sha256;
  const provenPresent = input.exists === true || (Boolean(liveHash) && liveHash !== absentHash);

  if (provenPresent) {
    if (liveHash === pin.intended_replacement_sha256) {
      return fail(
        CODES.UNRELATED_MUTATION,
        'settlement function already matches the intended definition; refuse replace',
        {
          function_identity: pin.function_identity,
          live_definition_sha256: liveHash,
          intended_replacement_sha256: pin.intended_replacement_sha256,
        },
      );
    }
    return fail(
      CODES.SQL_COLLISION,
      'settlement function exists; refuse replace',
      {
        function_identity: pin.function_identity,
        live_definition_sha256: liveHash,
        intended_replacement_sha256: pin.intended_replacement_sha256,
      },
    );
  }

  if (input.exists === false && liveHash === absentHash) {
    return ok({
      state: 'absent',
      apply_allowed: true,
      live_definition_sha256: absentHash,
    });
  }

  return fail(
    CODES.SQL_COLLISION,
    'SQL 53 create requires exists: false and the absent-function live hash immediately before apply',
    {
      function_identity: pin.function_identity,
      exists: input.exists === true ? true : input.exists === false ? false : null,
      live_definition_sha256: liveHash,
      absent_live_definition_sha256: absentHash,
    },
  );
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const ONE_USE_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const ALLOWED_ACTIONS = new Set(['authorize', 'apply', 'inspect', 'verify_data']);
const FORBIDDEN_ACTIONS = new Set(['create_new', 'link_existing', 'restore', 'reclaim', 'reuse']);

export function authorizationFingerprint(input = {}) {
  return {
    sql: input.expected_live_definition_sha256 || null,
    filename: input.filename || null,
    migration_id: input.migration_id || null,
    source_sha256: input.source_sha256 || null,
    intended_replacement_sha256: input.intended_replacement_sha256 || null,
    one_use_id: input.one_use_id || null,
    commit: input.commit || null,
  };
}

function matchingAllowlistEntry(input, allowlist) {
  return allowlist.find((row) => (
    row.filename === input.filename
    && row.migration_id === input.migration_id
    && row.commit === input.commit
    && row.source_sha256 === input.source_sha256
    && row.intended_replacement_sha256 === input.intended_replacement_sha256
  )) || null;
}

export function evaluateSqlExecutorAuthorization(input = {}, opts = {}) {
  const allowlist = opts.allowlist || AUTHORIZED_STAGING_SQL;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const errors = [];

  if (input.sql_text != null || input.sql != null || input.statement != null || input.arbitrary_sql != null) {
    return failMany([errorEntry(
      CODES.UNRELATED_MUTATION,
      'arbitrary SQL text is forbidden; the executor may apply only the allowlisted source file',
    )], CODES.UNRELATED_MUTATION);
  }

  const environment = input.target_environment || input.environment;
  if (environment === 'production') {
    return failMany([errorEntry(
      CODES.PRODUCTION_APPROVAL_REQUIRED,
      'the VPC SQL executor is staging-only and must never target production',
      { target_environment: environment },
    )], CODES.PRODUCTION_APPROVAL_REQUIRED);
  }
  if (environment !== 'staging') {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'SQL executor authorization requires target_environment=staging'));
  }

  const component = input.target_component || input.component;
  if (component !== SQL_EXECUTOR_COMPONENT) {
    errors.push(errorEntry(
      CODES.RECEIPT_MISMATCH,
      'SQL executor authorization requires component=staging-sql; a Lambda or SPA receipt cannot authorize SQL',
      { target_component: component || null },
    ));
  }

  if ((input.deployment_type || SQL_EXECUTOR_DEPLOYMENT_TYPE) !== SQL_EXECUTOR_DEPLOYMENT_TYPE) {
    errors.push(errorEntry(
      CODES.RECEIPT_MISMATCH,
      'SQL executor authorization requires deployment_type=sql-executor-invoke; sql-apply receipts are not an escape hatch',
      { deployment_type: input.deployment_type || null },
    ));
  }

  const functionName = input.function_name || input.executor_identity || SQL_EXECUTOR_FUNCTION;
  if (FORBIDDEN_EXECUTOR_FUNCTIONS.includes(functionName) || functionName !== SQL_EXECUTOR_FUNCTION) {
    errors.push(errorEntry(
      CODES.UNRELATED_MUTATION,
      'executor function identity is not the dedicated staging SQL executor',
      { function_name: functionName },
    ));
  }

  const action = String(input.action || 'authorize').trim();
  if (FORBIDDEN_ACTIONS.has(action)) {
    return failMany([errorEntry(
      CODES.UNRELATED_MUTATION,
      `executor action ${action} is forbidden`,
      { action },
    )], CODES.UNRELATED_MUTATION);
  }
  if (!ALLOWED_ACTIONS.has(action)) {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, `executor action must be one of ${[...ALLOWED_ACTIONS].join(', ')}`));
  }

  if (!SHA256_RE.test(String(input.expected_live_definition_sha256 || ''))) {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'authorization package requires expected_live_definition_sha256'));
  }
  if (!SHA256_RE.test(String(input.intended_replacement_sha256 || ''))) {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'authorization package requires intended_replacement_sha256'));
  }
  if (!SHA256_RE.test(String(input.source_sha256 || ''))) {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'authorization package requires source_sha256'));
  }
  if (!input.filename) errors.push(errorEntry(CODES.INVALID_MANIFEST, 'authorization package requires filename'));
  if (!input.migration_id) errors.push(errorEntry(CODES.INVALID_MANIFEST, 'authorization package requires migration_id'));
  if (!ONE_USE_RE.test(String(input.one_use_id || ''))) {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'authorization package requires a one_use_id'));
  }
  if (!input.expiry || Number.isNaN(Date.parse(input.expiry))) {
    errors.push(errorEntry(CODES.RECEIPT_EXPIRED, 'authorization package requires an expiry timestamp'));
  } else if (Date.parse(input.expiry) <= now) {
    errors.push(errorEntry(CODES.RECEIPT_EXPIRED, 'authorization package has expired', { expiry: input.expiry }));
  }

  const allowed = matchingAllowlistEntry(input, allowlist);
  if (!allowed) {
    errors.push(errorEntry(
      CODES.SQL_COLLISION,
      'authorization package is not bound to an allowlisted staging SQL file/commit/hash tuple',
      {
        filename: input.filename || null,
        migration_id: input.migration_id || null,
        commit: input.commit || null,
        source_sha256: input.source_sha256 || null,
        intended_replacement_sha256: input.intended_replacement_sha256 || null,
      },
    ));
  } else if (
    input.expected_live_definition_sha256
    && input.intended_replacement_sha256
    && input.expected_live_definition_sha256 === input.intended_replacement_sha256
  ) {
    errors.push(errorEntry(
      CODES.INVALID_MANIFEST,
      'intended replacement hash must differ from the expected live definition hash',
    ));
  }

  const fingerprint = authorizationFingerprint(input);
  const provided = input.preflight_live_fingerprint;
  if (provided && typeof provided === 'object') {
    if (provided.sql && provided.sql !== fingerprint.sql) {
      errors.push(errorEntry(CODES.DEPLOYMENT_COLLISION, 'receipt fingerprint sql hash does not match expected live definition', {
        receipt_sql: provided.sql,
        expected_live_definition_sha256: fingerprint.sql,
      }));
    }
    if (provided.one_use_id && provided.one_use_id !== fingerprint.one_use_id) {
      errors.push(errorEntry(CODES.RECEIPT_MISMATCH, 'receipt one_use_id does not match the authorization package'));
    }
    if (provided.intended_replacement_sha256 && provided.intended_replacement_sha256 !== fingerprint.intended_replacement_sha256) {
      errors.push(errorEntry(CODES.RECEIPT_MISMATCH, 'receipt intended replacement hash does not match the authorization package'));
    }
    if (provided.source_sha256 && provided.source_sha256 !== fingerprint.source_sha256) {
      errors.push(errorEntry(CODES.RECEIPT_MISMATCH, 'receipt source hash does not match the authorization package'));
    }
    if (provided.filename && provided.filename !== fingerprint.filename) {
      errors.push(errorEntry(CODES.RECEIPT_MISMATCH, 'receipt filename does not match the authorization package'));
    }
    if (provided.commit && provided.commit !== fingerprint.commit) {
      errors.push(errorEntry(CODES.RECEIPT_MISMATCH, 'receipt commit does not match the authorization package'));
    }
  }

  const identity = validateWorkstreamIdentity({
    workstream_id: input.workstream_id,
    branch: input.branch,
    commit: input.commit,
    operator: input.operator,
    target_environment: environment,
    deployment_type: input.deployment_type || SQL_EXECUTOR_DEPLOYMENT_TYPE,
    owned_components: input.owned_components || (input.filename ? [input.filename] : []),
    preflight_live_fingerprint: provided || fingerprint,
    build_timestamp: input.build_timestamp,
  });
  if (!identity.ok) {
    errors.push(...identity.errors);
  }

  if (errors.length) {
    const code = errors.some((row) => row.code === CODES.SQL_COLLISION)
      ? CODES.SQL_COLLISION
      : errors.some((row) => row.code === CODES.DEPLOYMENT_COLLISION)
        ? CODES.DEPLOYMENT_COLLISION
        : errors.some((row) => row.code === CODES.RECEIPT_EXPIRED)
          ? CODES.RECEIPT_EXPIRED
          : errors[0].code;
    return failMany(errors, code);
  }

  return ok({
    sql_executor_allowed: true,
    vpc_executor: true,
    live_hash_deferred_to_executor: true,
    sql_apply_live_hash_not_skipped: true,
    action,
    function_name: SQL_EXECUTOR_FUNCTION,
    authorization_fingerprint: fingerprint,
    allowlist_entry: {
      filename: allowed.filename,
      migration_id: allowed.migration_id,
      commit: allowed.commit,
      function_identity: allowed.function_identity,
    },
  });
}
