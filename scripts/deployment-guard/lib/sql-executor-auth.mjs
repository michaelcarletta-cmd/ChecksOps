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
import { createHash } from 'node:crypto';
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

// SQL 89 replaces checksops' UPDATE on check_intake_items with UPDATE on exactly
// these columns: every SET target of an UPDATE the API issues as checksops
// (ops/production-sql-89-apply.md cites the code for each). Sorted, unique.
export const SQL89_COLUMNS = Object.freeze([
  'account_number',
  'amount',
  'back_image_deposit_path',
  'back_image_original_path',
  'back_image_path',
  'carrier_name',
  'check_number',
  'check_stage',
  'deposit_recommendation',
  'endorsement_override',
  'endorsement_packet_path',
  'endorsement_render_meta',
  'endorsement_render_status',
  'endorsement_render_version',
  'expiration_days',
  'front_image_path',
  'funds_type',
  'is_multi_payee',
  'issue_date',
  'mortgage_monitoring_type',
  'mortgage_received_at',
  'mortgage_sent_at',
  'mortgage_tracking_number',
  'ocr_needs_verification',
  'ocr_status',
  'payee_address',
  'payee_line',
  'pre_return_stage',
  'property_address',
  'return_code',
  'return_notes',
  'return_reason',
  'return_recorded_by',
  'return_resolution',
  'return_resolved_at',
  'return_source',
  'returned_at',
  'review_notes',
  'reviewed_at',
  'reviewed_by',
  'routing_number',
  'status',
  'updated_at',
]);
// The canonical UPDATE privilege state of checksops on the table, hashed for the
// live fingerprint: whether it has table-level UPDATE (by any route) and the sorted
// set of columns it can UPDATE (by any route). Staging and production share it.
export function columnUpdateStateText({ table_level_update: tableLevel, updatable_columns: columns } = {}) {
  return [
    'checksops UPDATE ON public.check_intake_items',
    `table_level_update: ${tableLevel === true}`,
    `updatable_columns: ${[...(columns || [])].map(String).sort().join(',')}`,
  ].join('\n');
}
// The roles SQL 89 revokes table-level UPDATE from (which also removes their column
// UPDATE grants): checksops itself, and authenticated and PUBLIC, whose UPDATE grants
// checksops holds through membership (aws/rls/sql/01_role_shim.sql: GRANT authenticated TO checksops).
export const SQL89_REVOKED_GRANTEES = Object.freeze(['checksops', 'authenticated', 'PUBLIC']);
// The file holds only comments and exactly these four statements (whitespace aside).
export const SQL89_CANONICAL_STATEMENTS = `${SQL89_REVOKED_GRANTEES.map((g) => `REVOKE UPDATE ON TABLE public.check_intake_items FROM ${g};`).join(' ')} GRANT UPDATE (${SQL89_COLUMNS.join(', ')}) ON TABLE public.check_intake_items TO checksops;`;
/** The file's statements with comments removed and whitespace collapsed. */
export function sql89StatementText(text) {
  return String(text || '')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+,/g, ',')
    .replace(/,(?=\S)/g, ', ')
    .trim();
}
export const AUTHORIZED_SQL89_CHECK_INTAKE_COLUMN_UPDATE = Object.freeze({
  filename: 'aws/workflows/sql/89_check_intake_items_column_update.sql',
  migration_id: '89_check_intake_items_column_update',
  // The commit that authored the file bytes (this branch's first commit).
  commit: '70518bbd7e459ae82d461941281465ce58d7a887',
  source_sha256: 'd91ab6576a2bda45f2a9b0d21fc98241dd8ee20adc24bd34ecb68fc09f92c28a',
  // Staging read-live run 82 (run id 38918803201), 2026-10-16, main 39f9b21ea (executor
  // deploy run 81): no table-level UPDATE, 31 updatable columns (routing_number and
  // account_number absent; detected_claim_number present), 13 to grant, 1 losing update,
  // SQL 70 ingest SECURITY DEFINER, no unsafe update functions; precondition_failures [].
  // Staging apply run 85 rolled back (UNRELATED_MUTATION, intended_state and
  // updatable_columns_exact): the file then revoked only checksops' own UPDATE, and
  // checksops kept UPDATE inherited from authenticated/PUBLIC. The fingerprint
  // (columnUpdateStateText of checksops' effective UPDATE) is unchanged by the fix, so
  // this recorded pre-state still describes staging.
  expected_live_definition_sha256: '6810985b26778774a633ad17f02b634ec7c19b956d0f5302251fd1d2d05b0c7f',
  // sha256(columnUpdateStateText({ table_level_update: false, updatable_columns: SQL89_COLUMNS })).
  intended_replacement_sha256: '2a1d45f9250083a605e9784aba628f6f87f52840010487974b29a94097a7e2f8',
  grantee: 'checksops',
  table: 'public.check_intake_items',
  columns: SQL89_COLUMNS,
  // SQL 70: the SECURITY DEFINER ingest. Without it ingest-shared-check.mjs falls back to an
  // inline UPDATE as checksops of columns SQL 89 does not grant, so it is a prerequisite.
  ingest_function: 'public.aws_ingest_shared_check(jsonb)',
});

// --- SQL 89 catalog reads (shared by the staging executor and the production tool) ---
// Names are qualified through pg_namespace and pg_catalog. No table row is read.

const SQL89_TABLE_NAME = 'check_intake_items';
const SQL89_GRANTEE = AUTHORIZED_SQL89_CHECK_INTAKE_COLUMN_UPDATE.grantee;
const SQL89_TABLE_PRIVILEGES = Object.freeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']);
const SQL89_TABLE_FILTER = `n.nspname = 'public' AND c.relname = '${SQL89_TABLE_NAME}' AND c.relkind IN ('r', 'p')`;
const SQL89_READS = Object.freeze({
  login: 'SELECT current_user::text AS current_user, session_user::text AS session_user',
  role: `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${SQL89_GRANTEE}') AS present`,
  table: `SELECT c.relacl::text AS table_acl, pg_catalog.pg_get_userbyid(c.relowner) AS table_owner,
  pg_catalog.has_table_privilege(current_user, c.oid, 'UPDATE WITH GRANT OPTION') AS login_can_grant
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE ${SQL89_TABLE_FILTER}`,
  // Every column and whether the grantee can UPDATE it by any route (column, table, PUBLIC, membership).
  columns: `SELECT a.attname::text AS column_name,
  pg_catalog.has_column_privilege('${SQL89_GRANTEE}', c.oid, a.attnum, 'UPDATE') AS can_update
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE ${SQL89_TABLE_FILTER}
ORDER BY 1`,
  // Table-level privileges of the grantee by any route.
  tablePrivileges: `SELECT ${SQL89_TABLE_PRIVILEGES.map((p) => `pg_catalog.has_table_privilege('${SQL89_GRANTEE}', c.oid, '${p}') AS ${p.toLowerCase()}`).join(', ')}
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE ${SQL89_TABLE_FILTER}`,
  // Direct table ACL entries of anyone but the owner, grantor included.
  tableAcl: `SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee, pg_catalog.pg_get_userbyid(x.grantor) AS grantor, x.privilege_type, x.is_grantable
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) x
LEFT JOIN pg_catalog.pg_roles r ON r.oid = x.grantee
WHERE ${SQL89_TABLE_FILTER} AND x.grantee <> c.relowner
ORDER BY 1, 3, 2`,
  // Every direct column ACL entry on the table (all privileges, all grantees), grantor included.
  columnAcl: `SELECT a.attname::text AS column_name, COALESCE(r.rolname, 'PUBLIC') AS grantee,
  pg_catalog.pg_get_userbyid(x.grantor) AS grantor, x.privilege_type, x.is_grantable
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
LEFT JOIN pg_catalog.pg_roles r ON r.oid = x.grantee
WHERE ${SQL89_TABLE_FILTER}
ORDER BY 1, 2, 4, 3`,
  // Functions whose body UPDATEs the table. A SECURITY INVOKER one runs as its caller
  // (the API runs as checksops), and a SECURITY DEFINER one owned by a role with
  // checksops' privileges loses them too: SQL 89 refuses while either exists.
  // A superuser owner or the table's owner needs no grant; any other owner that inherits
  // checksops' privileges (or is checksops) would lose UPDATE with it.
  updateFunctions: `SELECT p.oid::regprocedure::text AS signature, p.prosecdef AS security_definer,
  (NOT o.rolsuper AND p.proowner <> COALESCE(t.relowner, 0)
    AND COALESCE(pg_catalog.pg_has_role(p.proowner, g.oid, 'USAGE'), false)) AS owner_has_grantee_privileges
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
JOIN pg_catalog.pg_roles o ON o.oid = p.proowner
LEFT JOIN pg_catalog.pg_roles g ON g.rolname = '${SQL89_GRANTEE}'
LEFT JOIN pg_catalog.pg_class t ON t.oid = pg_catalog.to_regclass('public.${SQL89_TABLE_NAME}')
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind IN ('f', 'p')
  AND (CASE WHEN p.prosrc = '' THEN pg_catalog.pg_get_functiondef(p.oid) ELSE p.prosrc END)
    ~* '\\mupdate\\s+(only\\s+)?(public\\s*\\.\\s*)?"?${SQL89_TABLE_NAME}\\M'
ORDER BY 1`,
  revokedRolePresent: `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') AS present`,
  // Roles whose privileges the grantee can use: every chain of memberships each granted
  // with INHERIT or SET (an ADMIN-only membership confers nothing). Role names only.
  granteeMemberOf: `WITH RECURSIVE up(roleid) AS (
  SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid = m.member
  WHERE g.rolname = '${SQL89_GRANTEE}' AND (m.inherit_option OR m.set_option)
  UNION
  SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN up ON up.roleid = m.member WHERE m.inherit_option OR m.set_option
)
SELECT DISTINCT r.rolname::text AS role_name FROM up JOIN pg_catalog.pg_roles r ON r.oid = up.roleid ORDER BY 1`,
  // Roles that can use authenticated's privileges (same rule), with whether each can log in.
  authenticatedMembers: `WITH RECURSIVE down(member) AS (
  SELECT m.member FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles a ON a.oid = m.roleid
  WHERE a.rolname = 'authenticated' AND (m.inherit_option OR m.set_option)
  UNION
  SELECT m.member FROM pg_catalog.pg_auth_members m JOIN down ON down.member = m.roleid WHERE m.inherit_option OR m.set_option
)
SELECT DISTINCT r.rolname::text AS role_name, r.rolcanlogin AS can_login FROM down JOIN pg_catalog.pg_roles r ON r.oid = down.member ORDER BY 1`,
  ingest: `SELECT p.prosecdef AS security_definer
FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('${AUTHORIZED_SQL89_CHECK_INTAKE_COLUMN_UPDATE.ingest_function}')`,
});

const sql89EntryLine = (row) => `${row.grantee} ${row.privilege_type}${row.is_grantable === true ? ' with grant option' : ''} granted by ${row.grantor}`;
const sql89SameList = (a, b) => Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b);
const sql89Failed = (checks) => checks.filter(([, passed]) => !passed).map(([name]) => name);
const sql89Hash = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');

/**
 * checksops' UPDATE privilege state on public.check_intake_items, the SQL 89 plan
 * (columns it would grant and columns that would lose UPDATE), its prerequisites and
 * the live fingerprint. Catalog reads only.
 */
export async function readSql89State(client) {
  const q = async (sql) => (await client.query(sql))?.rows || [];
  const login = (await q(SQL89_READS.login))[0] || {};
  const rolePresent = (await q(SQL89_READS.role))[0]?.present === true;
  const table = (await q(SQL89_READS.table))[0] || null;
  if (!table) return fail(CODES.SQL_COLLISION, 'public.check_intake_items is missing');
  const base = {
    current_user: typeof login.current_user === 'string' ? login.current_user : null,
    session_user: typeof login.session_user === 'string' ? login.session_user : null,
    grantee_role_present: rolePresent,
    table_present: true,
    table_owner: table.table_owner,
    table_acl: table.table_acl ?? null,
    login_can_grant: table.login_can_grant === true,
  };
  if (!rolePresent) return ok({ ...base, live_definition_sha256: null });
  const columnRows = await q(SQL89_READS.columns);
  if (!columnRows.length) return fail(CODES.SQL_COLLISION, 'public.check_intake_items has no columns visible to the login');
  const columns = columnRows.map((row) => row.column_name).sort();
  const updatable = columnRows.filter((row) => row.can_update === true).map((row) => row.column_name).sort();
  const privRow = (await q(SQL89_READS.tablePrivileges))[0] || {};
  const tablePrivileges = Object.fromEntries(SQL89_TABLE_PRIVILEGES.map((p) => [p, privRow[p.toLowerCase()] === true]));
  const tableEntries = await q(SQL89_READS.tableAcl);
  const columnEntries = await q(SQL89_READS.columnAcl);
  const functions = (await q(SQL89_READS.updateFunctions)).map((row) => ({
    signature: String(row.signature),
    security_definer: row.security_definer === true,
    owner_has_grantee_privileges: row.owner_has_grantee_privileges === true,
  }));
  const ingest = (await q(SQL89_READS.ingest))[0] || null;
  const authenticatedPresent = (await q(SQL89_READS.revokedRolePresent))[0]?.present === true;
  const memberOf = (await q(SQL89_READS.granteeMemberOf)).map((row) => String(row.role_name)).sort();
  const authenticatedMembers = (await q(SQL89_READS.authenticatedMembers))
    .map((row) => ({ role: String(row.role_name), can_login: row.can_login === true }))
    .sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0));
  const isGrantee = (row) => row.grantee === SQL89_GRANTEE;
  const updateEntry = (row) => isGrantee(row) && row.privilege_type === 'UPDATE';
  const tableLevel = tablePrivileges.UPDATE === true;
  // Where the grantee's UPDATE comes from: every direct UPDATE entry (table or column) of the
  // grantee, of PUBLIC and of each role the grantee can use the privileges of.
  const sources = [SQL89_GRANTEE, 'PUBLIC', ...memberOf.filter((r) => r !== SQL89_GRANTEE && r !== 'PUBLIC')];
  const allUpdate = (entries) => entries.filter((row) => row.privilege_type === 'UPDATE');
  const updateGrantSources = sources.map((grantee) => {
    const tableUpdate = allUpdate(tableEntries).some((row) => row.grantee === grantee);
    const cols = [...new Set(allUpdate(columnEntries).filter((row) => row.grantee === grantee).map((row) => row.column_name))].sort();
    return { grantee, table_level: tableUpdate, columns: cols };
  }).filter((src) => src.table_level || src.columns.length > 0);
  const updateProvenance = {};
  for (const name of [...new Set([...SQL89_COLUMNS, ...updatable])].sort()) {
    updateProvenance[name] = updateGrantSources
      .filter((src) => src.table_level || src.columns.includes(name))
      .map((src) => (src.table_level ? `${src.grantee} (table)` : src.grantee));
  }
  const revokedOthers = SQL89_REVOKED_GRANTEES.filter((g) => g !== SQL89_GRANTEE);
  const revokedOtherEntries = tableEntries.concat(columnEntries)
    .filter((row) => row.privilege_type === 'UPDATE' && revokedOthers.includes(row.grantee));
  const state = {
    ...base,
    table_acl_entries: tableEntries.map(sql89EntryLine).sort(),
    table_privileges: tablePrivileges,
    table_level_update: tableLevel,
    table_level_update_entry: tableEntries.some(updateEntry),
    columns,
    updatable_columns: updatable,
    updatable_columns_sha256: sql89Hash(updatable.join(',')),
    column_update_entries: columnEntries.filter(updateEntry).map((row) => `${row.column_name} ${sql89EntryLine(row)}`).sort(),
    column_acl_entries: columnEntries.map((row) => `${row.column_name} ${sql89EntryLine(row)}`).sort(),
    grantee_grant_option: tableEntries.concat(columnEntries).some((row) => isGrantee(row) && row.is_grantable === true),
    grantee_update_grantors: [...new Set(tableEntries.concat(columnEntries).filter(updateEntry).map((row) => row.grantor))].sort(),
    sql89_columns: [...SQL89_COLUMNS],
    sql89_columns_missing: SQL89_COLUMNS.filter((name) => !columns.includes(name)),
    columns_to_grant: SQL89_COLUMNS.filter((name) => columns.includes(name) && !updatable.includes(name)),
    columns_losing_update: updatable.filter((name) => !SQL89_COLUMNS.includes(name)),
    update_functions: functions,
    unsafe_update_functions: functions.filter((f) => !f.security_definer || f.owner_has_grantee_privileges).map((f) => f.signature),
    ingest_function_present: ingest !== null,
    ingest_function_security_definer: ingest?.security_definer === true,
    authenticated_role_present: authenticatedPresent,
    grantee_member_of: memberOf,
    authenticated_members: authenticatedMembers,
    other_login_authenticated_members: authenticatedMembers.filter((m) => m.can_login && m.role !== SQL89_GRANTEE).map((m) => m.role),
    update_grant_sources: updateGrantSources,
    update_provenance: updateProvenance,
    // UPDATE reaching the grantee through a role SQL 89 does not revoke from.
    other_inherited_update_roles: updateGrantSources.map((src) => src.grantee).filter((g) => !SQL89_REVOKED_GRANTEES.includes(g)),
    revoked_role_update_entries: revokedOtherEntries
      .map((row) => (row.column_name ? `${row.column_name} ${sql89EntryLine(row)}` : sql89EntryLine(row))).sort(),
    revoked_role_update_grantors: [...new Set(revokedOtherEntries.map((row) => row.grantor))].sort(),
    live_definition_sha256: sql89Hash(columnUpdateStateText({ table_level_update: tableLevel, updatable_columns: updatable })),
  };
  state.already_applied = state.live_definition_sha256 === AUTHORIZED_SQL89_CHECK_INTAKE_COLUMN_UPDATE.intended_replacement_sha256
    && state.table_level_update_entry === false
    && state.revoked_role_update_entries.length === 0
    && sql89SameList(state.column_update_entries, sql89ExpectedUpdateEntries(state.grantee_update_grantors.length === 1 ? state.grantee_update_grantors[0] : null));
  return ok(state);
}

/** The direct column ACL entries SQL 89 leaves for checksops when run as `grantor`. */
export function sql89ExpectedUpdateEntries(grantor) {
  return SQL89_COLUMNS.map((name) => `${name} ${SQL89_GRANTEE} UPDATE granted by ${grantor}`);
}

/** Rules both environments apply before SQL 89 runs. */
export function sql89SharedPreconditionFailures(state) {
  const login = state?.current_user;
  return sql89Failed([
    ['grantee_role_present', state?.grantee_role_present === true],
    ['table_present', state?.table_present === true],
    ['sql89_columns_present', Array.isArray(state?.sql89_columns_missing) && state.sql89_columns_missing.length === 0],
    ['no_grantee_grant_option', state?.grantee_grant_option === false],
    // The REVOKE removes only what the login granted; another grantor's UPDATE would survive it.
    ['grantee_update_granted_by_login', typeof login === 'string' && Array.isArray(state?.grantee_update_grantors)
      && state.grantee_update_grantors.every((grantor) => grantor === login)],
    ['login_can_grant', state?.login_can_grant === true],
    ['update_functions_safe', Array.isArray(state?.unsafe_update_functions) && state.unsafe_update_functions.length === 0],
    // SQL 95 drops SQL 70's ingest with the retired Freedom Claims bridge. SQL 89
    // needs it only to run: once SQL 89 is applied (already_applied, the intended
    // column state), the check is skipped so a later read-live of SQL 89 does not
    // report a collision for a function SQL 95 removed on purpose.
    ['sql70_ingest_function_security_definer', state?.already_applied === true
      || (state?.ingest_function_present === true && state?.ingest_function_security_definer === true)],
    // SQL 89 names authenticated; the REVOKE fails without the role.
    ['authenticated_role_present', state?.authenticated_role_present === true],
    // Every other LOGIN role that uses authenticated's privileges would lose UPDATE with it.
    ['authenticated_has_no_other_login_members', Array.isArray(state?.other_login_authenticated_members)
      && state.other_login_authenticated_members.length === 0],
    // UPDATE through any other role checksops is a member of would survive SQL 89.
    ['no_other_inherited_update', Array.isArray(state?.other_inherited_update_roles) && state.other_inherited_update_roles.length === 0],
    // The REVOKEs from authenticated and PUBLIC remove only what the login granted.
    ['inherited_update_granted_by_login', typeof login === 'string' && Array.isArray(state?.revoked_role_update_grantors)
      && state.revoked_role_update_grantors.every((grantor) => grantor === login)],
  ]);
}

/**
 * Rules both environments apply after SQL 89 ran, inside the transaction: no table-level
 * UPDATE (directly or via PUBLIC or membership), the updatable set and the direct column
 * UPDATE entries exactly SQL 89's, every other table and column ACL entry and the other
 * table privileges (SELECT, INSERT, DELETE, …) unchanged.
 */
export function sql89PostconditionFailures(before, after) {
  const grantor = after?.current_user;
  // ACL lines SQL 89 may remove: UPDATE of checksops, authenticated and PUBLIC (table or column).
  const notRevokedUpdate = (line) => !new RegExp(`^(?:[a-z0-9_]+ )?(?:${SQL89_REVOKED_GRANTEES.join('|')}) UPDATE`).test(line);
  const notGranteeUpdate = (line) => !new RegExp(`^(?:[a-z0-9_]+ )?${SQL89_GRANTEE} UPDATE`).test(line);
  const otherPrivileges = (state) => SQL89_TABLE_PRIVILEGES.filter((p) => p !== 'UPDATE').map((p) => `${p}=${state?.table_privileges?.[p] === true}`);
  return sql89Failed([
    ['intended_state', after?.live_definition_sha256 === AUTHORIZED_SQL89_CHECK_INTAKE_COLUMN_UPDATE.intended_replacement_sha256],
    ['no_table_level_update', after?.table_level_update === false && after?.table_level_update_entry === false],
    ['updatable_columns_exact', sql89SameList(after?.updatable_columns, [...SQL89_COLUMNS])],
    ['column_update_entries_exact', typeof grantor === 'string' && sql89SameList(after?.column_update_entries, sql89ExpectedUpdateEntries(grantor))],
    ['other_table_privileges_unchanged', sql89SameList(otherPrivileges(after), otherPrivileges(before))],
    ['other_table_acl_unchanged', sql89SameList(
      (after?.table_acl_entries || []).filter(notRevokedUpdate),
      (before?.table_acl_entries || []).filter(notRevokedUpdate),
    ) && !(after?.table_acl_entries || []).some((line) => !notGranteeUpdate(line))],
    ['other_column_acl_unchanged', sql89SameList(
      (after?.column_acl_entries || []).filter(notRevokedUpdate),
      (before?.column_acl_entries || []).filter(notRevokedUpdate),
    )],
    // authenticated and PUBLIC hold no UPDATE on the table at all (table or column).
    ['authenticated_and_public_hold_no_update', Array.isArray(after?.revoked_role_update_entries)
      && after.revoked_role_update_entries.length === 0
      && !(after?.table_acl_entries || []).concat(after?.column_acl_entries || [])
        .some((line) => /^(?:[a-z0-9_]+ )?(?:authenticated|PUBLIC) UPDATE/.test(line))],
    // checksops' UPDATE comes only from its own column grants.
    ['update_only_from_grantee', sql89SameList(after?.update_grant_sources,
      [{ grantee: SQL89_GRANTEE, table_level: false, columns: [...SQL89_COLUMNS] }])],
    ['no_grantee_grant_option', after?.grantee_grant_option === false],
    ['table_owner_unchanged', typeof before?.table_owner === 'string' && after?.table_owner === before.table_owner],
  ]);
}

// Everything SQL 89 must leave alone, by category: schema public's ACL, every other
// relation (owner, kind, RLS, ACL), every other table's column ACLs, functions (owner,
// body, SECURITY DEFINER, config, ACL), policies, and this table apart from its ACLs
// (columns, defaults, constraints, policies, triggers, RLS flags). The ACLs of this
// table are compared entry by entry in sql89PostconditionFailures.
const SQL89_UNRELATED_SQL = Object.freeze({
  schema: `SELECT n.nspname::text || ' ' || pg_catalog.pg_get_userbyid(n.nspowner) || ' ' || COALESCE(n.nspacl::text, '') AS d
FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public'`,
  relations: `SELECT c.oid::regclass::text || ' ' || c.relkind::text || ' ' || pg_catalog.pg_get_userbyid(c.relowner) || ' '
  || c.relrowsecurity::text || ' ' || c.relforcerowsecurity::text || ' ' || COALESCE(c.relacl::text, '') AS d
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.oid <> pg_catalog.to_regclass('public.${SQL89_TABLE_NAME}') ORDER BY 1`,
  other_column_acls: `SELECT c.oid::regclass::text || '.' || a.attname || ' ' || a.attacl::text AS d
FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.oid <> pg_catalog.to_regclass('public.${SQL89_TABLE_NAME}') AND a.attnum > 0 AND a.attacl IS NOT NULL ORDER BY 1`,
  functions: `SELECT p.oid::regprocedure::text || ' ' || pg_catalog.pg_get_userbyid(p.proowner) || ' ' || md5(p.prosrc) || ' '
  || p.prosecdef::text || ' ' || COALESCE(p.proconfig::text, '') || ' ' || COALESCE(p.proacl::text, '') AS d
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'auth') ORDER BY 1`,
  policies: `SELECT c.oid::regclass::text || ' ' || pol.polname || ' ' || pol.polcmd::text || ' ' || pol.polpermissive::text || ' ' || pol.polroles::text
  || ' ' || COALESCE(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' || COALESCE(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '') AS d
FROM pg_catalog.pg_policy pol JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' ORDER BY 1`,
  check_intake_items_except_acl: `SELECT 'relation ' || pg_catalog.pg_get_userbyid(c.relowner) || ' ' || c.relrowsecurity::text || ' ' || c.relforcerowsecurity::text AS d
FROM pg_catalog.pg_class c WHERE c.oid = pg_catalog.to_regclass('public.${SQL89_TABLE_NAME}')
UNION ALL
SELECT 'column ' || a.attnum::text || ' ' || a.attname || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull::text
  || ' ' || COALESCE(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '')
FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = pg_catalog.to_regclass('public.${SQL89_TABLE_NAME}') AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL
SELECT 'constraint ' || con.conname || ' ' || pg_catalog.pg_get_constraintdef(con.oid)
FROM pg_catalog.pg_constraint con WHERE con.conrelid = pg_catalog.to_regclass('public.${SQL89_TABLE_NAME}')
UNION ALL
SELECT 'trigger ' || t.tgname || ' ' || t.tgenabled::text || ' ' || pg_catalog.pg_get_triggerdef(t.oid)
FROM pg_catalog.pg_trigger t WHERE t.tgrelid = pg_catalog.to_regclass('public.${SQL89_TABLE_NAME}') AND NOT t.tgisinternal
UNION ALL
SELECT 'index ' || pg_catalog.pg_get_indexdef(i.indexrelid)
FROM pg_catalog.pg_index i WHERE i.indrelid = pg_catalog.to_regclass('public.${SQL89_TABLE_NAME}')
ORDER BY 1`,
});

/** Hashes, by category, of everything SQL 89 must not change. */
export async function readSql89UnrelatedSnapshot(client) {
  const categories = {};
  const counts = {};
  for (const [name, sql] of Object.entries(SQL89_UNRELATED_SQL)) {
    const rows = (await client.query(sql))?.rows || [];
    categories[name] = sql89Hash(rows.map((row) => row.d).join('\n'));
    counts[name] = rows.length;
  }
  return { categories, counts, sha256: sql89Hash(JSON.stringify(categories)) };
}

/** Category names whose hash differs between two snapshots. */
export function sql89ChangedCategories(before, after) {
  return Object.keys(before?.categories || {}).filter((name) => before.categories[name] !== after?.categories?.[name]);
}

/** Readable, non-sensitive SQL 89 report (no owner or grantor names, no rows) for the executor's read-live. */
export function sql89Report(state) {
  return {
    table_level_update: state?.table_level_update === true,
    table_privileges: Object.fromEntries(Object.entries(state?.table_privileges || {}).map(([p, v]) => [p.toLowerCase(), v === true])),
    column_count: Array.isArray(state?.columns) ? state.columns.length : 0,
    updatable_column_count: Array.isArray(state?.updatable_columns) ? state.updatable_columns.length : 0,
    updatable_columns: [...(state?.updatable_columns || [])],
    sql89_column_count: SQL89_COLUMNS.length,
    columns_to_grant: [...(state?.columns_to_grant || [])],
    columns_losing_update: [...(state?.columns_losing_update || [])],
    sql89_columns_missing: [...(state?.sql89_columns_missing || [])],
    grantee_grant_option: state?.grantee_grant_option === true,
    grantee_update_grantor_count: Array.isArray(state?.grantee_update_grantors) ? state.grantee_update_grantors.length : 0,
    update_function_count: Array.isArray(state?.update_functions) ? state.update_functions.length : 0,
    unsafe_update_functions: [...(state?.unsafe_update_functions || [])],
    ingest_function_security_definer: state?.ingest_function_security_definer === true,
    authenticated_role_present: state?.authenticated_role_present === true,
    // Role names only (no owner or grantor names): where checksops' UPDATE comes from.
    grantee_member_of: [...(state?.grantee_member_of || [])],
    authenticated_members: (state?.authenticated_members || []).map((m) => ({ role: m.role, can_login: m.can_login === true })),
    other_login_authenticated_members: [...(state?.other_login_authenticated_members || [])],
    update_grant_sources: (state?.update_grant_sources || []).map((src) => ({ grantee: src.grantee, table_level: src.table_level === true, columns: [...src.columns] })),
    update_provenance: Object.fromEntries(Object.entries(state?.update_provenance || {}).map(([c, v]) => [c, [...v]])),
    other_inherited_update_roles: [...(state?.other_inherited_update_roles || [])],
    revoked_role_update_entry_count: Array.isArray(state?.revoked_role_update_entries) ? state.revoked_role_update_entries.length : 0,
    already_applied: state?.already_applied === true,
  };
}

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

// SQL 82 (aws/workflows/sql/82_homeowner_ledger_view.sql) CREATE OR REPLACEs the
// SECURITY DEFINER public.aws_public_homeowner_ledger_by_token(text); SQL 83
// (aws/workflows/sql/83_homeowner_signing_capabilities.sql) CREATE OR REPLACEs three
// sibling SECURITY DEFINER doorways. Each REVOKEs ALL FROM PUBLIC and authenticated
// and GRANTs EXECUTE TO checksops only. SQL 83 does not depend on SQL 82; the
// reviewed order is 82 then 83 (not enforced: the SQL 81 template has none).
//
// Staging already carries the Cursor branch's SQL 73 ledger view (and possibly
// SQL 74 functions with the same names), production something else, so neither
// pre-state is code-derived: expected_live_definition_sha256 stays null until a
// read-live / --inspect has recorded it in a reviewed pin change, and apply refuses
// until then. The state text has, per function in the order below: present or
// absent, how many functions carry its name (any schema), and when present its
// arguments, result type, the sha256 of pg_get_functiondef, SECURITY DEFINER,
// proconfig, whether the executor role owns it and every non-owner ACL entry.
export const HOMEOWNER_EXECUTE_GRANTEES = Object.freeze(['checksops']);
// Non-owner function ACL entries the files' REVOKE ALL ... FROM PUBLIC / authenticated
// and GRANT ... TO checksops fully replace. Any other entry would survive the apply.
export const HOMEOWNER_REPLACEABLE_ACL_ENTRIES = Object.freeze(['PUBLIC EXECUTE', 'authenticated EXECUTE', 'checksops EXECUTE']);
// Tables whose RLS / FORCE RLS the inspect reports for either migration.
export const HOMEOWNER_RLS_TABLES = Object.freeze([
  'homeowner_ledger_tokens', 'check_endorsements', 'signature_requests', 'signature_signers', 'check_intake_items', 'claims',
]);
// Status CHECK constraints and aggregate status counts the inspect reports.
export const HOMEOWNER_STATUS_TABLES = Object.freeze(['check_endorsements', 'signature_signers', 'signature_requests']);
// Cursor's legacy re-mint doorway: reported only, never dropped by SQL 82 or 83.
export const HOMEOWNER_LEGACY_FUNCTION_NAME = 'aws_public_homeowner_ledger_remint_signer';
// The raw endorsement-link pattern of Cursor SQL 73's ledger view.
export const HOMEOWNER_RAW_ENDORSE_LINK_RE = /'\/endorse\?token='\s*\|\|/;

const homeownerFunction = (name, args, argNames, rowSecurityOff) => Object.freeze({
  name,
  identity: `public.${name}(${args.map((arg) => arg.split(' ')[1]).join(', ')})`,
  arguments: args.join(', '),
  arg_names: Object.freeze([...argNames]),
  config: Object.freeze(rowSecurityOff ? ['search_path=public', 'row_security=off'] : ['search_path=public']),
});

/**
 * The functions each file creates and the columns its bodies read or write
 * (table -> columns), so the inspect can show what a live schema lacks. PL/pgSQL
 * resolves columns only at call time, so CREATE OR REPLACE succeeds without them.
 */
export const HOMEOWNER_MIGRATIONS = Object.freeze({
  sql82: Object.freeze({
    key: 'sql82',
    label: 'SQL 82',
    row_security_off: false,
    functions: Object.freeze([
      homeownerFunction('aws_public_homeowner_ledger_by_token', ['p_token text'], ['p_token'], false),
    ]),
    columns: Object.freeze({
      homeowner_ledger_tokens: Object.freeze(['id', 'tenant_id', 'claim_id', 'token', 'homeowner_email', 'homeowner_name', 'revoked_at', 'expires_at', 'last_viewed_at']),
      claims: Object.freeze(['id', 'org_id', 'claim_number', 'policyholder_address', 'loss_type', 'status', 'created_at']),
      check_intake_items: Object.freeze(['id', 'tenant_id', 'claim_id', 'amount', 'check_stage', 'check_number']),
      homeowner_ledger_events: Object.freeze(['id', 'tenant_id', 'claim_id', 'check_id', 'event_type', 'occurred_at', 'amount', 'actor_label', 'payload_json']),
      homeowner_ledger_check_uploads: Object.freeze(['token_id']),
      check_endorsements: Object.freeze(['check_id', 'tenant_id', 'payee_name', 'payee_type', 'status', 'contact_email', 'signed_at', 'request_sent_at', 'created_at']),
      disbursement_batches: Object.freeze(['id', 'tenant_id', 'check_intake_item_id']),
      disbursement_splits: Object.freeze(['batch_id', 'tenant_id', 'amount', 'status']),
      claim_disbursements: Object.freeze(['claim_id', 'amount', 'status']),
    }),
  }),
  sql83: Object.freeze({
    key: 'sql83',
    label: 'SQL 83',
    row_security_off: true,
    functions: Object.freeze([
      homeownerFunction('aws_public_homeowner_ledger_endorse_capability', ['p_token text', 'p_endorsement_id uuid'], ['p_token', 'p_endorsement_id'], true),
      homeownerFunction('aws_public_homeowner_pending_signatures', ['p_token text'], ['p_token'], true),
      homeownerFunction('aws_public_homeowner_document_sign_capability', ['p_token text', 'p_signer_id uuid'], ['p_token', 'p_signer_id'], true),
    ]),
    columns: Object.freeze({
      homeowner_ledger_tokens: Object.freeze(['token', 'tenant_id', 'claim_id', 'homeowner_email', 'homeowner_name', 'revoked_at', 'expires_at']),
      claims: Object.freeze(['id', 'org_id']),
      check_intake_items: Object.freeze(['id', 'tenant_id', 'claim_id']),
      homeowner_ledger_events: Object.freeze(['tenant_id', 'claim_id']),
      check_endorsements: Object.freeze(['id', 'check_id', 'tenant_id', 'payee_name', 'payee_type', 'status', 'token', 'contact_email', 'signed_at', 'created_at']),
      signature_requests: Object.freeze(['id', 'claim_id', 'check_intake_item_id', 'document_name', 'status', 'sent_at', 'completed_at', 'created_at']),
      signature_signers: Object.freeze(['id', 'signature_request_id', 'signer_name', 'signer_email', 'signer_type', 'signing_order', 'status', 'signed_at', 'access_token', 'expires_at']),
    }),
  }),
});

// sha256(pg_get_functiondef) on PostgreSQL 16 of each function the files create,
// re-derived from the real catalog by aws/tests/sql82-sql83-homeowner-executor.test.mjs.
export const HOMEOWNER_DEFINITION_SHA256 = Object.freeze({
  'public.aws_public_homeowner_ledger_by_token(text)': '962de3a55ffccf39baf5ac5274e50df4f137dcef0b4b9f7bdd78bf72fe355ec3',
  'public.aws_public_homeowner_ledger_endorse_capability(text, uuid)': '066754e61334f2f988a9e5ac28fd06f840bc28cb3890a5d961c1a20d50cccbe7',
  'public.aws_public_homeowner_pending_signatures(text)': '3b632929f4b72e168ef4b42951d6845d5dbb751fa8ced92860697dda782fc5cb',
  'public.aws_public_homeowner_document_sign_capability(text, uuid)': 'a45f3bfcab4f6a8a686a2e1374b50dda5fcf28731ec18bbf935ef4839c221786',
});

/** `states[identity]` as readHomeownerState builds it; one block per function, in file order. */
export function homeownerStateText(key, states = {}) {
  const spec = HOMEOWNER_MIGRATIONS[key];
  if (!spec) return null;
  const lines = [`migration ${key}`];
  for (const fn of spec.functions) {
    const state = states[fn.identity] || {};
    const id = fn.identity;
    if (state.exists !== true) {
      lines.push(`function ${id}: absent`, `functions named ${fn.name}: ${Number(state.overload_count) || 0}`);
      continue;
    }
    lines.push(
      `function ${id}: present`,
      `functions named ${fn.name}: ${Number(state.overload_count) || 0}`,
      `${id} arguments: ${String(state.arguments ?? '')}`,
      `${id} result: ${String(state.result ?? '')}`,
      `${id} definition sha256 ${SHA256_HEX_RE.test(String(state.definition_sha256 || '')) ? state.definition_sha256 : 'unreadable'}`,
      `${id} security definer: ${state.security_definer === true ? 'on' : 'off'}`,
      `${id} config: ${(state.config || []).join(',') || '-'}`,
      `${id} owner: ${state.owner_is_executor === true ? 'executor role' : 'another role'}`,
      ...(state.acl || []).map((entry) => `${id} acl ${entry.grantee} ${entry.privilege_type}${entry.is_grantable === true ? ' with grant option' : ''}`).sort(),
    );
  }
  return lines.join('\n');
}

/** What each file leaves: the reviewed functions, owned by the executor role, EXECUTE for checksops only. */
export function homeownerAppliedStates(key) {
  const spec = HOMEOWNER_MIGRATIONS[key];
  return Object.fromEntries(spec.functions.map((fn) => [fn.identity, {
    exists: true,
    overload_count: 1,
    arguments: fn.arguments,
    result: 'jsonb',
    definition_sha256: HOMEOWNER_DEFINITION_SHA256[fn.identity],
    security_definer: true,
    config: [...fn.config],
    owner_is_executor: true,
    acl: HOMEOWNER_EXECUTE_GRANTEES.map((grantee) => ({ grantee, privilege_type: 'EXECUTE', is_grantable: false })),
  }]));
}

export const AUTHORIZED_SQL82_HOMEOWNER_LEDGER_VIEW = Object.freeze({
  filename: 'aws/workflows/sql/82_homeowner_ledger_view.sql',
  migration_id: '82_homeowner_ledger_view',
  migration: 'sql82',
  // The commit that authored the current file bytes (PR #989).
  commit: '4b1fe50d1f2654f7f4ea82366eff5bbd1a067621',
  source_sha256: '1db68ee9aee1c91c146e7f70c39bef7cc015eb38f6f436bfdfd0bc49f360a934',
  // Recorded, not code-derived: live_definition_sha256 from the guarded staging SQL
  // executor read-live of sql82-homeowner-ledger-view, run 48 (job 116757174929),
  // 2026-10-16. Staging carries Cursor SQL 73's ledger view (raw_endorse_token_link
  // true); precondition_failures [], row_security_off_supported true,
  // owner_is_executor true, non-owner ACL checksops EXECUTE only.
  expected_live_definition_sha256: '452f8f3d2411e0c3772fdf92c14e1b85785823dcb8d6567d01f1908dc9a8d783',
  // Code-derived: sha256(homeownerStateText('sql82', homeownerAppliedStates('sql82'))),
  // re-derived from the real catalog by aws/tests/sql82-sql83-homeowner-executor.test.mjs.
  intended_replacement_sha256: '04e41eedb372334169feb32bc65991a3ce99558b84e91b27e22a6501be641e37',
  function_identities: Object.freeze(HOMEOWNER_MIGRATIONS.sql82.functions.map((fn) => fn.identity)),
});
export const AUTHORIZED_SQL83_HOMEOWNER_SIGNING_CAPABILITIES = Object.freeze({
  filename: 'aws/workflows/sql/83_homeowner_signing_capabilities.sql',
  migration_id: '83_homeowner_signing_capabilities',
  migration: 'sql83',
  // The commit that authored the current file bytes (PR #989).
  commit: '4b1fe50d1f2654f7f4ea82366eff5bbd1a067621',
  source_sha256: '8443a3e7b2c1f7a61d621e2e5b7fb3dcd94beb769fb16c2d2b49f867aa5149af',
  // Recorded, not code-derived: live_definition_sha256 from the guarded staging SQL
  // executor read-live of sql83-homeowner-signing-capabilities, run 49
  // (job 116757504435), 2026-10-16. Staging carries the three functions from Cursor
  // SQL 74; precondition_failures [], row_security_off_supported true,
  // owner_is_executor true, non-owner ACL checksops EXECUTE only.
  expected_live_definition_sha256: 'e85f64fa17ff2146d1aa3a603c83580c8c369dd2b49d252dfc8fd45453f4a21f',
  // Code-derived: sha256(homeownerStateText('sql83', homeownerAppliedStates('sql83'))).
  intended_replacement_sha256: '78da421900f4e3d0af7110ee2b1a47f1498599a59a6dfa07953c59ad56b27163',
  function_identities: Object.freeze(HOMEOWNER_MIGRATIONS.sql83.functions.map((fn) => fn.identity)),
});

// SQL 84 (aws/workflows/sql/84_mortgage_return_to_queue.sql), SQL 85
// (aws/workflows/sql/85_mortgage_compensation_adjust.sql) and SQL 86
// (aws/workflows/sql/86_mortgage_compensation_owner_only.sql): Mortgage Ops Return
// to Queue, compensation Adjust and the platform-owner-only compensation helper, all
// forward migrations on top of the Cursor SQL 47 compensation ledger. Independent of
// each other (no predecessor check); the reviewed order is 84, 85, 86.
//
// Neither staging's nor production's pre-state is code-derived (staging may carry
// Cursor SQL 48 / SQL 49 bodies of the same names, production may lack SQL 47), so
// expected_live_definition_sha256 stays null until a read-live / --inspect has
// recorded it in a reviewed pin change, and apply refuses until then. The state text
// (mortgageStateText) is environment-independent: per function present or absent,
// how many functions carry its name, and when present its arguments, result,
// definition sha256, SECURITY DEFINER, proconfig, whether the executor role owns it
// and its non-owner ACL entries; plus each migration's own tables, columns, indexes
// and constraints (never owner names, never row data).
export const MORTGAGE_TARGET_CONFIG = Object.freeze(['search_path=public', 'row_security=off']);
// Non-owner function ACL entries a file's REVOKE ALL ... FROM PUBLIC (and, for SQL 86's
// earn function, FROM checksops / authenticated) fully replaces.
export const MORTGAGE_REPLACEABLE_ACL_ENTRIES = Object.freeze(['PUBLIC EXECUTE', 'authenticated EXECUTE', 'checksops EXECUTE']);
// SQL 84's GATE 0: an existing per-check unique index on check_billing_events counts
// only with exactly one of these predicates (PostgreSQL's normalized text).
export const MORTGAGE_PER_CHECK_PREDICATES = Object.freeze({
  staging: "((event_type = ANY (ARRAY['mortgage_ops_initial'::text, 'mortgage_ops_additional_check'::text])) AND (check_intake_item_id IS NOT NULL))",
  fallback: "((event_type = ANY (ARRAY['mortgage_ops_initial'::text, 'mortgage_ops_additional_check'::text])) AND (status IS DISTINCT FROM 'voided'::text) AND (check_intake_item_id IS NOT NULL))",
});
export const MORTGAGE_FALLBACK_INDEX = 'check_billing_events_one_mortgage_ops_per_check';
export const MORTGAGE_AUDIT_TABLE = 'mortgage_ops_request_audit';

const mortgageFunction = ({
  name, key = name, args, argNames = null, result, language = 'plpgsql', volatility = null, retset = false, config = MORTGAGE_TARGET_CONFIG,
  role = 'target', grantees = null,
}) => Object.freeze({
  name,
  // The report key (unique per migration; SQL 85's two signatures share a name).
  key,
  identity: `public.${name}(${args.map((arg) => arg.split(' ')[1]).join(', ')})`,
  arguments: args.join(', '),
  // proargnames: the parameters, then (RETURNS TABLE) the output columns.
  arg_names: Object.freeze(argNames || args.map((arg) => arg.split(' ')[0])),
  result,
  language,
  volatility,
  retset,
  config: Object.freeze([...config]),
  // target: CREATE OR REPLACEd by the file; dropped: DROPped by it; acl_only: only its
  // ACL is replaced; referenced: read (owner) only.
  role,
  // Non-owner EXECUTE grantees after the apply (null: the file does not set the ACL).
  grantees: grantees ? Object.freeze([...grantees]) : null,
});

const SQL47_REQUIRED = (extra = []) => Object.freeze([
  'public.mortgage_agent_compensation_entries',
  'public.mortgage_agent_compensation_exclusions',
  'public.mortgage_agent_compensation_audit',
  ...extra,
]);

/**
 * The objects each file needs (its own sql47_prerequisite_missing list, plus the
 * roles), the functions it touches and the columns its bodies read (table ->
 * columns), so the inspect can show what a live schema lacks.
 */
export const MORTGAGE_MIGRATIONS = Object.freeze({
  sql84: Object.freeze({
    key: 'sql84',
    label: 'SQL 84',
    prerequisites: Object.freeze([
      ...SQL47_REQUIRED(['public.mortgage_handling_requests', 'public.check_billing_events']),
      'public.is_platform_owner()',
      'auth.uid()',
      'role checksops',
      'role authenticated',
    ]),
    functions: Object.freeze([
      mortgageFunction({
        name: 'return_mortgage_handling_request_to_queue',
        args: ['p_request_id uuid', 'p_reason text'],
        result: 'public.mortgage_handling_requests',
        grantees: ['authenticated', 'checksops'],
      }),
    ]),
    columns: Object.freeze({
      mortgage_handling_requests: Object.freeze(['id', 'tenant_id', 'check_intake_item_id', 'claim_id', 'status', 'assigned_employee_id', 'accepted_at', 'completed_at', 'updated_at']),
      check_billing_events: Object.freeze(['id', 'tenant_id', 'check_intake_item_id', 'event_type', 'status', 'created_at']),
      mortgage_agent_compensation_exclusions: Object.freeze(['mortgage_request_id']),
      mortgage_agent_compensation_entries: Object.freeze(['mortgage_request_id', 'parent_entry_id', 'status']),
      mortgage_agent_compensation_audit: Object.freeze(['actor_id', 'action', 'payload']),
    }),
    // Relations the file creates (skipped by the unrelated-catalog snapshot).
    new_relations: Object.freeze([`public.${MORTGAGE_AUDIT_TABLE}`, `public.${MORTGAGE_FALLBACK_INDEX}`]),
    altered_tables: Object.freeze([]),
  }),
  sql85: Object.freeze({
    key: 'sql85',
    label: 'SQL 85',
    prerequisites: Object.freeze([
      ...SQL47_REQUIRED(['public.mortgage_agent_compensation_batches', 'public.user_roles']),
      'public.is_platform_owner()',
      'public.aws_is_active_mortgage_agent(uuid)',
      'auth.uid()',
      'role checksops',
      'role authenticated',
    ]),
    functions: Object.freeze([
      mortgageFunction({
        name: 'adjust_mortgage_agent_compensation',
        args: ['p_parent_entry_id uuid', 'p_amount_cents integer', 'p_reason text', 'p_counterparty_agent_id uuid DEFAULT NULL::uuid', 'p_pay_period text DEFAULT NULL::text', 'p_idempotency_key text DEFAULT NULL::text'],
        result: 'jsonb',
        grantees: ['authenticated', 'checksops'],
      }),
      // The Cursor SQL 49 (and first SQL 85) five-argument body, which the file drops.
      mortgageFunction({
        name: 'adjust_mortgage_agent_compensation',
        key: 'adjust_mortgage_agent_compensation_five_arg',
        args: ['p_parent_entry_id uuid', 'p_amount_cents integer', 'p_reason text', 'p_counterparty_agent_id uuid DEFAULT NULL::uuid', 'p_pay_period text DEFAULT NULL::text'],
        result: 'jsonb',
        role: 'dropped',
      }),
    ]),
    columns: Object.freeze({
      mortgage_agent_compensation_entries: Object.freeze(['id', 'agent_user_id', 'mortgage_request_id', 'check_intake_item_id', 'claim_id', 'tenant_id', 'classification', 'amount_cents', 'tenant_billing_event_id', 'tenant_billing_event_type', 'tenant_billing_amount_cents', 'accepted_at', 'completed_at', 'earned_at', 'pay_period', 'status', 'parent_entry_id']),
      mortgage_agent_compensation_batches: Object.freeze(['id', 'pay_period', 'agent_user_id', 'action', 'note', 'created_by']),
      mortgage_agent_compensation_audit: Object.freeze(['entry_id', 'batch_id', 'actor_id', 'action', 'from_status', 'to_status', 'payload']),
      mortgage_agent_compensation_exclusions: Object.freeze(['mortgage_request_id']),
    }),
    new_relations: Object.freeze([
      'public.mortgage_agent_compensation_entries_parent_idx',
      'public.mortgage_agent_compensation_batches_adjust_idem_uidx',
    ]),
    // Tables the file ALTERs: the unrelated snapshot skips them whole and re-reads
    // everything about them except the reviewed changes.
    altered_tables: Object.freeze(['public.mortgage_agent_compensation_entries', 'public.mortgage_agent_compensation_batches']),
    added_columns: Object.freeze({
      'public.mortgage_agent_compensation_entries': 'adjustment_reason',
      'public.mortgage_agent_compensation_batches': 'idempotency_key',
    }),
    replaced_constraints: Object.freeze(['public.mortgage_agent_compensation_batches.mortgage_agent_compensation_batches_action_check']),
  }),
  sql86: Object.freeze({
    key: 'sql86',
    label: 'SQL 86',
    prerequisites: Object.freeze([
      'public.mortgage_agent_compensation_entries',
      'public.aws_can_admin_mortgage_agent_compensation()',
      'public.earn_mortgage_agent_compensation(uuid)',
      'public.tg_earn_mortgage_agent_compensation()',
      'public.mortgage_agent_compensation_reconciliation(text)',
      'role checksops',
      'role authenticated',
      'public.is_platform_owner()',
    ]),
    functions: Object.freeze([
      mortgageFunction({
        name: 'aws_can_admin_mortgage_agent_compensation',
        args: [],
        result: 'boolean',
        language: 'sql',
        volatility: 'STABLE',
      }),
      mortgageFunction({
        name: 'mortgage_agent_compensation_reconciliation',
        args: ['p_pay_period text DEFAULT NULL::text'],
        argNames: ['p_pay_period', 'anomaly_type', 'mortgage_request_id', 'compensation_entry_id', 'tenant_billing_event_id', 'detail'],
        result: 'TABLE(anomaly_type text, mortgage_request_id uuid, compensation_entry_id uuid, tenant_billing_event_id uuid, detail jsonb)',
        volatility: 'STABLE',
        retset: true,
      }),
      mortgageFunction({
        name: 'earn_mortgage_agent_compensation',
        args: ['p_request_id uuid'],
        result: 'public.mortgage_agent_compensation_entries',
        role: 'acl_only',
        grantees: [],
      }),
      mortgageFunction({
        name: 'tg_earn_mortgage_agent_compensation',
        args: [],
        result: 'trigger',
        role: 'referenced',
      }),
    ]),
    columns: Object.freeze({
      mortgage_handling_requests: Object.freeze(['id', 'status', 'completed_at', 'assigned_employee_id', 'accepted_at', 'check_intake_item_id']),
      mortgage_agent_compensation_exclusions: Object.freeze(['mortgage_request_id']),
      mortgage_agent_compensation_entries: Object.freeze(['id', 'parent_entry_id', 'status', 'pay_period', 'mortgage_request_id', 'tenant_billing_event_id', 'amount_cents', 'classification', 'tenant_billing_event_type', 'tenant_billing_amount_cents']),
      check_billing_events: Object.freeze(['id', 'check_intake_item_id', 'mortgage_request_id', 'event_type', 'unit_price_cents', 'status']),
    }),
    new_relations: Object.freeze([]),
    altered_tables: Object.freeze([]),
  }),
  // SQL 87 (aws/workflows/sql/87_resolve_check_case_tenant_scope.sql) is not a Mortgage
  // Ops migration; it reuses this engine because it has SQL 86's shape: one function
  // CREATE OR REPLACEd with its ACL left to the owner, behind an owner guard over the
  // SECURITY DEFINER trigger functions that call it.
  sql87: Object.freeze({
    key: 'sql87',
    label: 'SQL 87',
    prerequisites: Object.freeze([
      'public.check_cases',
      'public.claims',
      'public.check_intake_items',
      'public.loss_draft_tracking',
      'public.resolve_check_case(uuid, uuid, uuid, text, text, text, text)',
      'public.tg_check_intake_assign_case()',
      'public.tg_loss_draft_assign_case()',
      'role checksops',
      'role authenticated',
    ]),
    functions: Object.freeze([
      mortgageFunction({
        name: 'resolve_check_case',
        args: [
          '_tenant_id uuid',
          '_claim_id uuid DEFAULT NULL::uuid',
          '_external_claim_id uuid DEFAULT NULL::uuid',
          '_claim_number text DEFAULT NULL::text',
          '_insured_name text DEFAULT NULL::text',
          '_property_address text DEFAULT NULL::text',
          '_carrier_name text DEFAULT NULL::text',
        ],
        result: 'uuid',
        config: ['search_path=public'],
        grantees: [],
      }),
      mortgageFunction({ name: 'tg_check_intake_assign_case', args: [], result: 'trigger', config: ['search_path=public'], role: 'referenced' }),
      mortgageFunction({ name: 'tg_loss_draft_assign_case', args: [], result: 'trigger', config: ['search_path=public'], role: 'referenced' }),
    ]),
    columns: Object.freeze({
      check_cases: Object.freeze(['id', 'tenant_id', 'external_system', 'external_claim_id', 'claim_number', 'insured_name', 'insured_email', 'insured_phone', 'property_address', 'carrier_name', 'policy_number', 'mortgage_company_id', 'loan_number', 'loss_date']),
      claims: Object.freeze(['id', 'org_id', 'claim_number', 'policyholder_name', 'policyholder_email', 'policyholder_phone', 'policyholder_address', 'insurance_company', 'policy_number', 'mortgage_company_id', 'loan_number', 'loss_date']),
      check_intake_items: Object.freeze(['id', 'tenant_id', 'claim_id', 'case_id', 'freedom_claim_id', 'freedom_claim_number', 'detected_claim_number', 'payee_line', 'property_address', 'carrier_name']),
      loss_draft_tracking: Object.freeze(['case_id', 'claim_id', 'check_intake_item_id']),
    }),
    new_relations: Object.freeze([]),
    altered_tables: Object.freeze([]),
    // The function the referenced trigger functions must share an owner with; their
    // SECURITY DEFINER flag is part of the fingerprint (the revoke relies on it).
    owner_anchor: 'resolve_check_case',
    referenced_security_definer: true,
    // Non-owner ACL entries the file's revokes fully replace (Supabase's anon and
    // service_role included, where they exist).
    replaceable_acl: Object.freeze(['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'checksops EXECUTE', 'service_role EXECUTE']),
    // The API roles whose EXECUTE the file revokes, and that the owner must not be or belong to.
    api_roles: Object.freeze(['checksops', 'authenticated', 'anon', 'service_role']),
  }),
  // SQL 88 (aws/workflows/sql/88_claim_id_assign_case_tenant_scope.sql), on the same
  // engine as SQL 87: the trigger function tg_claim_id_assign_case() CREATE OR REPLACEd
  // (links only a case of the row's tenant for a claim of that tenant) with EXECUTE left
  // to its owner, behind an owner guard over the SQL 87 case helper and the two other
  // SECURITY DEFINER case trigger functions. The inspect also counts (never lists) the
  // existing cross-tenant links (cross_tenant_links; report only, never a precondition).
  sql88: Object.freeze({
    key: 'sql88',
    label: 'SQL 88',
    prerequisites: Object.freeze([
      'public.check_cases',
      'public.claims',
      'public.check_intake_items',
      'public.homeowner_ledger_events',
      'public.homeowner_ledger_tokens',
      'public.homeowner_ledger_check_uploads',
      'public.mortgage_releases',
      'public.claim_check_mortgage_draws',
      'public.signature_requests',
      'public.tg_claim_id_assign_case()',
      'public.resolve_check_case(uuid, uuid, uuid, text, text, text, text)',
      'public.tg_check_intake_assign_case()',
      'public.tg_loss_draft_assign_case()',
      'role checksops',
      'role authenticated',
    ]),
    functions: Object.freeze([
      mortgageFunction({ name: 'tg_claim_id_assign_case', args: [], result: 'trigger', config: ['search_path=public'], grantees: [] }),
      mortgageFunction({
        name: 'resolve_check_case',
        args: [
          '_tenant_id uuid',
          '_claim_id uuid DEFAULT NULL::uuid',
          '_external_claim_id uuid DEFAULT NULL::uuid',
          '_claim_number text DEFAULT NULL::text',
          '_insured_name text DEFAULT NULL::text',
          '_property_address text DEFAULT NULL::text',
          '_carrier_name text DEFAULT NULL::text',
        ],
        result: 'uuid',
        config: ['search_path=public'],
        role: 'referenced',
      }),
      mortgageFunction({ name: 'tg_check_intake_assign_case', args: [], result: 'trigger', config: ['search_path=public'], role: 'referenced' }),
      mortgageFunction({ name: 'tg_loss_draft_assign_case', args: [], result: 'trigger', config: ['search_path=public'], role: 'referenced' }),
    ]),
    columns: Object.freeze({
      check_cases: Object.freeze(['id', 'tenant_id', 'external_system', 'external_claim_id']),
      claims: Object.freeze(['id', 'org_id']),
      check_intake_items: Object.freeze(['id', 'tenant_id', 'claim_id', 'case_id']),
      loss_draft_tracking: Object.freeze(['case_id', 'claim_id', 'check_intake_item_id']),
      homeowner_ledger_events: Object.freeze(['tenant_id', 'claim_id', 'case_id']),
      homeowner_ledger_tokens: Object.freeze(['tenant_id', 'claim_id', 'case_id']),
      homeowner_ledger_check_uploads: Object.freeze(['tenant_id', 'claim_id', 'case_id']),
      mortgage_releases: Object.freeze(['claim_id', 'case_id']),
      claim_check_mortgage_draws: Object.freeze(['claim_id', 'case_id']),
      signature_requests: Object.freeze(['claim_id', 'case_id']),
    }),
    new_relations: Object.freeze([]),
    altered_tables: Object.freeze([]),
    owner_anchor: 'tg_claim_id_assign_case',
    referenced_security_definer: true,
    replaceable_acl: Object.freeze(['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'checksops EXECUTE', 'service_role EXECUTE']),
    api_roles: Object.freeze(['checksops', 'authenticated', 'anon', 'service_role']),
  }),
});

// sha256(pg_get_functiondef) on PostgreSQL 16 of each function the files create,
// re-derived from the real catalog by aws/tests/sql84-sql86-mortgage-executor.test.mjs
// (SQL 87's by aws/tests/sql87-resolve-check-case-executor.test.mjs, SQL 88's by
// aws/tests/sql88-claim-id-assign-case-executor.test.mjs).
export const MORTGAGE_DEFINITION_SHA256 = Object.freeze({
  'public.tg_claim_id_assign_case()': '93bd9cfab9d33aa18aaed94d67d99622b179e5ffbc27fdc320e98ac47b81f9ee',
  'public.resolve_check_case(uuid, uuid, uuid, text, text, text, text)': '687fecf6daec13618c2c0f371e9c249ac6d9423891612ab1976c1cee1f3bcec1',
  'public.return_mortgage_handling_request_to_queue(uuid, text)': '51069c48dcf0511a58dc50dcda0e03c798b4c6f2ec689461ae5d4e047534899f',
  'public.adjust_mortgage_agent_compensation(uuid, integer, text, uuid, text, text)': 'a8fa66f06698b523e222f8c14543d251a90122cbeeb43feefe906cce3db5ae8b',
  'public.aws_can_admin_mortgage_agent_compensation()': 'b5bc3c548704351bdf502befd5cd7eaafbcf8566687ebc2164bee0c030e1884d',
  'public.mortgage_agent_compensation_reconciliation(text)': '427f707262e9f57b4ba864f6e9a1492cc363b890e642bdfa89d5e406c654a344',
});
// The same for the bodies the files replace or drop, so the inspect can label them:
// Cursor SQL 48 / SQL 49 ('cursor_original') and SQL 47 ('ledger_original'). Report only.
export const MORTGAGE_KNOWN_DEFINITION_SHA256 = Object.freeze({
  'public.return_mortgage_handling_request_to_queue(uuid, text)': Object.freeze({ cursor_original: '9f6811a71033b22acf2add10a000c6d6154d756f3e6a6dc785e6ed63c4e5a114' }),
  'public.adjust_mortgage_agent_compensation(uuid, integer, text, uuid, text)': Object.freeze({ cursor_original: 'e05bce276d9c6969fd69055b853467a7ec3fd970800d47604bf1ca4b7e541fd9' }),
  'public.aws_can_admin_mortgage_agent_compensation()': Object.freeze({ ledger_original: 'ea033ce8511dff0858ca5dce65e690025488ecb36524e4140f85d6808e92386a' }),
  'public.mortgage_agent_compensation_reconciliation(text)': Object.freeze({ ledger_original: 'edd48e8286d99a9a848917cde0a0e3ec3f92e53775127012aa7e390006721c3a' }),
  'public.earn_mortgage_agent_compensation(uuid)': Object.freeze({ ledger_original: 'ffdc445e4d88011890887ab9b2c386cad29f006ecff316efff4a7c3f9740b293' }),
  'public.tg_earn_mortgage_agent_compensation()': Object.freeze({ ledger_original: 'ca557bd5473fca4154bc4ae10af94e491ecb1891eb966d38755ac93a8a583c18' }),
  // Supabase migration 20260826125804's bodies ('case_original').
  // SQL 88 also labels SQL 87's helper body ('tenant_scoped').
  'public.resolve_check_case(uuid, uuid, uuid, text, text, text, text)': Object.freeze({ case_original: '461d583bd6a5c741ab3bec9b54caf181df644b7fd3198e664869e9cd3aec74fa', tenant_scoped: '687fecf6daec13618c2c0f371e9c249ac6d9423891612ab1976c1cee1f3bcec1' }),
  'public.tg_claim_id_assign_case()': Object.freeze({ case_original: 'b03ce50dd044b85b837fb0f003098b5d2c5deabddf710ca1bb885e3e1e3f69e3' }),
  'public.tg_check_intake_assign_case()': Object.freeze({ case_original: 'dbe18e99d41c8635404b720f1341c6247e03cfecb2a202e6d60a56eb38f9feb6' }),
  'public.tg_loss_draft_assign_case()': Object.freeze({ case_original: '90fe5f87b02159917ad4641c789bb007cea240ff842ea8f8dd84bb6b2da64f06' }),
});

/** 'absent' / 'intended' / 'cursor_original' / 'ledger_original' / 'other' for one function row. */
export function mortgageFunctionLabel(fn, state = {}) {
  if (state.exists !== true) return 'absent';
  const hash = String(state.definition_sha256 || '');
  if (fn.role === 'target' && hash === MORTGAGE_DEFINITION_SHA256[fn.identity]) return 'intended';
  const known = MORTGAGE_KNOWN_DEFINITION_SHA256[fn.identity] || {};
  return Object.keys(known).find((label) => known[label] === hash) || 'other';
}

const aclText = (entry) => `${entry.grantee} ${entry.privilege_type}${entry.is_grantable === true ? ' with grant option' : ''}`;
/** The function a migration's referenced functions must share an owner with (SQL 86's earn, SQL 87's helper). */
export function mortgageOwnerAnchor(spec = {}) {
  return (spec.functions || []).find((fn) => (spec.owner_anchor ? fn.key === spec.owner_anchor : fn.role === 'acl_only')) || null;
}
/** Non-owner function ACL entries the migration's REVOKEs fully replace. */
export const mortgageReplaceableAcl = (spec = {}) => spec.replaceable_acl || MORTGAGE_REPLACEABLE_ACL_ENTRIES;
const hashOrUnreadable = (value) => (SHA256_HEX_RE.test(String(value || '')) ? value : 'unreadable');

function mortgageFunctionLines(fn, state = {}, states = {}, spec = {}) {
  const id = fn.identity;
  if (state.exists !== true) {
    const lines = [`function ${id}: absent`];
    if (fn.role === 'target') lines.push(`functions named ${fn.name}: ${Number(state.overload_count) || 0}`);
    return lines;
  }
  const owner = `${id} owner: ${state.owner_is_executor === true ? 'executor role' : 'another role'}`;
  const acl = (state.acl || []).map((entry) => `${id} acl ${aclText(entry)}`).sort();
  if (fn.role === 'dropped') return [`function ${id}: present`, `${id} definition sha256 ${hashOrUnreadable(state.definition_sha256)}`, owner];
  if (fn.role === 'acl_only') return [`function ${id}: present`, owner, ...acl];
  if (fn.role === 'referenced') {
    const earn = mortgageOwnerAnchor(spec);
    const same = earn && states[earn.identity]?.exists === true && state.owner_oid != null && state.owner_oid === states[earn.identity].owner_oid;
    return [
      `function ${id}: present`,
      `${id} owner same as ${earn ? earn.name : 'none'}: ${same ? 'yes' : 'no'}`,
      // SQL 87: the revoke relies on the trigger functions running as their owner.
      ...(spec.referenced_security_definer ? [`${id} security definer: ${state.security_definer === true ? 'on' : 'off'}`] : []),
    ];
  }
  return [
    `function ${id}: present`,
    `functions named ${fn.name}: ${Number(state.overload_count) || 0}`,
    `${id} arguments: ${String(state.arguments ?? '')}`,
    `${id} result: ${String(state.result ?? '')}`,
    `${id} definition sha256 ${hashOrUnreadable(state.definition_sha256)}`,
    `${id} security definer: ${state.security_definer === true ? 'on' : 'off'}`,
    `${id} config: ${(state.config || []).join(',') || '-'}`,
    owner,
    // SQL 86 leaves its two replaced functions' ACLs alone; the apply compares them before and after.
    ...(fn.grantees ? acl : []),
  ];
}

const tableLines = (name, table) => {
  if (!table || table.present !== true) return [`table ${name}: absent`];
  return [
    `table ${name}: present`,
    ...(table.columns || []).map((col) => `${name} column ${col.name} ${col.type}${col.not_null ? ' not null' : ''}${col.default != null ? ` default ${col.default}` : ''}`),
    `${name} rls: ${table.rls_enabled ? 'enabled' : 'disabled'}${table.rls_forced ? ' forced' : ''}`,
    `${name} owner: ${table.owner_is_executor === true ? 'executor role' : 'another role'}`,
    ...(table.acl || []).map((entry) => `${name} acl ${aclText(entry)}`).sort(),
    ...(table.policies || []).map((pol) => `${name} policy ${pol.name} ${pol.cmd}${pol.permissive === false ? ' restrictive' : ''} to ${(pol.roles || []).join(',')} using ${pol.qual ?? '-'} check ${pol.with_check ?? '-'}`).sort(),
    ...(table.indexes || []).map((idx) => `${name} index ${idx.definition}${idx.valid === false ? ' invalid' : ''}`).sort(),
  ];
};
const objectLine = (kind, name, value) => `${kind} ${name}: ${value == null ? 'absent' : value}`;

/**
 * The fingerprint text: `state.functions[identity]` as readMortgageState builds it,
 * plus each migration's own objects (`state.objects`).
 */
export function mortgageStateText(key, state = {}) {
  const spec = MORTGAGE_MIGRATIONS[key];
  if (!spec) return null;
  const functions = state.functions || {};
  const objects = state.objects || {};
  const lines = [`migration ${key}`];
  for (const fn of spec.functions) lines.push(...mortgageFunctionLines(fn, functions[fn.identity] || {}, functions, spec));
  if (key === 'sql84') {
    lines.push(...tableLines(`public.${MORTGAGE_AUDIT_TABLE}`, objects.audit_table));
    lines.push(`check_billing_events per-check unique: ${objects.per_check_unique_present === true ? 'present' : 'absent'}`);
  }
  if (key === 'sql85') {
    for (const [table, column] of Object.entries(spec.added_columns)) lines.push(objectLine('column', `${table}.${column}`, objects.columns?.[`${table}.${column}`]));
    for (const index of spec.new_relations) {
      const row = objects.indexes?.[index];
      lines.push(objectLine('index', index, row ? `${row.definition}${row.valid === false ? ' invalid' : ''}` : null));
    }
    for (const constraint of spec.replaced_constraints) lines.push(objectLine('constraint', constraint, objects.constraints?.[constraint]));
  }
  return lines.join('\n');
}

const AUDIT_TABLE_COLUMNS = Object.freeze([
  ['id', 'uuid', true, 'gen_random_uuid()'],
  ['mortgage_request_id', 'uuid', true, null],
  ['actor_id', 'uuid', false, null],
  ['action', 'text', true, null],
  ['previous_agent_id', 'uuid', false, null],
  ['reason', 'text', true, null],
  ['from_status', 'text', false, null],
  ['to_status', 'text', false, null],
  ['accepted_at_preserved', 'timestamp with time zone', false, null],
  ['tenant_billing_event_id', 'uuid', false, null],
  ['payload', 'jsonb', true, "'{}'::jsonb"],
  ['created_at', 'timestamp with time zone', true, 'now()'],
].map(([name, type, notNull, def]) => Object.freeze({ name, type, not_null: notNull, default: def })));

/** The audit table exactly as SQL 84 leaves it (columns, RLS, grants, policy, indexes). */
export const MORTGAGE_AUDIT_TABLE_INTENDED = Object.freeze({
  present: true,
  columns: AUDIT_TABLE_COLUMNS,
  rls_enabled: true,
  rls_forced: false,
  owner_is_executor: true,
  acl: Object.freeze(['authenticated', 'checksops'].map((grantee) => Object.freeze({ grantee, privilege_type: 'SELECT', is_grantable: false }))),
  policies: Object.freeze([Object.freeze({
    name: 'aws_select_mortgage_ops_request_audit',
    cmd: 'r',
    permissive: true,
    roles: Object.freeze(['authenticated', 'checksops']),
    qual: 'COALESCE(public.is_platform_owner(), false)',
    with_check: null,
  })]),
  indexes: Object.freeze([
    Object.freeze({ name: 'mortgage_ops_request_audit_pkey', definition: 'CREATE UNIQUE INDEX mortgage_ops_request_audit_pkey ON public.mortgage_ops_request_audit USING btree (id)', valid: true }),
    Object.freeze({ name: 'mortgage_ops_request_audit_request_idx', definition: 'CREATE INDEX mortgage_ops_request_audit_request_idx ON public.mortgage_ops_request_audit USING btree (mortgage_request_id, created_at DESC)', valid: true }),
  ]),
});
/** SQL 85's own columns, indexes and constraint as the file leaves them. */
export const MORTGAGE_SQL85_OBJECTS_INTENDED = Object.freeze({
  columns: Object.freeze({
    'public.mortgage_agent_compensation_entries.adjustment_reason': 'text',
    'public.mortgage_agent_compensation_batches.idempotency_key': 'text',
  }),
  indexes: Object.freeze({
    'public.mortgage_agent_compensation_entries_parent_idx': Object.freeze({ definition: 'CREATE INDEX mortgage_agent_compensation_entries_parent_idx ON public.mortgage_agent_compensation_entries USING btree (parent_entry_id) WHERE (parent_entry_id IS NOT NULL)', valid: true }),
    'public.mortgage_agent_compensation_batches_adjust_idem_uidx': Object.freeze({ definition: "CREATE UNIQUE INDEX mortgage_agent_compensation_batches_adjust_idem_uidx ON public.mortgage_agent_compensation_batches USING btree (idempotency_key) WHERE ((action = 'adjust'::text) AND (idempotency_key IS NOT NULL))", valid: true }),
  }),
  constraints: Object.freeze({
    'public.mortgage_agent_compensation_batches.mortgage_agent_compensation_batches_action_check': "CHECK ((action = ANY (ARRAY['approve'::text, 'pay'::text, 'adjust'::text])))",
  }),
});

/** What each file leaves, in the shape mortgageStateText reads. */
export function mortgageAppliedStates(key) {
  const spec = MORTGAGE_MIGRATIONS[key];
  const functions = {};
  for (const fn of spec.functions) {
    if (fn.role === 'dropped') {
      functions[fn.identity] = { exists: false, overload_count: 0 };
    } else if (fn.role === 'acl_only') {
      functions[fn.identity] = { exists: true, owner_is_executor: true, acl: [] };
    } else if (fn.role === 'referenced') {
      functions[fn.identity] = { exists: true, owner_oid: 1, ...(spec.referenced_security_definer ? { security_definer: true } : {}) };
    } else {
      functions[fn.identity] = {
        exists: true,
        overload_count: 1,
        arguments: fn.arguments,
        result: fn.result,
        definition_sha256: MORTGAGE_DEFINITION_SHA256[fn.identity],
        security_definer: true,
        config: [...fn.config],
        owner_is_executor: true,
        acl: (fn.grantees || []).map((grantee) => ({ grantee, privilege_type: 'EXECUTE', is_grantable: false })),
      };
    }
  }
  // SQL 86: the earn function and its completion trigger function share the owner;
  // SQL 87: the case helper and both case trigger functions do.
  const anchor = mortgageOwnerAnchor(spec);
  if (anchor) functions[anchor.identity].owner_oid = 1;
  const objects = key === 'sql84'
    ? { audit_table: MORTGAGE_AUDIT_TABLE_INTENDED, per_check_unique_present: true }
    : key === 'sql85' ? MORTGAGE_SQL85_OBJECTS_INTENDED : {};
  return { functions, objects };
}

const mortgagePin = (key, filename, migrationId, sourceSha, preSha, intendedSha, commit = '6dd5acca3022dc9564a1c7e6b1a25702c15e24cf') => Object.freeze({
  filename,
  migration_id: migrationId,
  migration: key,
  // The commit that authored the current file bytes (PR #992 for SQL 84-86).
  commit,
  source_sha256: sourceSha,
  // Recorded, not code-derived: live_definition_sha256 from the guarded staging SQL
  // executor read-live of this migration (see each pin below).
  expected_live_definition_sha256: preSha,
  // Code-derived: sha256(mortgageStateText(key, mortgageAppliedStates(key))),
  // re-derived from the real catalog by aws/tests/sql84-sql86-mortgage-executor.test.mjs.
  intended_replacement_sha256: intendedSha,
  function_identities: Object.freeze(MORTGAGE_MIGRATIONS[key].functions.filter((fn) => fn.role !== 'referenced').map((fn) => fn.identity)),
});

export const AUTHORIZED_SQL84_MORTGAGE_RETURN_TO_QUEUE = mortgagePin(
  'sql84',
  'aws/workflows/sql/84_mortgage_return_to_queue.sql',
  '84_mortgage_return_to_queue',
  '0b6fe69b92e66f6e66a3a2438806e67cfa31d6c741802608881fb2fec5c9e806',
  // Read-live run 58 (run id 38892001098), 2026-10-16, main 2e500dad1 (executor deploy
  // run 57): Cursor SQL 48's return_mortgage_handling_request_to_queue (cursor_original),
  // staging's check_billing_events_mortgage_ops_check_uidx (per_check_unique_present),
  // billing_duplicates 0, the audit table present; precondition_failures [].
  '53a0fa9f2b9cb126b3852a8b0595504fb74947c46a5a8390d67b46d7d67ad496',
  'ff920f5453283e9ca550bb8a191905386832f44e2e35567522530b806cb0e983',
);
export const AUTHORIZED_SQL85_MORTGAGE_COMPENSATION_ADJUST = mortgagePin(
  'sql85',
  'aws/workflows/sql/85_mortgage_compensation_adjust.sql',
  '85_mortgage_compensation_adjust',
  '4cc77457554ed9c24407db61bc292c168db0794ed7b884180554d69989e52b3d',
  // Read-live run 59 (run id 38892111590), 2026-10-16: the six-argument function absent,
  // Cursor SQL 49's five-argument one (cursor_original), idempotency_key absent,
  // batch_actions_outside_check 0; precondition_failures [].
  '7d5e766cf30a46e2925af225e9c2c19ee3cdb9a84ccf2685c23393f7cc06ee2d',
  '051e82285f54c40b4af289956cf537e79123de5e5dad7e6b8d83dd528e778908',
);
export const AUTHORIZED_SQL86_MORTGAGE_COMPENSATION_OWNER_ONLY = mortgagePin(
  'sql86',
  'aws/workflows/sql/86_mortgage_compensation_owner_only.sql',
  '86_mortgage_compensation_owner_only',
  '1449df1f0c58aee2562e495d65e1327f4b6b4527005a55b5596b064de798df16',
  // Read-live run 60 (run id 38892218991), 2026-10-16: all four SQL 47 functions
  // ledger_original, earn_owner_safe true; precondition_failures [].
  'c982ece2661a85293c2122c3aaf8226050d3c6670c436c94e34b870292289d0b',
  'fb7e82291b146d0bf243dab1f607b2202b131c09cccac56e40de96c64542062f',
);
// SQL 87 (aws/workflows/sql/87_resolve_check_case_tenant_scope.sql): resolve_check_case
// scoped to its tenant, EXECUTE left to its owner (the two SECURITY DEFINER case
// trigger functions).
export const AUTHORIZED_SQL87_RESOLVE_CHECK_CASE_TENANT_SCOPE = mortgagePin(
  'sql87',
  'aws/workflows/sql/87_resolve_check_case_tenant_scope.sql',
  '87_resolve_check_case_tenant_scope',
  'f046c76cc731c08020171ec7e846818089df1bd66a7a07a42237f14fb8c4c22a',
  // Read-live run 74 (run id 38908546592), 2026-10-16, main 70021f724 (executor deploy
  // run 73): resolve_check_case and both trigger functions case_original (PUBLIC EXECUTE),
  // case_owner_safe true, other_callers total 0; precondition_failures [].
  '8817a4b0778237649e37a39791320edaaee570558f72171875cf550d7386b00a',
  '794dcd33b4cd61d8fc607f8e4f84df0daaf8a655afad2c7794ecf084c3a52a30',
  // The commit that authored the file bytes (this branch's first commit).
  'af84133e4e2cd6f3c2f2d8b63c59555d80646c22',
);
// SQL 88 (aws/workflows/sql/88_claim_id_assign_case_tenant_scope.sql): the trigger
// function tg_claim_id_assign_case() scoped to the row's tenant, EXECUTE left to its owner.
export const AUTHORIZED_SQL88_CLAIM_ID_ASSIGN_CASE_TENANT_SCOPE = mortgagePin(
  'sql88',
  'aws/workflows/sql/88_claim_id_assign_case_tenant_scope.sql',
  '88_claim_id_assign_case_tenant_scope',
  '57216e00aa0faba83a663d33531896b1782a5a56636d924b79ff06b1923cb316',
  // Read-live run 88 (run id 38923636741), 2026-10-16, main 117512ef1 (executor deploy
  // run 87): tg_claim_id_assign_case case_original (PUBLIC EXECUTE), resolve_check_case
  // tenant_scoped, case_owner_safe true, other_callers total 0; precondition_failures [].
  // cross_tenant_links total 5 (check_cases_claim 1, homeowner_ledger_events_case 4),
  // informational; the owner chose to continue the staging apply.
  '57ba25f2ea69adb1a6de030cb42034d4dd1e1c0741a48a96e79afe6d90aae387',
  '15fbe8f5f4598ee65b24599fa7396e4e03e75daa163f5cedcc8227aa560b1d2e',
  // The commit that authored the file bytes (this branch's first commit).
  '6e903be3bfefbad9ac7f28fc024ebc0875e38c06',
);

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

// --- SQL 29 / SQL 30: Mortgage Ops library parity and the doc_type CHECK ---------
// Shared by the staging guarded executor and the production tools
// (scripts/deployment-guard/sql29-...-production-apply.mjs, sql30-...). The files are
// unchanged operator packages (aws/rls/sql/29_mortgage_ops_library_parity.sql,
// aws/rls/sql/30_tenant_documents_mortgage_doc_type.sql; release lock mortgage-ops).
//
// Fingerprints are code-derived state texts (like SQL 89's columnUpdateStateText), so
// the post-state hash is known before any run and holds in both environments (owner
// names are not part of it: an ACL entry of the object owner reads "owner").
//   SQL 29: each of the five functions (absent, or sha256(prosrc), SECURITY DEFINER,
//           proconfig, owner-normalized ACL), the two policies on
//           mortgage_request_library_documents (cmd, permissive, roles, whether the
//           expression calls the reviewed helpers), the names of any other policy on
//           that table, and SELECT/INSERT/UPDATE/DELETE of PUBLIC, authenticated and
//           checksops on it.
//   SQL 30: tenant_documents.doc_type (type, nullability) and the
//           tenant_documents_doc_type_check constraint (present, validated, IN-list or
//           not, its sorted literals).
// Inspect also reports aggregate COUNT(*)s of the library rows (by category prefix, by
// stored-path form, shared_with_homeowners, mortgage_request_library_documents): counts
// only, never ids, names or paths; informational, never hashed or a precondition (except
// SQL 30's: rows the new CHECK would refuse, which the file itself refuses on).

const libHash = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');
const libFailed = (checks) => checks.filter(([, passed]) => !passed).map(([name]) => name);
const libSame = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export const SQL29_TABLE = 'public.mortgage_request_library_documents';
export const SQL29_POLICIES = Object.freeze([
  Object.freeze({
    name: 'aws_select_mortgage_request_library_documents',
    cmd: 'SELECT',
    roles: Object.freeze(['authenticated']),
    calls: Object.freeze(['aws_is_cross_tenant_reader', 'aws_can_access_tenant', 'aws_mortgage_agent_can_read_library_document']),
  }),
  Object.freeze({
    name: 'aws_write_mortgage_request_library_documents',
    cmd: 'INSERT',
    roles: Object.freeze(['authenticated']),
    calls: Object.freeze(['aws_can_insert_mortgage_library_document']),
  }),
]);
// Lovable / Supabase policies the file drops.
export const SQL29_DROPPED_POLICIES = Object.freeze(['read shared library docs', 'manage shared library docs', 'delete shared library docs']);
const SQL29_API_EXECUTE = Object.freeze(['authenticated EXECUTE', 'checksops EXECUTE', 'owner EXECUTE']);
export const SQL29_FUNCTIONS = Object.freeze([
  Object.freeze({ name: 'aws_mortgage_agent_can_read_library_document', identity: 'public.aws_mortgage_agent_can_read_library_document(uuid)', result: 'boolean', config: Object.freeze(['row_security=off', 'search_path=public']), acl: SQL29_API_EXECUTE }),
  Object.freeze({ name: 'aws_mortgage_agent_can_read_library_path', identity: 'public.aws_mortgage_agent_can_read_library_path(text[], text, uuid)', result: 'boolean', config: Object.freeze(['row_security=off', 'search_path=public']), acl: SQL29_API_EXECUTE }),
  Object.freeze({ name: 'aws_can_manage_mortgage_library', identity: 'public.aws_can_manage_mortgage_library(uuid)', result: 'boolean', config: Object.freeze(['row_security=off', 'search_path=public']), acl: SQL29_API_EXECUTE }),
  Object.freeze({ name: 'aws_can_insert_mortgage_library_document', identity: 'public.aws_can_insert_mortgage_library_document(uuid, uuid, uuid, text)', result: 'boolean', config: Object.freeze(['row_security=off', 'search_path=public']), acl: SQL29_API_EXECUTE }),
  // The trigger function: REVOKE ALL FROM PUBLIC, no grant.
  Object.freeze({ name: 'share_library_docs_to_mortgage_request', identity: 'public.share_library_docs_to_mortgage_request()', result: 'trigger', config: Object.freeze(['search_path=public']), acl: Object.freeze(['owner EXECUTE']) }),
]);
export const SQL29_FUNCTION_IDENTITIES = Object.freeze(SQL29_FUNCTIONS.map((fn) => fn.identity));
const SQL29_DML = Object.freeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
const SQL29_GRANTEES = Object.freeze(['PUBLIC', 'authenticated', 'checksops']);
export const SQL29_INTENDED_TABLE_ACL = Object.freeze(['authenticated INSERT', 'authenticated SELECT', 'checksops INSERT', 'checksops SELECT']);
export const SQL29_PREREQUISITES = Object.freeze([
  'public.mortgage_request_library_documents',
  'public.mortgage_handling_requests',
  'public.tenant_documents',
  'public.tenant_users',
  'type public.app_role',
  'public.has_role(uuid, public.app_role)',
  'public.aws_is_authenticated()',
  'public.aws_is_cross_tenant_reader()',
  'public.aws_can_access_tenant(uuid)',
  'public.aws_can_write_tenant(uuid)',
  'auth.uid()',
  'role checksops',
  'role authenticated',
]);
// SQL 90 (users only) replaces aws_can_manage_mortgage_library with the membership rule;
// SQL 29 re-applied after it would bring back the owner/admin tier. aws_is_tenant_member
// is SQL 90's marker.
export const SQL29_SQL90_MARKER = 'public.aws_is_tenant_member(uuid)';

export const SQL30_TABLE = 'public.tenant_documents';
export const SQL30_CONSTRAINT = 'tenant_documents_doc_type_check';
export const SQL30_PREDECESSOR_3 = Object.freeze(['insurance', 'license', 'w9']);
export const SQL30_PREDECESSOR_6 = Object.freeze(['insurance', 'license', 'privacy_policy', 'saas_agreement', 'terms_of_service', 'w9']);
export const SQL30_TARGET_VALUES = Object.freeze([
  'insurance',
  'library:mortgage:adjuster-tpa-letter',
  'library:mortgage:certificate-of-insurance',
  'library:mortgage:contractor-license',
  'library:mortgage:general-liability-insurance',
  'library:mortgage:signed-contract',
  'library:mortgage:w-9',
  'library:mortgage:workers-comp-insurance',
  'license',
  'privacy_policy',
  'saas_agreement',
  'terms_of_service',
  'w9',
]);

/** Each CREATE OR REPLACE FUNCTION body ($$...$$) of SQL 29, by function name: what pg_proc.prosrc holds after the apply. */
export function sql29FunctionBodies(text) {
  const bodies = {};
  for (const match of String(text || '').matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\([\s\S]*?\bAS \$\$([\s\S]*?)\$\$;/g)) {
    bodies[match[1]] = match[2];
  }
  return bodies;
}

const sql29FunctionLine = (fn, row) => (row?.exists
  ? `function ${fn.identity}: prosrc=${row.prosrc_sha256} secdef=${row.security_definer === true} config=${(row.config || []).join(',')} acl=${(row.acl || []).join(';')}`
  : `function ${fn.identity}: absent`);
const sql29PolicyLine = (policy, row) => (row
  ? `policy ${policy.name}: cmd=${row.cmd} permissive=${row.permissive === true} roles=${(row.roles || []).join(',')} calls_reviewed_helpers=${row.calls_reviewed_helpers === true}`
  : `policy ${policy.name}: absent`);

/** SQL 29's canonical state text (what the fingerprint hashes). */
export function sql29StateText(state = {}) {
  return [
    'sql29 mortgage ops library parity v1',
    ...SQL29_FUNCTIONS.map((fn) => sql29FunctionLine(fn, state.functions?.[fn.identity])),
    ...SQL29_POLICIES.map((policy) => sql29PolicyLine(policy, state.policies?.[policy.name])),
    `other_policies=${[...(state.other_policies || [])].sort().join(',')}`,
    `table_acl=${[...(state.table_acl || [])].sort().join(';')}`,
  ].join('\n');
}

/** The SQL 29 state the reviewed file leaves (code-derived from the file's bytes). */
export function sql29IntendedState(text) {
  const bodies = sql29FunctionBodies(text);
  const functions = {};
  for (const fn of SQL29_FUNCTIONS) {
    functions[fn.identity] = {
      exists: typeof bodies[fn.name] === 'string',
      prosrc_sha256: typeof bodies[fn.name] === 'string' ? libHash(bodies[fn.name]) : null,
      security_definer: true,
      config: [...fn.config],
      acl: [...fn.acl],
    };
  }
  const policies = Object.fromEntries(SQL29_POLICIES.map((policy) => [policy.name, {
    cmd: policy.cmd, permissive: true, roles: [...policy.roles], calls_reviewed_helpers: true,
  }]));
  return { functions, policies, other_policies: [], table_acl: [...SQL29_INTENDED_TABLE_ACL] };
}

/** SQL 30's canonical state text. */
export function sql30StateText(state = {}) {
  const check = state.check || {};
  return [
    'sql30 tenant_documents doc_type check v1',
    `table=${state.table_present === true ? 'present' : 'absent'} doc_type=${state.doc_type_udt ?? 'absent'}/${state.doc_type_nullable ?? 'absent'}`,
    check.present
      ? `check=present validated=${check.validated === true} form=${check.form} values=${[...(check.values || [])].join(',')}`
      : 'check=absent',
  ].join('\n');
}

export const SQL30_INTENDED_STATE = Object.freeze({
  table_present: true,
  doc_type_udt: 'text',
  doc_type_nullable: 'NO',
  check: Object.freeze({ present: true, validated: true, form: 'in_list', values: SQL30_TARGET_VALUES }),
});

/** The file's statements with comments removed and whitespace collapsed. */
const libStatementText = (text) => String(text || '').replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

/**
 * SQL 30 carries its own BEGIN; ... COMMIT;. The guarded tools run it inside their own
 * transaction (to verify before COMMIT and roll back otherwise), so they execute the
 * bytes between that BEGIN and COMMIT. Refuses anything but exactly one leading BEGIN;
 * and one trailing COMMIT; around the reviewed SET LOCALs and DO block.
 */
export function sql30ExecutableText(text) {
  const source = String(text || '');
  const flat = libStatementText(source);
  if (!/^BEGIN; SET LOCAL lock_timeout = '3s'; SET LOCAL statement_timeout = '15s'; DO \$apply\$ [\s\S]* \$apply\$; COMMIT;$/.test(flat)) return null;
  if ((source.match(/^BEGIN;$/gm) || []).length !== 1 || (source.match(/^COMMIT;$/gm) || []).length !== 1) return null;
  const begin = source.search(/^BEGIN;$/m);
  const commit = source.search(/^COMMIT;$/m);
  if (begin < 0 || commit < begin) return null;
  return source.slice(begin + 'BEGIN;'.length, commit);
}

export const AUTHORIZED_SQL29_MORTGAGE_OPS_LIBRARY_PARITY = Object.freeze({
  key: 'sql29',
  filename: 'aws/rls/sql/29_mortgage_ops_library_parity.sql',
  migration_id: '29_mortgage_ops_library_parity',
  // The commit that last authored the file bytes (release lock mortgage-ops records the same sha256).
  commit: '48c16079dbad30368bc916484144e370f3441f26',
  source_sha256: 'e8d416a58e1920cff27d5d744f0b1b4ff414a866a7eb483bb299bb794c0849be',
  // Pending: no staging read-live has been recorded; apply refuses until a reviewed pin change records it.
  expected_live_definition_sha256: null,
  // sha256(sql29StateText(sql29IntendedState(file bytes))); re-derived by the tests.
  intended_replacement_sha256: '1271ea9b61ec983f88e911b23c569403979fb5f560880021b58d3b1e57243c79',
  function_identities: SQL29_FUNCTION_IDENTITIES,
});

export const AUTHORIZED_SQL30_TENANT_DOCUMENTS_DOC_TYPE = Object.freeze({
  key: 'sql30',
  filename: 'aws/rls/sql/30_tenant_documents_mortgage_doc_type.sql',
  migration_id: '30_tenant_documents_mortgage_doc_type',
  commit: '0d2f1b021829f0a2f52856d59cbe95b0ff2674c1',
  source_sha256: 'd30c7cafb232387e174eb5a3938af9e0942a006fa8b775c2d6eac490d84c7d5a',
  // Staging read-live run 39075094721 (2026-10-17, executor at main ecb8647b0); owner approved the staging apply 2026-10-17.
  expected_live_definition_sha256: '37f22340383b1a5e1b1350fc602b2953c2bb72d32234456888616fd749cbf504',
  // sha256(sql30StateText(SQL30_INTENDED_STATE)); re-derived by the tests.
  intended_replacement_sha256: 'e573962eb3d7a427d6b4a2fe1fc48fa3c49f4ad22c6ae66372fb236017ca2556',
  constraint: `${SQL30_TABLE}.${SQL30_CONSTRAINT}`,
});

export const LIBRARY_SQL_PINS = Object.freeze({
  sql29: AUTHORIZED_SQL29_MORTGAGE_OPS_LIBRARY_PARITY,
  sql30: AUTHORIZED_SQL30_TENANT_DOCUMENTS_DOC_TYPE,
});

// Release 2026-10-17 staging pins: SQL 90-102 (aws/workflows/sql/9x_*.sql, 10x_*.sql). One engine
// (release-sql-state.mjs, specs in release-sql-specs.mjs) serves the staging guarded executor
// (handleReleaseSqlMigration) and the production tools (release-sql-production-apply.mjs).
// intended_replacement_sha256 is each file's code-derived intended-state fingerprint.
// expected_live_definition_sha256 stays null until a staging read-live is recorded in a reviewed
// pin change, so every staging apply refuses before connecting until then (read-live works).
export const AUTHORIZED_SQL90_USERS_ONLY_TENANT_ROLES = Object.freeze({
  key: 'sql90',
  filename: 'aws/workflows/sql/90_users_only_tenant_roles.sql',
  migration_id: '90_users_only_tenant_roles',
  // The commit that last authored the file bytes (claude/sql90-production-reconcile, reached from main through its merge commit).
  commit: '2a0863ac4e6d4a91a9a82637c2b33d81e84fa0a7',
  source_sha256: '488b2ec455fcfd11c9d1c4ea9b33f3f9323cea8e69934e98938994730b1e07bd',
  authorization: 'Owner approved 2026-10-17: staging apply (wave 1) from staging read-live run 39078340362',
  execute: true,
  // Staging read-live run 39078340362 (2026-10-17).
  expected_live_definition_sha256: '1af4b3ac3d933fa3e05e938853d93edc196d89c5e2f0b82bbd98a1843d65781c',
  // Code-derived: releaseIntendedHash('sql90', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: '1351f1d5d7f802640a61b95198248f88561ed58b667192ebdf3f1b615b00105c',
  function_identities: Object.freeze(['public.aws_is_tenant_member(uuid)', 'public.aws_can_write_tenant(uuid)', 'public.aws_can_write_check(uuid)', 'public.aws_can_write_claim(uuid)', 'public.aws_tenant_has_no_members(uuid)', 'public.aws_is_platform_owner_user(uuid)', 'public.aws_has_any_tenant_membership()', 'public.aws_can_write_same_tenant_user(uuid)', 'public.aws_can_access_tax_profiles(uuid)', 'public.aws_first_invite_allowed(uuid)', 'public.aws_invite_create_user_identity(uuid, text, text, text)', 'public.aws_create_deposit_batch_for_item(uuid, text)', 'public.aws_is_tenant_manager_admin()', 'public.aws_can_manage_mortgage_library(uuid)', 'public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb)']),
});
export const AUTHORIZED_SQL91_MOOV_ONBOARDING = Object.freeze({
  key: 'sql91',
  filename: 'aws/workflows/sql/91_moov_onboarding.sql',
  migration_id: '91_moov_onboarding',
  // The commit that last authored the file bytes on the release branch.
  commit: 'b0f219a90a34d87b5fbf10e5632f408f364bf0b1',
  source_sha256: '199bfa1a528d219a8683b61ae6264d84dd5b08caa74564691374c8c6c42b71e3',
  authorization: 'Owner approved 2026-10-17: staging apply (wave 1) from staging read-live run 39075362413',
  execute: true,
  // Staging read-live run 39075362413 (2026-10-17).
  expected_live_definition_sha256: 'bdbc697f75e7a9c57c91c9ce12956800e92417a93acfbbaa0c2d1cf69542972e',
  // Code-derived: releaseIntendedHash('sql91', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: 'f8611dcca3397f684a247de454c8737074b3d2fb03c52e28fba665d0f297967d',
  function_identities: Object.freeze(['public.aws_moov_onboarding_active()', 'public.aws_can_submit_moov_onboarding(uuid)', 'public.aws_moov_onboarding_writer(uuid)', 'public.aws_moov_webhook_apply_active()']),
});
export const AUTHORIZED_SQL92_SIGNATURE_REQUEST_CHECK_FILES_LINK_GRANT = Object.freeze({
  key: 'sql92',
  filename: 'aws/workflows/sql/92_signature_request_check_files_link_grant.sql',
  migration_id: '92_signature_request_check_files_link_grant',
  // The commit that last authored the file bytes on the release branch.
  commit: '214621e7b57b201515dfad2ff32117390d6e33a1',
  source_sha256: 'ceef6482271f5572db20f5a6db3b4bbcf77e29ada2290f03f53af7fb6e725e17',
  authorization: 'pending',
  execute: false,
  expected_live_definition_sha256: null,
  // Code-derived: releaseIntendedHash('sql92', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: '805deb65c877f9a2ff1ed9cd7f4b72b7643524dd7a94fbf5d1efc516b8b75762',
  function_identities: Object.freeze([]),
});
export const AUTHORIZED_SQL93_TENANT_COMPANY_INFO = Object.freeze({
  key: 'sql93',
  filename: 'aws/workflows/sql/93_tenant_company_info.sql',
  migration_id: '93_tenant_company_info',
  // The commit that last authored the file bytes on the release branch.
  commit: 'd1ed17dcf7c5e533a91b240580aa4464ad64627a',
  source_sha256: 'd90ec7f9ef14ca60b805e94337021259c8f9ce9ec80ed9781a47c64dbd6f8cfa',
  authorization: 'Owner approved 2026-10-17: staging apply (wave 1) from staging read-live run 39075623166',
  execute: true,
  // Staging read-live run 39075623166 (2026-10-17).
  expected_live_definition_sha256: 'ef2ce6baec304517f50b063a3d11048492ae69d34122e26020063f0c53413eb9',
  // Code-derived: releaseIntendedHash('sql93', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: '1032695c682d08934f5d4213e866df30100bd7ad855fb84cd4a4fbb9dc7aae58',
  function_identities: Object.freeze(['public.aws_tenants_member_column_guard()']),
});
export const AUTHORIZED_SQL94_DOCUMENT_LIBRARY_RESTORE = Object.freeze({
  key: 'sql94',
  filename: 'aws/workflows/sql/94_document_library_restore.sql',
  migration_id: '94_document_library_restore',
  // The commit that last authored the file bytes on the release branch.
  commit: '0625354916088d999d8fd27e635dff2f78b72d21',
  source_sha256: 'ef865f65c8ccdfda51e1b6f65a828f9d6bed16bdbd1879a1a85cf4ba30a990a2',
  authorization: 'Owner approved 2026-10-17: staging apply (wave 2) from staging read-live run 39080904425',
  execute: true,
  // Staging read-live run 39080904425 (2026-10-17).
  expected_live_definition_sha256: '724115983687d882d8240e8d06e4670bc6e24dbb16540d3134cc1ccc47d66af1',
  // Code-derived: releaseIntendedHash('sql94', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: '1cdc503275592900e9bf4ef49f7f5eadba573cab5f46dda3f4da9190dbe6ea57',
  function_identities: Object.freeze(['public.aws_tenant_document_doc_type_ok(text)', 'public.aws_homeowner_share_member(uuid)', 'public.aws_homeowner_shared_documents_guard()', 'public.aws_public_homeowner_shared_documents(text)', 'public.aws_public_homeowner_shared_document(text, uuid)']),
});
export const AUTHORIZED_SQL95_REMOVE_FREEDOM_CLAIMS_BRIDGE = Object.freeze({
  key: 'sql95',
  filename: 'aws/workflows/sql/95_remove_freedom_claims_bridge.sql',
  migration_id: '95_remove_freedom_claims_bridge',
  // The commit that last authored the file bytes on the release branch.
  commit: 'f50bf7d0d687b188b427263fbb79a8b8360acfc1',
  source_sha256: '0cf0dafdcd06afc5d6993d06668fb8d56b5812ad6c1aa0bfda437a1bcb8f4137',
  authorization: 'Owner approved 2026-10-18: staging apply (wave 4) from staging read-live run 39121392809',
  execute: true,
  expected_live_definition_sha256: '4e8f37453b8d6678ed067b8b24bf6b200c5000700742e62871941b2748ba1588',
  // Code-derived: releaseIntendedHash('sql95', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: 'a737e4ecdc114a456aa698b71f41cac7182218995c8e17517dd6162cafc1f9c2',
  function_identities: Object.freeze([]),
});
export const AUTHORIZED_SQL96_PLATFORM_OWNER_TENANT_PRICING = Object.freeze({
  key: 'sql96',
  filename: 'aws/workflows/sql/96_platform_owner_tenant_pricing.sql',
  migration_id: '96_platform_owner_tenant_pricing',
  // The commit that last authored the file bytes on the release branch.
  commit: 'c952d1ceb846dda394b460568e426d8b55f899ff',
  source_sha256: '18109fed72bf8446dbe0c9560507ae6ed1fed1eb49f972142e78112479e257b6',
  authorization: 'Owner approved 2026-10-17: staging apply (wave 2) from staging read-live run 39081015501',
  execute: true,
  // Staging read-live run 39081015501 (2026-10-17).
  expected_live_definition_sha256: '275400ff40caf1ff9d036e62f8bab687f82e9302622afef91f77a314c0f40f7f',
  // Code-derived: releaseIntendedHash('sql96', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: 'ea844355e6854ad56f7e4058b5967591ff6c49b79748babc217f0321a47e7767',
  function_identities: Object.freeze(['public.aws_tenant_pricing_columns()', 'public.aws_tenant_pricing_audit_row()', 'public.aws_tenants_member_column_guard()', 'public.aws_platform_owner_set_tenant_pricing(uuid, jsonb)']),
});
export const AUTHORIZED_SQL97_FINANCIAL_STEPUP_LOG_SERVER_WRITER = Object.freeze({
  key: 'sql97',
  filename: 'aws/workflows/sql/97_financial_stepup_log_server_writer.sql',
  migration_id: '97_financial_stepup_log_server_writer',
  // The commit that last authored the file bytes on the release branch.
  commit: 'b0f219a90a34d87b5fbf10e5632f408f364bf0b1',
  source_sha256: 'e3c8fd413f1d60030dd65192bb8696387229a4fd33fc2ae234cd61e52fbb79db',
  authorization: 'Owner approved 2026-10-18: staging apply (wave 4) from staging read-live run 39121540941',
  execute: true,
  expected_live_definition_sha256: '80bbcae1bea54fd57035fa802ecf6940314681f0ce73f2bfd9a5d8514f8986f5',
  // Code-derived: releaseIntendedHash('sql97', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: '5d9b50f5c71da4ca06810c229a67ff1dfd3839ecba83ba4e1829da15eb28edef',
  function_identities: Object.freeze(['public.aws_financial_stepup_log_writer_guard()']),
});

// Fee collection 2026-10-17 staging pin: SQL 98 (manual tenant fee collection and the per-tenant
// deposits switch; needs SQL 96, whose column guard it replaces). On the release engine like SQL
// 90-97 (choice sql98-tenant-fee-collection). Wave 3: the pre-state is the staging read-live after
// SQL 96 was applied (run 39083278136, main 02fb97d5a; precondition_failures []).
export const AUTHORIZED_SQL98_TENANT_FEE_COLLECTION = Object.freeze({
  key: 'sql98',
  filename: 'aws/workflows/sql/98_tenant_fee_collection.sql',
  migration_id: '98_tenant_fee_collection',
  // The commit that last authored the file bytes (claude/sql98-keep-reviewed-destination, reached from main through its merge commit).
  commit: '567772a9034cae4ec4d7c56b07c983fb4e797103',
  source_sha256: '5a42e485c84f7c9976390d12c275cdf32612fbba7656b66f553110c0ae697c2a',
  authorization: 'Owner approved 2026-10-18: staging apply (wave 3) from staging read-live run 39083278136',
  execute: true,
  expected_live_definition_sha256: '296c3d6a274e10f66005fb9eaecf93fa17b81bd8db3607037ca07698fddd3275',
  // Code-derived: releaseIntendedHash('sql98', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: 'abcb8f21b5a3840e6aa1dfd6639302ae82927b6fa66cf7b13351fa39c63ab603',
  function_identities: Object.freeze(['public.aws_check_billing_default_price_cents()', 'public.aws_check_billing_charges_when_per_check_off()', 'public.record_check_billing_event()', 'public.aws_platform_owner_record_billing_audit(jsonb)', 'public.aws_platform_billing_destination_audit_row()', 'public.aws_tenant_deposits_enabled(uuid)', 'public.aws_tenant_deposits_enabled_audit_row()', 'public.aws_platform_owner_set_tenant_deposits_enabled(uuid, boolean)', 'public.aws_tenants_member_column_guard()']),
});
// Mortgage Desk 2026-10-17 staging pins: SQL 99 (completion messages posted by a DEFINER trigger;
// needs SQL 90) and SQL 100 (records production's live Desk access; needs SQL 90; a strict
// no-op on production, where the tool never runs it: release-sql-specs.mjs production_noop).
export const AUTHORIZED_SQL99_MORTGAGE_DESK_COMPLETION_MESSAGES = Object.freeze({
  key: 'sql99',
  filename: 'aws/workflows/sql/99_mortgage_desk_completion_messages.sql',
  migration_id: '99_mortgage_desk_completion_messages',
  // The commit that last authored the file bytes.
  commit: '600311866039adb0a85217be84d7dfb09f9eeec2',
  source_sha256: '0c079fe41c932f34f33262ba00a17f3201f99960c89a944750f5312bd97f8b15',
  authorization: 'Owner approved 2026-10-17: staging apply (wave 1) from staging read-live run 39076376639',
  execute: true,
  // Staging read-live run 39076376639 (2026-10-17).
  expected_live_definition_sha256: '4d174e86d8c9f0940a0d38da3e432676143dc34946e8d1619cfc36d8a9a834e9',
  // Code-derived: releaseIntendedHash('sql99', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: '481ac0f1f368459d2695fba81bcb301d66dd82a420d8b7fcd956f2610e459fb4',
  function_identities: Object.freeze(['public.aws_mortgage_desk_appended_note(text, text)', 'public.aws_mortgage_desk_completion_messages()']),
});
export const AUTHORIZED_SQL100_MORTGAGE_DESK_LIVE_ACCESS = Object.freeze({
  key: 'sql100',
  filename: 'aws/workflows/sql/100_mortgage_desk_live_access.sql',
  migration_id: '100_mortgage_desk_live_access',
  // The commit that last authored the file bytes.
  commit: '7d6cdcb3fbc425a9905fa49291b4b164800884a9',
  source_sha256: '16cb8c9ae8ab63bfce4948c560ce6b97a2a53dae11ce502af606ed837a086724',
  authorization: 'Owner approved 2026-10-17: staging apply (wave 1) from staging read-live run 39076502355',
  execute: true,
  // Staging read-live run 39076502355 (2026-10-17).
  expected_live_definition_sha256: 'bdfc6b25d3f9f946e8261c3a8a1f873e7e00e84793f7c145f12eb1b9f78a6af3',
  // Code-derived: releaseIntendedHash('sql100', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: '52c00e3a3fb401107fd6a0316685a7e7d40b4ebdd42b82899acf7a16831ef777',
  function_identities: Object.freeze(['public.aws_is_mortgage_ops_agent()', 'public.aws_mortgage_agent_queue_visible(text, uuid)', 'public.aws_is_active_mortgage_agent(uuid)']),
});
// Invite 2026-10-18 staging pin: SQL 101 (aws_invite_create_user_identity inserts identity_accounts
// before profiles, for profiles_id_identity_fkey; needs SQL 90, whose function it replaces:
// release-sql-specs.mjs supersedes). Pending like the release pins until a reviewed wave.
export const AUTHORIZED_SQL101_INVITE_IDENTITY_INSERT_ORDER = Object.freeze({
  key: 'sql101',
  filename: 'aws/workflows/sql/101_invite_identity_insert_order.sql',
  migration_id: '101_invite_identity_insert_order',
  // The commit that last authored the file bytes.
  commit: '22b58f165d434bef3c5cef7e7212dd3048de819a',
  source_sha256: '5a5e2617b8f4f6757758a34559e621a41cc65090b1127a9414eae51b94a5da87',
  authorization: 'Owner approved 2026-10-18: staging apply (wave 5) from staging read-live run 39142701783',
  execute: true,
  // Staging read-live run 39142701783 (2026-10-18, main 0d4a7b8a8; executor cEKeOR0s...).
  expected_live_definition_sha256: '1c7e1d52a88e4ddb93b751ec972eebfe17600a156d6e56968c9026aa41425c1a',
  // Code-derived: releaseIntendedHash('sql101', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: '4383ef98de0b86d159ac7795b8cef1cc4d998d3540099dafed8078994d4c281b',
  // Code-derived: releaseSupersededIntendedHash('sql90', SQL 90 bytes, 'sql101', these bytes). After
  // SQL 101, SQL 90 counts as applied (for SQL 93/94/99/100) only when every SQL 90 object matches.
  superseded_intended_sha256: Object.freeze({ sql90: '8e19c4a2deb94e854e22d055884ea0beeedaf24eb633adbd51484f1b458b32e2' }),
  function_identities: Object.freeze(['public.aws_invite_create_user_identity(uuid, text, text, text)']),
});
// Tenant management 2026-10-18 staging pin: SQL 102 (the platform owner's tenant profile setter
// and member removal, the profile audit trigger, and SQL 98's aws_tenants_member_column_guard
// replaced to admit the profile fields for the platform owner; needs SQL 98, whose guard it
// replaces: release-sql-specs.mjs supersedes). Pending until a staging read-live is recorded.
export const AUTHORIZED_SQL102_PLATFORM_OWNER_TENANT_PROFILE = Object.freeze({
  key: 'sql102',
  filename: 'aws/workflows/sql/102_platform_owner_tenant_profile.sql',
  migration_id: '102_platform_owner_tenant_profile',
  // The commit that last authored the file bytes (the review's test-mode lock and pg_temp, b34470d9a).
  commit: 'b34470d9aec61a394d2214a5176ed0bc4fb9ffcd',
  source_sha256: '7ef8736baf2d610b36dbf93104f543eb7951e2228704f26f21366a3f1621f35a',
  authorization: 'Owner approved 2026-10-18: staging apply (wave 6) from staging read-live run 39161620576',
  execute: true,
  // Staging read-live run 39161620576 (2026-10-18, main 5c35bd09b; executor 1tH8Uemla...).
  expected_live_definition_sha256: 'd3b2cd30d9b06347c4a08febac3fce49732bd0babcacfeea0a2b49dbdc9cb752',
  // Code-derived: releaseIntendedHash('sql102', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: '6e1346af3dee0bcdc0dc6269299de63e9e2804568e5bdecbd51ff062669700fd',
  // Code-derived: releaseSupersededIntendedHash('sql98', SQL 98 bytes, 'sql102', these bytes). After
  // SQL 102, SQL 98 counts as applied (and through it SQL 96 and SQL 93) only when every other
  // SQL 98 object matches.
  superseded_intended_sha256: Object.freeze({ sql98: 'd18f0e44a40e04ba058ab7908ff6c4802fc495e29de3dd14f64dffe155acdf15' }),
  function_identities: Object.freeze([
    'public.aws_tenant_profile_columns()',
    'public.aws_platform_owner_set_tenant_profile(uuid, jsonb)',
    'public.aws_platform_owner_remove_tenant_member(uuid, uuid)',
    'public.aws_tenant_profile_audit_row()',
    'public.aws_tenant_has_moov_account(uuid)',
    'public.aws_tenants_member_column_guard()',
  ]),
});
// Mortgage Ops library 2026-10-19 staging pin: SQL 103 (EXECUTE on SQL 29's trigger function
// share_library_docs_to_mortgage_request() for its owner only; PUBLIC, checksops and
// authenticated revoked). Runs before SQL 29 in production so SQL 29's guard passes; no
// predecessor. Pending until a reviewed pin change records a staging read-live.
export const AUTHORIZED_SQL103_SHARE_LIBRARY_TRIGGER_ACL = Object.freeze({
  key: 'sql103',
  filename: 'aws/workflows/sql/103_share_library_trigger_acl.sql',
  migration_id: '103_share_library_trigger_acl',
  // The commit that last authored the file bytes.
  commit: '0bc3d05556dde2bfb94a7bd216b2aa6aee07d56b',
  source_sha256: 'e018a9e7c8d0b00220bec8a5ebb5606232ff26d56c3012e3f1d64d5a25f0d43b',
  authorization: 'pending',
  execute: false,
  expected_live_definition_sha256: null,
  // Code-derived: releaseIntendedHash('sql103', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: '4b909c5929f0357ef442a1b2ebcb6bf8312e93be257010ed8a32072accf02aae',
  // The function whose ACL the file sets (spec acl_functions); it creates or replaces none.
  function_identities: Object.freeze(['public.share_library_docs_to_mortgage_request()']),
});
// Moov onboarding 2026-10-19 staging pin: SQL 104 (SELECT, INSERT, UPDATE on
// payment_idempotency_keys for checksops and authenticated, the table grant SQL 91 omitted;
// #1062). After SQL 91. Pending until a reviewed pin change records a staging read-live.
export const AUTHORIZED_SQL104_PAYMENT_IDEMPOTENCY_KEYS_GRANT = Object.freeze({
  key: 'sql104',
  filename: 'aws/workflows/sql/104_payment_idempotency_keys_grant.sql',
  migration_id: '104_payment_idempotency_keys_grant',
  // The commit that last authored the file bytes.
  commit: '6a44600fd4fe05afbe749042a98edde56e5fa8c1',
  source_sha256: 'e8831083266b546deac5e2502e94f27ca353a13ed89ce5b8cca21ad18d523c8f',
  // Owner's words 2026-10-19: "do the SQL 104 staging pin".
  authorization: 'Owner approved 2026-10-19: staging apply (wave 7) from staging read-live run 39296513948',
  execute: true,
  // Staging read-live run 39296513948 (2026-10-19, main 4e7c78905, executor 22ZCkh6t...):
  // payment_idempotency_keys held only checksops SELECT (no hand grant), already_applied false.
  expected_live_definition_sha256: '22b2d47df43b9fc831143e018022d0e94790cbd1e0406f0ab03443cd14652577',
  // Code-derived: releaseIntendedHash('sql104', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: 'e5b35104ca9c3f68fd03298354c5d6e1e48218f0871a3f216539999931a291a6',
  // The file creates, replaces and sets the ACL of no function.
  function_identities: Object.freeze([]),
});
// Moov onboarding 2026-10-20 staging pin: SQL 105 (SELECT, INSERT, UPDATE on
// payment_provider_accounts, payment_provider_methods and payment_method_verifications, and
// SELECT, INSERT on payment_event_log, for checksops and authenticated: the table grants SQL 91
// omitted on the four tables its onboarding policies cover; staging 2026-10-20 12:18:20Z
// "permission denied for table payment_provider_accounts"). After SQL 91. Staging apply
// authorized (wave 8) from staging read-live run 39429083380.
export const AUTHORIZED_SQL105_ONBOARDING_PAYMENT_TABLE_GRANTS = Object.freeze({
  key: 'sql105',
  filename: 'aws/workflows/sql/105_onboarding_payment_table_grants.sql',
  migration_id: '105_onboarding_payment_table_grants',
  // The commit that last authored the file bytes.
  commit: '45ae21f2198acdc76724ac2ca5d441b553b114f9',
  source_sha256: '79c7bbfc0802836f165b12044cba949efbe1698f4f93906a98e7089de851f420',
  // Owner's words 2026-10-20: "approve SQL 105 staging".
  authorization: 'Owner approved 2026-10-20: staging apply (wave 8) from staging read-live run 39429083380',
  execute: true,
  // Staging read-live run 39429083380 (2026-10-20, main 4c13059bb, executor s7LStUnq...): checksops
  // held SELECT and UPDATE on payment_provider_accounts and payment_provider_methods, SELECT only on
  // payment_method_verifications; payment_event_log already held all four lines; authenticated held
  // nothing on the first three tables. already_applied false, predecessor sql91 true.
  expected_live_definition_sha256: 'fbbdae18762d3d8e2cbd43c070720cf5b04ef6344b5a956ee0fb1c3b4c1fc27a',
  // Code-derived: releaseIntendedHash('sql105', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: 'a67bc0a6faa4cf60500946c4a1a980180cec9ff44980a6cf9b5f05846e7e7127',
  // The file creates, replaces and sets the ACL of no function.
  function_identities: Object.freeze([]),
});
// Step-up log 2026-10-21 staging pin: SQL 106 (UPDATE, DELETE and TRUNCATE on
// financial_stepup_log revoked from PUBLIC, checksops, authenticated and anon: the table is
// append-only for every role but its owner; SQL 97's guard is BEFORE INSERT only, and the
// production inspect of SQL 97 reported other_write_grants ["checksops DELETE", "checksops
// UPDATE"]). No predecessor; before SQL 97 in production. Pending until a reviewed pin change
// records a staging read-live.
export const AUTHORIZED_SQL106_FINANCIAL_STEPUP_LOG_APPEND_ONLY = Object.freeze({
  key: 'sql106',
  filename: 'aws/workflows/sql/106_financial_stepup_log_append_only.sql',
  migration_id: '106_financial_stepup_log_append_only',
  // The commit that last authored the file bytes.
  commit: '950e76d87c70325647a58085030f561dfd48d076',
  source_sha256: 'b7b4f3f3cb0293a1c95f9ae87ad7e6b12375dd6336630f1d0c834b5e55f68f2c',
  authorization: 'pending',
  execute: false,
  expected_live_definition_sha256: null,
  // Code-derived: releaseIntendedHash('sql106', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: '0a159961b80a1887b551d7bc9f187811f62614ef352c00b12bbfe621f109088f',
  // The file creates, replaces and sets the ACL of no function.
  function_identities: Object.freeze([]),
});
// Funds type 2026-10-21 staging pin: SQL 108 (check_intake_items_funds_type_check allows NULL
// or the nine funds_type values the SPA offers; the Supabase constraint allowed five, so saving
// deductible, other_structures, personal_property or additional_living_expenses failed,
// production /prep/data/write 2026-10-21 15:57-15:58 UTC). No predecessor. Staging apply
// authorized (wave 9) from staging read-live run 39657370816.
export const AUTHORIZED_SQL108_CHECK_INTAKE_ITEMS_FUNDS_TYPE_VALUES = Object.freeze({
  key: 'sql108',
  filename: 'aws/workflows/sql/108_check_intake_items_funds_type_values.sql',
  migration_id: '108_check_intake_items_funds_type_values',
  // The commit that last authored the file bytes.
  commit: '20b09344e531cf74f833abcf659c57423e2d7927',
  source_sha256: '89cea9c9bac16ebddbfb32aeff55e46a630b87bf28a011ba894b33d0d2412a49',
  // Owner's words 2026-10-21: "apply SQL 108 in production then DEPLOY WEBSITE TO PRODUCTION then
  // APPLY API CONFIGURATION TO PRODUCTION" (SQL 108 through the whole guarded path, staging first).
  authorization: 'Owner approved 2026-10-21: staging apply (wave 9) from staging read-live run 39657370816',
  execute: true,
  // Staging read-live run 39657370816 (2026-10-21, main 20059c9d3, executor KR/KUKLC...): the
  // constraint is the Supabase five-value definition, validated (c83dcc9b... is the release engine's
  // fingerprint of exactly that definition). already_applied false, precondition_failures [].
  expected_live_definition_sha256: 'c83dcc9b97b84d294a743063adb0c1f5231f5c37ade2f00d65dc134a1d55cf00',
  // Code-derived: releaseIntendedHash('sql108', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: 'a796a3966009ceb9db4bcc43c4a75cc1a15753954e4f469abe77174eaccceaa5',
  // The file creates, replaces and sets the ACL of no function.
  function_identities: Object.freeze([]),
});

// Moov transfer returns 2026-10-21 staging pin: SQL 109 (public.aws_moov_webhook_apply_transfer_status,
// the SECURITY DEFINER webhook writer of a funding or send leg's status, ACH return and NOC; EXECUTE
// checksops only; gated on SQL 91's aws_moov_webhook_apply_active()). After SQL 91. Staging apply
// authorized (wave 10) from staging read-live run 39663914111.
export const AUTHORIZED_SQL109_MOOV_TRANSFER_WEBHOOK_STATUS = Object.freeze({
  key: 'sql109',
  filename: 'aws/workflows/sql/109_moov_transfer_webhook_status.sql',
  migration_id: '109_moov_transfer_webhook_status',
  // The commit that last authored the file bytes.
  commit: 'f8695e8b16dd73753fa0600891e6eb99e842dd9e',
  source_sha256: '228725d8ebb81803e0fd172d92d677640eaefd51c62616c691bf3bb8775662ea',
  // Owner's words 2026-10-21: "apply SQL 109 in production" (SQL 109 through the whole guarded
  // path, staging first).
  authorization: 'Owner approved 2026-10-21: staging apply (wave 10) from staging read-live run 39663914111',
  execute: true,
  // Staging read-live run 39663914111 (2026-10-21, main c92fe457b, executor UMqsKj8X...): the
  // function is absent (e0f02501... is the release engine's fingerprint of exactly that state).
  // SQL 91 applied, definer_writes ok, already_applied false, precondition_failures [].
  expected_live_definition_sha256: 'e0f02501f167f4bee2bbb8bc32c1e19b23deb5425a650c63102030531aa9a077',
  // Code-derived: releaseIntendedHash('sql109', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: '925e018f0262556b8c43f872dc13ace4eeb36b411773189dc68592a37efb1982',
  function_identities: Object.freeze(['public.aws_moov_webhook_apply_transfer_status(text, text, text, text, text, text, text, text, text, text, timestamp with time zone)']),
});

// Homeowner pre-claim links 2026-10-22 staging pin: SQL 110 (DELETE on homeowner_ledger_tokens
// for checksops, under aws_write_homeowner_ledger_tokens; and the SECURITY DEFINER public
// homeowner upload writer public.aws_public_homeowner_ledger_upload, EXECUTE checksops only).
// No predecessor. Pending until a reviewed pin change records a staging read-live.
export const AUTHORIZED_SQL110_HOMEOWNER_PRECLAIM_LINKS = Object.freeze({
  key: 'sql110',
  filename: 'aws/workflows/sql/110_homeowner_preclaim_links.sql',
  migration_id: '110_homeowner_preclaim_links',
  // The commit that last authored the file bytes.
  commit: '810dde9b754cc752922ce9169b4f0fa893036ba4',
  source_sha256: '17055748984218ae646ea0de138626318a6c4de4c1c575be1e23fc8dd0422db4',
  // Owner's words 2026-10-22: "Apply SQL 110 to staging" (staging only; production separately).
  authorization: 'Owner approved 2026-10-22: staging apply (wave 11) from staging read-live run 39836749684',
  execute: true,
  // Staging read-live run 39836749684 (2026-10-22, main 6cf4c2f6b, after executor deploy run
  // 39836443329): the writer function absent, homeowner_ledger_tokens with no DELETE grant (other
  // write grant checksops UPDATE), definer_writes ok for the three tables, already_applied false,
  // precondition_failures [].
  expected_live_definition_sha256: '3fdbb3d323c1c0edab0c2ee7e4a6c1b08aa30c1a021c7d81899e95a616f186fd',
  // Code-derived: releaseIntendedHash('sql110', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: 'ae039876920fde43cba6c3d01ed9443f2d129ad11d23825ec3c120256fc21ac3',
  function_identities: Object.freeze(['public.aws_public_homeowner_ledger_upload(text, text, text, text, numeric, text)']),
});

// Tenant referral codes 2026-10-22 staging pin: SQL 111 (five SECURITY DEFINER functions,
// EXECUTE checksops only, the active-count helper the owner only: redeem a code into one
// referral_events row, the $5.00-per-referral maintenance credit capped at $25.00 a month, the
// tenant's summary and the platform owner's overview). No predecessor. Pending until a reviewed
// pin change records a staging read-live.
export const AUTHORIZED_SQL111_TENANT_REFERRAL_CODES = Object.freeze({
  key: 'sql111',
  filename: 'aws/workflows/sql/111_tenant_referral_codes.sql',
  migration_id: '111_tenant_referral_codes',
  // The commit that last authored the file bytes.
  commit: '2aab04de3c2f4c5e05c1929e2f04e68cc9e8233a',
  source_sha256: '49144697145cb6f6e2495041c22967cfd44263f8abb7fad5ef0953f1abb8e829',
  // Owner's words 2026-10-22: "Owner approved the SQL 111 staging apply on 2026-10-22" (staging only; production separately).
  authorization: 'Owner approved 2026-10-22: staging apply (wave 12) from staging read-live run 39874593011',
  execute: true,
  // Staging read-live run 39874593011 (2026-10-22, main 323206af2, after executor deploy run
  // 39874360848): the five functions absent, definer_writes ok for referral_events and tenants,
  // already_applied false, precondition_failures [].
  expected_live_definition_sha256: 'b78704b4d46b3ca88146d8368e09c630ead8930d3717e89287bf07bb46b86978',
  // Code-derived: releaseIntendedHash('sql111', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: '0ca629155cf58f4f4033aa792cc0a8d817cd8692a1337ba85eb33716cf1c98fb',
  function_identities: Object.freeze([
    'public.aws_tenant_referral_active_count(uuid)',
    'public.aws_tenant_referral_credit_cents(uuid)',
    'public.aws_apply_referral_code(uuid, text)',
    'public.aws_tenant_referral_summary(uuid)',
    'public.aws_platform_owner_referral_overview()',
  ]),
});

// Moov invoices 2026-10-23 staging pin: SQL 112 (SELECT, INSERT, UPDATE, DELETE on moov_invoices
// and SELECT, INSERT on moov_invoice_customers, for checksops and authenticated: the table grants
// the production invoice handler needs, which only the supabase migration 20260819015105 granted).
// No predecessor. Staging apply authorized (wave 13) from staging read-live run 39963348904.
export const AUTHORIZED_SQL112_MOOV_INVOICE_TABLE_GRANTS = Object.freeze({
  key: 'sql112',
  filename: 'aws/workflows/sql/112_moov_invoice_table_grants.sql',
  migration_id: '112_moov_invoice_table_grants',
  // The commit that last authored the file bytes.
  commit: 'fcb2ead39b4bf3c58185a96abfc7e2b7b220bed9',
  source_sha256: '497e23e9b158d7d8287244b315ee1135cafb6fc955af05c0e1c60d0c5c44c7e4',
  // Owner's words 2026-10-23: "applying SQL 112 for parity." (staging apply and, separately, the production pin and apply).
  authorization: 'Owner approved 2026-10-23: staging apply (wave 13) from staging read-live run 39963348904',
  execute: true,
  // Staging read-live run 39963348904 (2026-10-23, main c74e7264c, after executor deploy run
  // 39962977351): checksops held SELECT only on moov_invoices and moov_invoice_customers,
  // authenticated none of the pinned lines; already_applied false, precondition_failures [].
  expected_live_definition_sha256: 'c606d5eda318a2336d5885b3675339ee98aed761c3aa620a7ced759b3c5eeb89',
  // Code-derived: releaseIntendedHash('sql112', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: '7caba5ba4a322d54a3c55ca712966da58cf4358c0db81f95c142dabfc916f315',
  // The file creates, replaces and sets the ACL of no function.
  function_identities: Object.freeze([]),
});

// Payee setup 2026-10-23 staging pin: SQL 113 (the payee state columns on
// external_payment_recipients, origin provider_recipient in stakeholder_accounts_origin_check,
// SELECT on external_payment_recipients for checksops and authenticated, and six SECURITY DEFINER
// payee functions, EXECUTE checksops only). No predecessor. Staging apply authorized (wave 14)
// from staging read-live run 40018316361.
export const AUTHORIZED_SQL113_PAYEE_SETUP = Object.freeze({
  key: 'sql113',
  filename: 'aws/workflows/sql/113_payee_setup.sql',
  migration_id: '113_payee_setup',
  // The commit that last authored the file bytes.
  commit: '700feee792e4075aa7189c69bf8a8dfdfc59a0e4',
  source_sha256: '871d953df9ebb066601993ea6c36ec8162bd9664b813f27eccbf972e07d9f3ad',
  // Owner's words 2026-10-23: "Apply SQL 113 to staging" (staging apply only; the production pin and apply are separate).
  authorization: 'Owner approved 2026-10-23: staging apply (wave 14) from staging read-live run 40018316361',
  execute: true,
  // Staging read-live run 40018316361 (2026-10-23, main ac2860a5a, after executor deploy run
  // 40018037771): the six functions and seven payee columns absent, the four supabase-era columns
  // already the file's, the origin check not yet the five-value one, checksops SELECT (and UPDATE)
  // on external_payment_recipients; already_applied false, precondition_failures [].
  expected_live_definition_sha256: '88787a89c85585f25c18ea31d60740a6526522377a1b0d7b02e7902fe18970c1',
  // Code-derived: releaseIntendedHash('sql113', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: '5984d321197bd03552da656381ea47b67220d8f0accac10214aa392fd26f81d7',
  function_identities: Object.freeze([
    'public.aws_payee_create(uuid, uuid, text, text, text, text, text, text, text, timestamp with time zone, uuid, uuid)',
    'public.aws_payee_reissue_link(uuid, text, timestamp with time zone)',
    'public.aws_payee_disconnect(uuid)',
    'public.aws_public_payee_by_token(text)',
    'public.aws_public_payee_record(text, text, jsonb)',
    'public.aws_payee_apply_status(text, text, text)',
  ]),
});

// Stakeholder accounts 2026-10-25 staging pin: SQL 114 (UPDATE (is_active, is_primary, account_type,
// homeowner_name, homeowner_email, updated_at) on stakeholder_accounts for checksops and
// authenticated: the column grant Settings > Stakeholder Accounts needs to remove a non-payee
// stakeholder and change a stakeholder's type; the restored database gave checksops SELECT only).
// No predecessor. Staging apply authorized (wave 15) from staging read-live run 40152706123.
export const AUTHORIZED_SQL114_STAKEHOLDER_SETTINGS_UPDATE_GRANT = Object.freeze({
  key: 'sql114',
  filename: 'aws/workflows/sql/114_stakeholder_accounts_settings_update_grant.sql',
  migration_id: '114_stakeholder_accounts_settings_update_grant',
  // The commit that last authored the file bytes.
  commit: '35e118aa56628f1820baf4f4666c6da75a3fa888',
  source_sha256: '484a6c17d8dd8d25108a7de15c2181d20fca645838f37b5cfe3081cfa986d811',
  // Owner's words 2026-10-25: "approve SQL 114 staging apply" (staging apply only; the production pin and apply are separate).
  authorization: 'Owner approved 2026-10-25: staging apply (wave 15) from staging read-live run 40152706123',
  execute: true,
  // Staging read-live run 40152706123 (2026-10-25, main cfc0829e5, after executor deploy run
  // 40152534378): no column grant on any of the six columns; already_applied false,
  // precondition_failures [].
  expected_live_definition_sha256: '8b5d1d4d49188412317a60036a392c27727852b246a1d59a9c2807cb17186e00',
  // Code-derived: releaseIntendedHash('sql114', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: '809eba9b7f5d40b984f4f37562dfe5419ec2de50de103fc2699048eea5bf6c46',
  // The file creates, replaces and sets the ACL of no function.
  function_identities: Object.freeze([]),
});

// Partner payout 2026-10-25 staging pin: SQL 115 (public.sync_provider_stakeholder_account(uuid)
// replaced so a tenant with a Moov account in two environments keeps one active partner payout;
// the second insert broke moov-sync on staging, 2026-10-25; EXECUTE owner only).
// No predecessor. Staging apply authorized (wave 16) from staging read-live run 40240434651.
export const AUTHORIZED_SQL115_PROVIDER_STAKEHOLDER_ONE_PARTNER_PAYOUT = Object.freeze({
  key: 'sql115',
  filename: 'aws/workflows/sql/115_provider_stakeholder_one_partner_payout.sql',
  migration_id: '115_provider_stakeholder_one_partner_payout',
  // The commit that last authored the file bytes.
  commit: '3807a0c356825dc3ccd9bf5b83a62310f4127f87',
  source_sha256: '5902638017eec4581a5f9241e93d9343b56ed39374beb671df8e8784e22f11ab',
  // Owner's words 2026-10-25: "Approve SQL 115 staging apply" (staging apply only; the production pin and apply are separate).
  authorization: 'Owner approved 2026-10-25: staging apply (wave 16) from staging read-live run 40240434651',
  execute: true,
  // Staging read-live run 40240434651 (2026-10-25, main f5cc9ec, after executor deploy run
  // 40240193453): the restored supabase body with EXECUTE to PUBLIC and the owner;
  // already_applied false, precondition_failures [].
  expected_live_definition_sha256: '6dbf58792a5eb0f9863ac0a6e88265de6ec9931a9e7a31bac21d7b71f643bba0',
  // Code-derived: releaseIntendedHash('sql115', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: '8aed39a49d988a60bdedac07a3a97f424a9de5c1499e4f50738f749326a62452',
  function_identities: Object.freeze([
    'public.sync_provider_stakeholder_account(uuid)',
  ]),
});

// Moov onboarding 2026-10-26 staging pin: SQL 116 (public.moov_onboarding_profiles.industry text,
// nullable, no default: the Moov industry of the business profile; Moov's form for Freedom
// Adjustment's new sandbox account listed Industry as required, staging 2026-10-26).
// Predecessor SQL 91 (which it supersedes). Staging apply authorized (wave 17) from staging read-live run 40336144625.
export const AUTHORIZED_SQL116_MOOV_ONBOARDING_PROFILE_INDUSTRY = Object.freeze({
  key: 'sql116',
  filename: 'aws/workflows/sql/116_moov_onboarding_profile_industry.sql',
  migration_id: '116_moov_onboarding_profile_industry',
  // The commit that last authored the file bytes.
  commit: 'eb945142973b8c1e2f435d57c11dd4dca797e0ef',
  source_sha256: '31217651d76753c9f76232f0bd2c64ab3fd9a36754ccda081fda18169437b8b8',
  // Owner's words 2026-10-26: "Approve SQL 116 staging apply and merge when green" (staging apply only; the production pin and apply are separate).
  authorization: 'Owner approved 2026-10-26: staging apply (wave 17) from staging read-live run 40336144625',
  execute: true,
  // Staging read-live run 40336144625 (2026-10-26, main d8d4e3b, after executor deploy run
  // 40335727438): no industry column, SQL 91 in place; already_applied false, precondition_failures [].
  expected_live_definition_sha256: 'd145c18e29fb0e309222d250e270f5750be7f23a8cbe336190d5c9d7bfd7d9dd',
  // Code-derived: releaseIntendedHash('sql116', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: 'c99fc953f7ab14c2c68647ed3bcfa3e0b50a5aa4888bdc9f9c71163392314ee1',
  // The file creates, replaces and sets the ACL of no function.
  function_identities: Object.freeze([]),
});

// Tenant lifecycle 2026-10-26 staging pin: SQL 117 (public.tenant_deactivations and the
// platform-owner functions that deactivate, reactivate or delete an empty tenant; owner item 8).
// No predecessor (the file checks SQL 96's audit table and SQL 102's column guard itself).
// Staging apply authorized (wave 18) from staging read-live run 40431777849.
export const AUTHORIZED_SQL117_PLATFORM_OWNER_TENANT_LIFECYCLE = Object.freeze({
  key: 'sql117',
  filename: 'aws/workflows/sql/117_platform_owner_tenant_lifecycle.sql',
  migration_id: '117_platform_owner_tenant_lifecycle',
  // The commit that last authored the file bytes.
  commit: '98b8602e0274a1c7faf124261764fa51b0cc3391',
  source_sha256: '44cdef389446e528cc9633e5c8f845ba18c122a90a5ff276afb670856a61f00d',
  // Owner's words 2026-10-27: "SQL 117 to production", then "Go" to the staging read-live and staging
  // pin (staging apply only; the staging apply run, the production pin and apply are separate).
  authorization: 'Owner approved 2026-10-27: staging apply (wave 18) from staging read-live run 40431777849',
  execute: true,
  // Staging read-live run 40431777849 (2026-10-27, main 9d6f164, after executor deploy run
  // 40431581944): tenant_deactivations and the six functions absent; already_applied false,
  // precondition_failures [].
  expected_live_definition_sha256: 'dcfcb810a7d016f63451a3cf6ec00982be2f555fae087871885e49cc4b501956',
  // Code-derived: releaseIntendedHash('sql117', file bytes) (release-sql-state.mjs); re-derived by the tests.
  intended_replacement_sha256: 'aceed4572b39db76bc12258f1f707ec4b6d78ebcec730a5dbee2bb1999677e00',
  function_identities: Object.freeze([
    'public.aws_tenant_activity_tables()',
    'public.aws_platform_owner_tenant_activity(uuid)',
    'public.aws_platform_owner_deactivate_tenant(uuid, text)',
    'public.aws_platform_owner_reactivate_tenant(uuid)',
    'public.aws_platform_owner_delete_empty_tenant(uuid, text)',
    'public.aws_platform_owner_deactivated_tenants()',
  ]),
});

export const RELEASE_2026_10_17_PENDING_SQL_PINS = Object.freeze({
  sql90: AUTHORIZED_SQL90_USERS_ONLY_TENANT_ROLES,
  sql91: AUTHORIZED_SQL91_MOOV_ONBOARDING,
  sql92: AUTHORIZED_SQL92_SIGNATURE_REQUEST_CHECK_FILES_LINK_GRANT,
  sql93: AUTHORIZED_SQL93_TENANT_COMPANY_INFO,
  sql94: AUTHORIZED_SQL94_DOCUMENT_LIBRARY_RESTORE,
  sql95: AUTHORIZED_SQL95_REMOVE_FREEDOM_CLAIMS_BRIDGE,
  sql96: AUTHORIZED_SQL96_PLATFORM_OWNER_TENANT_PRICING,
  sql97: AUTHORIZED_SQL97_FINANCIAL_STEPUP_LOG_SERVER_WRITER,
  sql98: AUTHORIZED_SQL98_TENANT_FEE_COLLECTION,
  sql99: AUTHORIZED_SQL99_MORTGAGE_DESK_COMPLETION_MESSAGES,
  sql100: AUTHORIZED_SQL100_MORTGAGE_DESK_LIVE_ACCESS,
  sql101: AUTHORIZED_SQL101_INVITE_IDENTITY_INSERT_ORDER,
  sql102: AUTHORIZED_SQL102_PLATFORM_OWNER_TENANT_PROFILE,
  sql103: AUTHORIZED_SQL103_SHARE_LIBRARY_TRIGGER_ACL,
  sql104: AUTHORIZED_SQL104_PAYMENT_IDEMPOTENCY_KEYS_GRANT,
  sql105: AUTHORIZED_SQL105_ONBOARDING_PAYMENT_TABLE_GRANTS,
  sql106: AUTHORIZED_SQL106_FINANCIAL_STEPUP_LOG_APPEND_ONLY,
  sql108: AUTHORIZED_SQL108_CHECK_INTAKE_ITEMS_FUNDS_TYPE_VALUES,
  sql109: AUTHORIZED_SQL109_MOOV_TRANSFER_WEBHOOK_STATUS,
  sql110: AUTHORIZED_SQL110_HOMEOWNER_PRECLAIM_LINKS,
  sql111: AUTHORIZED_SQL111_TENANT_REFERRAL_CODES,
  sql112: AUTHORIZED_SQL112_MOOV_INVOICE_TABLE_GRANTS,
  sql113: AUTHORIZED_SQL113_PAYEE_SETUP,
  sql114: AUTHORIZED_SQL114_STAKEHOLDER_SETTINGS_UPDATE_GRANT,
  sql115: AUTHORIZED_SQL115_PROVIDER_STAKEHOLDER_ONE_PARTNER_PAYOUT,
  sql116: AUTHORIZED_SQL116_MOOV_ONBOARDING_PROFILE_INDUSTRY,
  sql117: AUTHORIZED_SQL117_PLATFORM_OWNER_TENANT_LIFECYCLE,
});

// The fee collection pin under its earlier map name (the same object as the release map's sql98).
export const FEE_COLLECTION_PENDING_SQL_PINS = Object.freeze({
  sql98: AUTHORIZED_SQL98_TENANT_FEE_COLLECTION,
});

export function isSql29MortgageOpsLibraryParity(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL29_MORTGAGE_OPS_LIBRARY_PARITY);
}

export function isSql30TenantDocumentsDocType(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL30_TENANT_DOCUMENTS_DOC_TYPE);
}

/** The release 2026-10-17 migration key (sql90 ... sql106, sql108 ... sql117) an input names, or null. */
export function releaseSqlMigrationKey(input = {}) {
  return Object.keys(RELEASE_2026_10_17_PENDING_SQL_PINS)
    .find((key) => pinIdentifiersMatch(input, RELEASE_2026_10_17_PENDING_SQL_PINS[key])) || null;
}

/** The reviewed bytes as the guarded tools execute them, or null. */
export function librarySqlExecutableText(key, text) {
  if (key === 'sql29') {
    // No transaction control of its own; every function body is present.
    const flat = libStatementText(text);
    if (/\b(BEGIN|COMMIT|ROLLBACK)\s*;/i.test(flat.replace(/\$\$[\s\S]*?\$\$/g, ''))) return null;
    const bodies = sql29FunctionBodies(text);
    return SQL29_FUNCTIONS.every((fn) => typeof bodies[fn.name] === 'string') ? String(text) : null;
  }
  if (key === 'sql30') return sql30ExecutableText(text);
  return null;
}

// Catalog reads. Names are qualified through pg_namespace / pg_catalog.
const LIB_ACL_SQL = (column, owner, kind) => `
SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' WHEN a.grantee = ${owner} THEN 'owner' ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee,
  a.privilege_type, a.is_grantable
FROM pg_catalog.aclexplode(COALESCE(${column}, pg_catalog.acldefault('${kind}', ${owner}))) a`;
const LIBRARY_READS = Object.freeze({
  login: 'SELECT current_user::text AS current_user, session_user::text AS session_user',
  relation: `SELECT c.oid, pg_catalog.pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS rls_forced
FROM pg_catalog.pg_class c WHERE c.oid = pg_catalog.to_regclass($1)`,
  relationAcl: `SELECT x.grantee, x.privilege_type, x.is_grantable FROM pg_catalog.pg_class c
CROSS JOIN LATERAL (${LIB_ACL_SQL('c.relacl', 'c.relowner', 'r')}) x
WHERE c.oid = pg_catalog.to_regclass($1) ORDER BY 1, 2`,
  function: `SELECT p.oid, pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer,
  pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') AS prosrc_sha256,
  COALESCE(p.proconfig, ARRAY[]::text[]) AS config, pg_catalog.pg_get_function_result(p.oid) AS result,
  pg_catalog.pg_get_function_arguments(p.oid) AS arguments
FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure($1)`,
  functionAcl: `SELECT x.grantee, x.privilege_type, x.is_grantable FROM pg_catalog.pg_proc p
CROSS JOIN LATERAL (${LIB_ACL_SQL('p.proacl', 'p.proowner', 'f')}) x
WHERE p.oid = pg_catalog.to_regprocedure($1) ORDER BY 1, 2`,
  policies: `SELECT pol.polname AS name,
  CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END AS cmd,
  pol.polpermissive AS permissive,
  ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r)::text END FROM unnest(pol.polroles) r ORDER BY 1)::text[] AS roles,
  COALESCE(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '') AS qual,
  COALESCE(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '') AS with_check
FROM pg_catalog.pg_policy pol WHERE pol.polrelid = pg_catalog.to_regclass($1) ORDER BY 1`,
  shareTriggers: `SELECT t.tgname AS name, t.tgenabled::text AS enabled
FROM pg_catalog.pg_trigger t
WHERE t.tgrelid = pg_catalog.to_regclass('public.mortgage_handling_requests') AND NOT t.tgisinternal
  AND t.tgfoid = pg_catalog.to_regprocedure('public.share_library_docs_to_mortgage_request()')
ORDER BY 1`,
  regclass: 'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS present',
  regprocedure: 'SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present',
  regtype: 'SELECT pg_catalog.to_regtype($1) IS NOT NULL AS present',
  role: 'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS present',
  docTypeColumn: `SELECT c.udt_name, c.is_nullable FROM information_schema.columns c
WHERE c.table_schema = 'public' AND c.table_name = 'tenant_documents' AND c.column_name = 'doc_type'`,
  checkConstraint: `SELECT pg_catalog.pg_get_constraintdef(con.oid) AS def, con.convalidated AS validated
FROM pg_catalog.pg_constraint con
WHERE con.conrelid = pg_catalog.to_regclass('public.tenant_documents') AND con.conname = '${SQL30_CONSTRAINT}' AND con.contype = 'c'`,
  columnPresent: `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
WHERE a.attrelid = pg_catalog.to_regclass($1) AND a.attname = $2 AND a.attnum > 0 AND NOT a.attisdropped) AS present`,
});

const libAclLine = (row) => `${row.grantee} ${row.privilege_type}${row.is_grantable === true ? ' with grant option' : ''}`;

const prerequisitePresent = async (q, name) => {
  if (name.startsWith('role ')) return (await q(LIBRARY_READS.role, [name.slice(5)]))[0]?.present === true;
  if (name.startsWith('type ')) return (await q(LIBRARY_READS.regtype, [name.slice(5)]))[0]?.present === true;
  if (name.includes('(')) return (await q(LIBRARY_READS.regprocedure, [name]))[0]?.present === true;
  return (await q(LIBRARY_READS.regclass, [name]))[0]?.present === true;
};

/** The SQL 30 CHECK's form and literals (the same parse SQL 30's DO block makes). */
export function sql30CheckShape(def) {
  if (typeof def !== 'string' || !def) return { form: 'absent', values: [], shape: 'absent' };
  const values = [...def.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  const inList = /doc_type/i.test(def) && !/like/i.test(def) && !/~/.test(def) && (/IN\s*\(/i.test(def) || /= ANY/i.test(def));
  const form = inList ? 'in_list' : 'other';
  let shape = 'other';
  if (inList && libSame(values, [...SQL30_PREDECESSOR_3])) shape = 'predecessor_3';
  else if (inList && libSame(values, [...SQL30_PREDECESSOR_6])) shape = 'predecessor_6';
  else if (inList && libSame(values, [...SQL30_TARGET_VALUES])) shape = 'sql30';
  else if (/aws_tenant_document_doc_type_ok\(doc_type\)/.test(def)) shape = 'sql94';
  return { form, values, shape };
}

/** One aggregate COUNT(*) in its own savepoint; null (with a reason code) when unreadable. */
async function libraryGuardedRows(client, name, sql) {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const rows = (await client.query(sql))?.rows || [];
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return { readable: true, rows };
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    return { readable: false, reason: String(error?.code || 'unreadable').slice(0, 16) };
  }
}

const LIBRARY_CATEGORY_KEYS = Object.freeze(['legacy', 'mortgage', 'template', 'shingle', 'siding', 'catalog', 'letterhead', 'library_other', 'other']);
const PATH_FORM_KEYS = Object.freeze(['aws_library', 'url', 'bucket_prefixed', 'other_tenant_library', 'other']);
const fixedCounts = (rows, keys) => {
  const out = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const row of rows) {
    const key = keys.includes(row.k) ? row.k : keys[keys.length - 1];
    out[key] += Number(row.n) || 0;
  }
  return out;
};

/** Library row counts for the inspect: aggregate COUNT(*) only (no ids, names or paths). */
export async function readLibraryRowCounts(client, tablePresent) {
  const legacy = `ARRAY[${SQL30_PREDECESSOR_6.map((v) => `'${v}'`).join(', ')}]::text[]`;
  const target = `ARRAY[${SQL30_TARGET_VALUES.map((v) => `'${v}'`).join(', ')}]::text[]`;
  const out = {};
  const unreadable = [];
  if (tablePresent.tenant_documents) {
    const byCategory = await libraryGuardedRows(client, 'lib_count_category', `
SELECT CASE
  WHEN doc_type = ANY (${legacy}) THEN 'legacy'
  WHEN doc_type LIKE 'library:%' THEN CASE WHEN split_part(doc_type, ':', 2) IN ('mortgage', 'template', 'shingle', 'siding', 'catalog', 'letterhead')
    THEN split_part(doc_type, ':', 2) ELSE 'library_other' END
  ELSE 'other' END AS k, count(*)::int AS n
FROM public.tenant_documents GROUP BY 1`);
    out.tenant_documents_by_category = byCategory.readable ? fixedCounts(byCategory.rows, LIBRARY_CATEGORY_KEYS) : null;
    if (!byCategory.readable) unreadable.push(`tenant_documents_by_category:${byCategory.reason}`);
    const byPath = await libraryGuardedRows(client, 'lib_count_path', `
SELECT CASE
  WHEN lower(COALESCE(file_path, '')) LIKE lower(tenant_id::text) || '/library/%' THEN 'aws_library'
  WHEN COALESCE(file_path, '') ~* '^https?://' THEN 'url'
  WHEN COALESCE(file_path, '') LIKE 'tenant-documents/%' THEN 'bucket_prefixed'
  WHEN COALESCE(file_path, '') LIKE '%/library/%' THEN 'other_tenant_library'
  ELSE 'other' END AS k, count(*)::int AS n
FROM public.tenant_documents GROUP BY 1`);
    out.tenant_documents_by_path_form = byPath.readable ? fixedCounts(byPath.rows, PATH_FORM_KEYS) : null;
    if (!byPath.readable) unreadable.push(`tenant_documents_by_path_form:${byPath.reason}`);
    const violating = await libraryGuardedRows(client, 'lib_count_sql30', `
SELECT count(*)::int AS n FROM public.tenant_documents WHERE doc_type IS NULL OR doc_type <> ALL (${target})`);
    out.rows_outside_sql30_values = violating.readable ? Number(violating.rows[0]?.n) || 0 : null;
    if (!violating.readable) unreadable.push(`rows_outside_sql30_values:${violating.reason}`);
    if (tablePresent.shared_with_homeowners) {
      const shared = await libraryGuardedRows(client, 'lib_count_shared', 'SELECT count(*)::int AS n FROM public.tenant_documents WHERE shared_with_homeowners IS TRUE');
      out.shared_with_homeowners_true = shared.readable ? Number(shared.rows[0]?.n) || 0 : null;
      if (!shared.readable) unreadable.push(`shared_with_homeowners_true:${shared.reason}`);
    } else {
      out.shared_with_homeowners_true = null;
      unreadable.push('shared_with_homeowners_true:column_missing');
    }
  } else {
    unreadable.push('tenant_documents:table_missing');
  }
  if (tablePresent.mortgage_request_library_documents) {
    const attached = await libraryGuardedRows(client, 'lib_count_attached', 'SELECT count(*)::int AS n FROM public.mortgage_request_library_documents');
    out.mortgage_request_library_documents = attached.readable ? Number(attached.rows[0]?.n) || 0 : null;
    if (!attached.readable) unreadable.push(`mortgage_request_library_documents:${attached.reason}`);
  } else {
    out.mortgage_request_library_documents = null;
    unreadable.push('mortgage_request_library_documents:table_missing');
  }
  return { ...out, readable: unreadable.length === 0, unreadable };
}

/**
 * The SQL 29 and SQL 30 state (catalog, plus the aggregate row counts when `counts`).
 * Read-only; both migrations' fingerprints come from the same read.
 */
export async function readLibrarySqlState(client, { counts = true } = {}) {
  const q = async (sql, params = []) => ((await client.query(sql, params))?.rows || []);
  const login = (await q(LIBRARY_READS.login))[0] || {};
  const prerequisites = {};
  for (const name of SQL29_PREREQUISITES) prerequisites[name] = await prerequisitePresent(q, name);
  const sql90Applied = (await q(LIBRARY_READS.regprocedure, [SQL29_SQL90_MARKER]))[0]?.present === true;

  // SQL 29
  const table = (await q(LIBRARY_READS.relation, [SQL29_TABLE]))[0] || null;
  const tableAclRows = table ? await q(LIBRARY_READS.relationAcl, [SQL29_TABLE]) : [];
  const tableAclAll = tableAclRows.map(libAclLine).sort();
  const tableAcl = tableAclRows
    .filter((row) => SQL29_GRANTEES.includes(row.grantee) && SQL29_DML.includes(row.privilege_type))
    .map(libAclLine).sort();
  const functions = {};
  for (const fn of SQL29_FUNCTIONS) {
    const row = (await q(LIBRARY_READS.function, [fn.identity]))[0];
    if (!row) {
      functions[fn.identity] = { exists: false };
      continue;
    }
    const acl = (await q(LIBRARY_READS.functionAcl, [fn.identity])).map(libAclLine).sort();
    functions[fn.identity] = {
      exists: true,
      owner: row.owner,
      owner_is_login: row.owner === login.current_user,
      security_definer: row.security_definer === true,
      prosrc_sha256: row.prosrc_sha256,
      config: [...(row.config || [])].map(String).sort(),
      result: row.result,
      acl,
    };
  }
  const policyRows = table ? await q(LIBRARY_READS.policies, [SQL29_TABLE]) : [];
  const policies = {};
  for (const policy of SQL29_POLICIES) {
    const row = policyRows.find((r) => r.name === policy.name);
    if (!row) continue;
    const expr = policy.cmd === 'INSERT' ? row.with_check : row.qual;
    policies[policy.name] = {
      cmd: row.cmd,
      permissive: row.permissive === true,
      roles: [...(row.roles || [])].map(String).sort(),
      calls_reviewed_helpers: policy.calls.every((name) => String(expr).includes(name)),
    };
  }
  const managed = new Set(SQL29_POLICIES.map((p) => p.name));
  const otherPolicies = policyRows.map((r) => r.name).filter((name) => !managed.has(name)).sort();
  const shareTriggers = (await q(LIBRARY_READS.shareTriggers)).map((r) => ({ name: r.name, enabled: r.enabled !== 'D' }));
  const sql29 = {
    table_present: Boolean(table),
    table_owner: table?.owner ?? null,
    table_owner_is_login: Boolean(table) && table.owner === login.current_user,
    rls_enabled: table?.rls === true,
    rls_forced: table?.rls_forced === true,
    table_acl: tableAcl,
    table_acl_entries: tableAclAll,
    functions,
    policies,
    other_policies: otherPolicies,
    share_triggers: shareTriggers,
  };
  sql29.live_definition_sha256 = libHash(sql29StateText(sql29));

  // SQL 30
  const tdTable = (await q(LIBRARY_READS.relation, [SQL30_TABLE]))[0] || null;
  const column = (await q(LIBRARY_READS.docTypeColumn))[0] || null;
  const check = tdTable ? (await q(LIBRARY_READS.checkConstraint))[0] || null : null;
  const shape = sql30CheckShape(check?.def);
  const sql30 = {
    table_present: Boolean(tdTable),
    table_owner: tdTable?.owner ?? null,
    table_owner_is_login: Boolean(tdTable) && tdTable.owner === login.current_user,
    doc_type_udt: column?.udt_name ?? null,
    doc_type_nullable: column?.is_nullable ?? null,
    check: check
      ? { present: true, validated: check.validated === true, form: shape.form, values: shape.values, shape: shape.shape, definition_sha256: libHash(check.def) }
      : { present: false, shape: 'absent', definition_sha256: null },
  };
  sql30.live_definition_sha256 = libHash(sql30StateText(sql30));

  const state = {
    current_user: login.current_user ?? null,
    session_user: login.session_user ?? null,
    prerequisites,
    prerequisites_missing: Object.entries(prerequisites).filter(([, v]) => !v).map(([k]) => k),
    sql90_applied: sql90Applied,
    sql29,
    sql30,
  };
  if (counts) {
    const sharedColumn = tdTable ? (await q(LIBRARY_READS.columnPresent, [SQL30_TABLE, 'shared_with_homeowners']))[0]?.present === true : false;
    state.counts = await readLibraryRowCounts(client, {
      tenant_documents: Boolean(tdTable),
      shared_with_homeowners: sharedColumn,
      mortgage_request_library_documents: Boolean(table),
    });
  }
  return ok(state);
}

/** The pin's live fingerprint in a library state. */
export const librarySqlLiveHash = (key, state) => state?.[key]?.live_definition_sha256 ?? null;

const SQL29_API_ACL_LINES = new Set(['owner EXECUTE', 'PUBLIC EXECUTE', 'authenticated EXECUTE', 'checksops EXECUTE']);
const SQL29_TRIGGER_ACL_LINES = new Set(['owner EXECUTE', 'PUBLIC EXECUTE']);

/** Rules both environments apply before SQL 29 / SQL 30 run. */
export function librarySharedPreconditionFailures(key, state) {
  if (key === 'sql29') {
    const s = state?.sql29 || {};
    const fnRows = SQL29_FUNCTIONS.map((fn) => [fn, s.functions?.[fn.identity] || { exists: false }]);
    return libFailed([
      ['prerequisites_present', Array.isArray(state?.prerequisites_missing) && state.prerequisites_missing.length === 0],
      // SQL 29 after SQL 90 would bring back the owner/admin tier on aws_can_manage_mortgage_library.
      ['sql90_not_applied', state?.sql90_applied === false],
      ['table_owned_by_login', s.table_owner_is_login === true],
      ['rls_enabled', s.rls_enabled === true],
      ['functions_owned_by_login', fnRows.every(([, row]) => !row.exists || row.owner_is_login === true)],
      ['function_results_match', fnRows.every(([fn, row]) => !row.exists || row.result === fn.result)],
      // Grants the file does not revoke would survive it.
      ['function_acl_replaceable', fnRows.every(([fn, row]) => !row.exists || (row.acl || []).every((line) => (
        fn.result === 'trigger' ? SQL29_TRIGGER_ACL_LINES : SQL29_API_ACL_LINES).has(line)))],
      ['table_acl_replaceable', (s.table_acl_entries || []).every((line) => {
        const grantee = line.split(' ')[0];
        return grantee === 'owner' || SQL29_GRANTEES.includes(grantee);
      }) && (s.table_acl_entries || []).every((line) => !/with grant option/.test(line) || line.startsWith('owner '))],
      // Only the reviewed policies and the three the file drops.
      ['no_unmanaged_policies', (s.other_policies || []).every((name) => SQL29_DROPPED_POLICIES.includes(name))],
    ]);
  }
  if (key === 'sql30') {
    const s = state?.sql30 || {};
    const shape = s.check?.shape;
    return libFailed([
      ['table_present', s.table_present === true],
      ['doc_type_text_not_null', s.doc_type_udt === 'text' && s.doc_type_nullable === 'NO'],
      ['table_owned_by_login', s.table_owner_is_login === true],
      ['check_is_supported_predecessor', shape === 'predecessor_3' || shape === 'predecessor_6'],
      // SQL 30's own sql30_abort for rows the new CHECK refuses.
      ['no_rows_outside_sql30_values', state?.counts?.rows_outside_sql30_values === 0],
    ]);
  }
  return ['unknown_migration'];
}

/** Rules both environments apply after SQL 29 / SQL 30 ran, inside the transaction. */
export function librarySharedPostconditionFailures(key, before, after, pin) {
  if (key === 'sql29') {
    const s = after?.sql29 || {};
    return libFailed([
      ['intended_state', s.live_definition_sha256 === pin?.intended_replacement_sha256],
      ['functions_owned_by_login', SQL29_FUNCTIONS.every((fn) => s.functions?.[fn.identity]?.owner_is_login === true)],
      ['table_owner_unchanged', after?.sql29?.table_owner === before?.sql29?.table_owner],
      ['rls_enabled', s.rls_enabled === true],
      // Privileges the file does not name (REFERENCES, TRIGGER, TRUNCATE, ...) are unchanged.
      ['other_table_privileges_unchanged', libSame(
        (s.table_acl_entries || []).filter((line) => !SQL29_DML.includes(line.split(' ')[1]) || !SQL29_GRANTEES.includes(line.split(' ')[0])),
        (before?.sql29?.table_acl_entries || []).filter((line) => !SQL29_DML.includes(line.split(' ')[1]) || !SQL29_GRANTEES.includes(line.split(' ')[0])),
      )],
      ['share_triggers_unchanged', libSame(s.share_triggers, before?.sql29?.share_triggers)],
      ['sql30_unchanged', after?.sql30?.live_definition_sha256 === before?.sql30?.live_definition_sha256],
    ]);
  }
  if (key === 'sql30') {
    return libFailed([
      ['intended_state', after?.sql30?.live_definition_sha256 === pin?.intended_replacement_sha256],
      ['table_owner_unchanged', after?.sql30?.table_owner === before?.sql30?.table_owner],
      ['sql29_unchanged', after?.sql29?.live_definition_sha256 === before?.sql29?.live_definition_sha256],
    ]);
  }
  return ['unknown_migration'];
}

/** Objects each migration may change (everything else in public and auth must not). */
export const LIBRARY_UNRELATED_SCOPE = Object.freeze({
  sql29: Object.freeze({
    functions: SQL29_FUNCTION_IDENTITIES,
    policy_relations: Object.freeze([SQL29_TABLE]),
    acl_relations: Object.freeze([SQL29_TABLE]),
    constraints: Object.freeze([]),
  }),
  sql30: Object.freeze({
    functions: Object.freeze([]),
    policy_relations: Object.freeze([]),
    acl_relations: Object.freeze([]),
    constraints: Object.freeze([`${SQL30_TABLE}.${SQL30_CONSTRAINT}`]),
  }),
});

const LIBRARY_UNRELATED_SQL = Object.freeze({
  relations: `SELECT c.oid::regclass::text || ' ' || c.relkind::text || ' ' || pg_catalog.pg_get_userbyid(c.relowner) || ' '
  || c.relrowsecurity::text || ' ' || c.relforcerowsecurity::text || ' '
  || CASE WHEN (n.nspname || '.' || c.relname) = ANY ($1::text[]) THEN '<acl ignored>' ELSE COALESCE(c.relacl::text, '') END AS d
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' ORDER BY 1`,
  columns: `SELECT a.attrelid::regclass::text || ' ' || a.attnum::text || ' ' || a.attname || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
  || ' ' || a.attnotnull::text || ' ' || COALESCE(a.attacl::text, '') || ' ' || COALESCE(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '') AS d
FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1`,
  constraints: `SELECT con.conrelid::regclass::text || ' ' || con.conname || ' ' || con.contype::text || ' ' || pg_catalog.pg_get_constraintdef(con.oid) AS d
FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_namespace n ON n.oid = con.connamespace
LEFT JOIN pg_catalog.pg_class r ON r.oid = con.conrelid
WHERE n.nspname = 'public' AND NOT ((n.nspname || '.' || COALESCE(r.relname, '') || '.' || con.conname) = ANY ($1::text[])) ORDER BY 1`,
  policies: `SELECT c.oid::regclass::text || ' ' || pol.polname || ' ' || pol.polcmd::text || ' ' || pol.polpermissive::text || ' ' || pol.polroles::text
  || ' ' || COALESCE(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' || COALESCE(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '') AS d
FROM pg_catalog.pg_policy pol JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT ((n.nspname || '.' || c.relname) = ANY ($1::text[])) ORDER BY 1`,
  functions: `SELECT p.oid::regprocedure::text || ' ' || pg_catalog.pg_get_userbyid(p.proowner) || ' ' || md5(p.prosrc) || ' '
  || p.prosecdef::text || ' ' || COALESCE(p.proconfig::text, '') || ' ' || COALESCE(p.proacl::text, '') AS d
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'auth') AND NOT EXISTS (SELECT 1 FROM unnest($1::text[]) x WHERE pg_catalog.to_regprocedure(x) = p.oid) ORDER BY 1`,
  triggers: `SELECT t.tgrelid::regclass::text || ' ' || t.tgname || ' ' || t.tgenabled::text || ' ' || pg_catalog.pg_get_triggerdef(t.oid) AS d
FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY 1`,
  schema: `SELECT n.nspname || ' ' || pg_catalog.pg_get_userbyid(n.nspowner) || ' ' || COALESCE(n.nspacl::text, '') AS d
FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('public', 'auth') ORDER BY 1`,
});

/** Hashes, by category, of everything SQL 29 / SQL 30 must not change. */
export async function readLibraryUnrelatedSnapshot(client, key) {
  const scope = LIBRARY_UNRELATED_SCOPE[key];
  const params = {
    relations: [[...scope.acl_relations]],
    constraints: [[...scope.constraints]],
    policies: [[...scope.policy_relations]],
    functions: [[...scope.functions]],
  };
  const categories = {};
  const counts = {};
  for (const [name, sql] of Object.entries(LIBRARY_UNRELATED_SQL)) {
    const rows = (await client.query(sql, params[name] || []))?.rows || [];
    categories[name] = libHash(rows.map((row) => row.d).join('\n'));
    counts[name] = rows.length;
  }
  return { categories, counts, sha256: libHash(JSON.stringify(categories)) };
}

export function libraryChangedCategories(before, after) {
  return Object.keys(before?.categories || {}).filter((name) => before.categories[name] !== after?.categories?.[name]);
}

/** Readable, non-sensitive report (no owner names, definitions or rows) for read-live and inspect. */
export function librarySqlReport(state) {
  const fn = (row) => (row?.exists
    ? { exists: true, owner_is_login: row.owner_is_login === true, security_definer: row.security_definer === true, result: row.result ?? null, config: [...(row.config || [])], acl: [...(row.acl || [])], prosrc_sha256: row.prosrc_sha256 ?? null }
    : { exists: false });
  return {
    prerequisites_missing: [...(state?.prerequisites_missing || [])],
    sql90_applied: state?.sql90_applied === true,
    sql29: {
      live_definition_sha256: state?.sql29?.live_definition_sha256 ?? null,
      table_present: state?.sql29?.table_present === true,
      table_owner_is_login: state?.sql29?.table_owner_is_login === true,
      rls_enabled: state?.sql29?.rls_enabled === true,
      table_acl: [...(state?.sql29?.table_acl || [])],
      // Keyed by function name (identities carry characters the read-live report drops).
      functions: Object.fromEntries(SQL29_FUNCTIONS.map((f) => [f.name, fn(state?.sql29?.functions?.[f.identity])])),
      functions_present: SQL29_FUNCTIONS.filter((f) => state?.sql29?.functions?.[f.identity]?.exists === true).length,
      policies_present: SQL29_POLICIES.filter((p) => state?.sql29?.policies?.[p.name]).map((p) => p.name),
      other_policies: [...(state?.sql29?.other_policies || [])],
      share_triggers: (state?.sql29?.share_triggers || []).map((t) => ({ name: t.name, enabled: t.enabled === true })),
    },
    sql30: {
      live_definition_sha256: state?.sql30?.live_definition_sha256 ?? null,
      table_present: state?.sql30?.table_present === true,
      doc_type: `${state?.sql30?.doc_type_udt ?? 'absent'}/${state?.sql30?.doc_type_nullable ?? 'absent'}`,
      check_shape: state?.sql30?.check?.shape ?? 'absent',
      check_validated: state?.sql30?.check?.validated === true,
      check_value_count: Array.isArray(state?.sql30?.check?.values) ? state.sql30.check.values.length : 0,
      check_definition_sha256: state?.sql30?.check?.definition_sha256 ?? null,
    },
    counts: state?.counts ?? null,
  };
}

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
  AUTHORIZED_SQL82_HOMEOWNER_LEDGER_VIEW,
  AUTHORIZED_SQL83_HOMEOWNER_SIGNING_CAPABILITIES,
  AUTHORIZED_SQL84_MORTGAGE_RETURN_TO_QUEUE,
  AUTHORIZED_SQL85_MORTGAGE_COMPENSATION_ADJUST,
  AUTHORIZED_SQL86_MORTGAGE_COMPENSATION_OWNER_ONLY,
  AUTHORIZED_SQL87_RESOLVE_CHECK_CASE_TENANT_SCOPE,
  AUTHORIZED_SQL88_CLAIM_ID_ASSIGN_CASE_TENANT_SCOPE,
  AUTHORIZED_SQL89_CHECK_INTAKE_COLUMN_UPDATE,
  AUTHORIZED_SQL29_MORTGAGE_OPS_LIBRARY_PARITY,
  AUTHORIZED_SQL30_TENANT_DOCUMENTS_DOC_TYPE,
  ...Object.values(RELEASE_2026_10_17_PENDING_SQL_PINS),
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

export function isSql82HomeownerLedgerView(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL82_HOMEOWNER_LEDGER_VIEW);
}

export function isSql83HomeownerSigningCapabilities(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL83_HOMEOWNER_SIGNING_CAPABILITIES);
}

export function isSql84MortgageReturnToQueue(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL84_MORTGAGE_RETURN_TO_QUEUE);
}

export function isSql85MortgageCompensationAdjust(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL85_MORTGAGE_COMPENSATION_ADJUST);
}

export function isSql86MortgageCompensationOwnerOnly(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL86_MORTGAGE_COMPENSATION_OWNER_ONLY);
}

export function isSql87ResolveCheckCaseTenantScope(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL87_RESOLVE_CHECK_CASE_TENANT_SCOPE);
}

export function isSql88ClaimIdAssignCaseTenantScope(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL88_CLAIM_ID_ASSIGN_CASE_TENANT_SCOPE);
}

export function isSql89CheckIntakeColumnUpdate(input = {}) {
  return pinIdentifiersMatch(input, AUTHORIZED_SQL89_CHECK_INTAKE_COLUMN_UPDATE);
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
  if (isSql82HomeownerLedgerView(input)) return AUTHORIZED_SQL82_HOMEOWNER_LEDGER_VIEW;
  if (isSql83HomeownerSigningCapabilities(input)) return AUTHORIZED_SQL83_HOMEOWNER_SIGNING_CAPABILITIES;
  if (isSql84MortgageReturnToQueue(input)) return AUTHORIZED_SQL84_MORTGAGE_RETURN_TO_QUEUE;
  if (isSql85MortgageCompensationAdjust(input)) return AUTHORIZED_SQL85_MORTGAGE_COMPENSATION_ADJUST;
  if (isSql86MortgageCompensationOwnerOnly(input)) return AUTHORIZED_SQL86_MORTGAGE_COMPENSATION_OWNER_ONLY;
  if (isSql87ResolveCheckCaseTenantScope(input)) return AUTHORIZED_SQL87_RESOLVE_CHECK_CASE_TENANT_SCOPE;
  if (isSql88ClaimIdAssignCaseTenantScope(input)) return AUTHORIZED_SQL88_CLAIM_ID_ASSIGN_CASE_TENANT_SCOPE;
  if (isSql89CheckIntakeColumnUpdate(input)) return AUTHORIZED_SQL89_CHECK_INTAKE_COLUMN_UPDATE;
  if (isSql29MortgageOpsLibraryParity(input)) return AUTHORIZED_SQL29_MORTGAGE_OPS_LIBRARY_PARITY;
  if (isSql30TenantDocumentsDocType(input)) return AUTHORIZED_SQL30_TENANT_DOCUMENTS_DOC_TYPE;
  const releaseKey = releaseSqlMigrationKey(input);
  if (releaseKey) return RELEASE_2026_10_17_PENDING_SQL_PINS[releaseKey];
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
