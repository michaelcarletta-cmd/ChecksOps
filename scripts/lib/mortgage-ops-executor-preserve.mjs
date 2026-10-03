/**
 * Gate 1 proof: candidate executor is the live composition plus SQL 39 only.
 * #601 membership-only members and handler text stay intact.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { overlayZipMembers, hashZipMembers } from '../deployment-guard/lib/zip-members.mjs';
import { AUTHORIZED_MEMBERSHIP_ONLY } from '../deployment-guard/lib/sql-executor-auth.mjs';

export const LIVE_EXECUTOR_INDEX_SHA256 = '6f765940f03ec301cac96439ad18d753aae5db37220416e168024f2be47f857c';
export const LIVE_MEMBERSHIP_SQL_SHA256 = '298506c90be829222c75781dd7c546fdefc6c5b2fa5cf86442eed30d383ef22e';
export const LIVE_MEMBERSHIP_COMMIT = 'e97e2c7c3f873e564a9d0e5af6d1a921ff2c29b0';

export const PRESERVED_LIVE_MEMBERS = Object.freeze([
  'sql/20261002200000_user_can_move_tenant_checks_membership_only.sql',
  'sql/20261001231500_tenant_users_same_check_permissions.sql',
  'sql/20261001193100_tenant_users_can_override_check_status.sql',
  'sql/44_claim_ledger_link_or_create.sql',
  'lib/errors.mjs',
  'lib/identity.mjs',
  'lib/sql-apply.mjs',
  'lib/function-def-lookup.mjs',
  'package.json',
  'package-lock.json',
  'rds-global-bundle.pem',
]);

export const OWNED_REPLACE_MEMBERS = Object.freeze([
  'index.mjs',
  'lib/sql-executor-auth.mjs',
]);

export const OWNED_ADD_MEMBERS = Object.freeze([
  'mortgage-ops-sql39.mjs',
  'sql/39_mortgage_ops_agent_accept_complete.sql',
]);

export const MEMBERSHIP_INDEX_MARKERS = Object.freeze([
  'handleMembershipOnlyHelper',
  'AUTHORIZED_MEMBERSHIP_ONLY',
  'isMembershipOnlyHelper',
  'MEMBERSHIP_ONLY_SQL_FILE',
  '20261002200000_user_can_move_tenant_checks_membership_only.sql',
]);

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

export function membershipBindingFromAuth(text) {
  const match = String(text || '').match(/export const AUTHORIZED_MEMBERSHIP_ONLY = Object\.freeze\((\{[\s\S]*?\})\);/);
  return match ? match[1].replace(/\s+/g, ' ').trim() : null;
}

export function indexContainsMembershipHelper(text) {
  const src = String(text || '');
  return MEMBERSHIP_INDEX_MARKERS.every((marker) => src.includes(marker));
}

export function prove601Preservation({
  liveMembers = {},
  candidateMembers = {},
  liveIndexText = '',
  candidateIndexText = '',
  liveAuthText = '',
  candidateAuthText = '',
  originMainIndexText = '',
} = {}) {
  const preserved = {};
  const drifted = [];
  for (const member of PRESERVED_LIVE_MEMBERS) {
    preserved[member] = {
      live: liveMembers[member] || null,
      candidate: candidateMembers[member] || null,
      unchanged: Boolean(liveMembers[member] && liveMembers[member] === candidateMembers[member]),
    };
    if (!preserved[member].unchanged) drifted.push(member);
  }

  const unexpected = Object.keys(candidateMembers).filter((member) => {
    if (OWNED_REPLACE_MEMBERS.includes(member) || OWNED_ADD_MEMBERS.includes(member)) return false;
    return candidateMembers[member] !== liveMembers[member];
  });
  const missingAdd = OWNED_ADD_MEMBERS.filter((member) => !candidateMembers[member]);
  const replaced = {};
  for (const member of OWNED_REPLACE_MEMBERS) {
    replaced[member] = {
      live: liveMembers[member] || null,
      candidate: candidateMembers[member] || null,
      changed: Boolean(liveMembers[member] && candidateMembers[member] && liveMembers[member] !== candidateMembers[member]),
    };
  }

  const membershipSqlUnchanged = preserved['sql/20261002200000_user_can_move_tenant_checks_membership_only.sql'].unchanged
    && liveMembers['sql/20261002200000_user_can_move_tenant_checks_membership_only.sql'] === LIVE_MEMBERSHIP_SQL_SHA256;
  const liveBinding = membershipBindingFromAuth(liveAuthText);
  const candidateBinding = membershipBindingFromAuth(candidateAuthText);
  const bindingIntact = Boolean(liveBinding && liveBinding === candidateBinding)
    && String(candidateAuthText).includes(AUTHORIZED_MEMBERSHIP_ONLY.filename)
    && String(candidateAuthText).includes(AUTHORIZED_MEMBERSHIP_ONLY.commit)
    && String(candidateAuthText).includes(AUTHORIZED_MEMBERSHIP_ONLY.source_sha256);
  const helperIntact = indexContainsMembershipHelper(liveIndexText)
    && indexContainsMembershipHelper(candidateIndexText);
  const notOriginMain = Boolean(originMainIndexText)
    && !indexContainsMembershipHelper(originMainIndexText)
    && candidateIndexText !== originMainIndexText;

  return {
    ok: drifted.length === 0
      && unexpected.length === 0
      && missingAdd.length === 0
      && OWNED_REPLACE_MEMBERS.every((member) => replaced[member].changed)
      && membershipSqlUnchanged
      && bindingIntact
      && helperIntact
      && (originMainIndexText ? notOriginMain : true),
    preserved,
    replaced,
    added: Object.fromEntries(OWNED_ADD_MEMBERS.map((member) => [member, candidateMembers[member] || null])),
    drifted,
    unexpected,
    missingAdd,
    membership_sql_unchanged: membershipSqlUnchanged,
    membership_binding_intact: bindingIntact,
    handleMembershipOnlyHelper_intact: helperIntact,
    not_origin_main_executor: originMainIndexText ? notOriginMain : null,
    authorized_membership_only: {
      filename: AUTHORIZED_MEMBERSHIP_ONLY.filename,
      commit: AUTHORIZED_MEMBERSHIP_ONLY.commit,
      source_sha256: AUTHORIZED_MEMBERSHIP_ONLY.source_sha256,
    },
  };
}

export function composeExecutorCandidate(liveZip, replacements) {
  const liveMembers = hashZipMembers(liveZip);
  const candidateZip = overlayZipMembers(liveZip, replacements);
  const candidateMembers = hashZipMembers(candidateZip);
  return { liveMembers, candidateZip, candidateMembers };
}

export function loadExecutorOverlaySources(repoRoot) {
  const base = path.join(repoRoot, 'aws/write-path/guarded-sql-executor');
  return {
    'index.mjs': fs.readFileSync(path.join(base, 'index.mjs')),
    'lib/sql-executor-auth.mjs': fs.readFileSync(path.join(base, 'lib/sql-executor-auth.mjs')),
    'mortgage-ops-sql39.mjs': fs.readFileSync(path.join(base, 'mortgage-ops-sql39.mjs')),
    'sql/39_mortgage_ops_agent_accept_complete.sql': fs.readFileSync(path.join(base, 'sql/39_mortgage_ops_agent_accept_complete.sql')),
  };
}

export function proveFromLiveExtract(repoRoot, liveDir, originMainIndexText = '') {
  const sources = loadExecutorOverlaySources(repoRoot);
  const liveIndex = fs.readFileSync(path.join(liveDir, 'index.mjs'), 'utf8');
  const liveAuth = fs.readFileSync(path.join(liveDir, 'lib/sql-executor-auth.mjs'), 'utf8');
  const liveIndexSha = sha256File(path.join(liveDir, 'index.mjs'));
  const membershipSqlSha = sha256File(path.join(liveDir, 'sql/20261002200000_user_can_move_tenant_checks_membership_only.sql'));
  const liveMembers = {};
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) liveMembers[rel] = sha256File(full);
    }
  }
  walk(liveDir);
  const candidateMembers = { ...liveMembers };
  for (const [member, buf] of Object.entries(sources)) {
    candidateMembers[member] = sha256(buf);
  }
  const proof = prove601Preservation({
    liveMembers,
    candidateMembers,
    liveIndexText: liveIndex,
    candidateIndexText: sources['index.mjs'].toString('utf8'),
    liveAuthText: liveAuth,
    candidateAuthText: sources['lib/sql-executor-auth.mjs'].toString('utf8'),
    originMainIndexText,
  });
  return {
    ...proof,
    live_index_sha256: liveIndexSha,
    live_index_matches_pin: liveIndexSha === LIVE_EXECUTOR_INDEX_SHA256,
    live_membership_sql_sha256: membershipSqlSha,
    live_membership_sql_matches_pin: membershipSqlSha === LIVE_MEMBERSHIP_SQL_SHA256,
    candidate_index_sha256: sha256(sources['index.mjs']),
    candidate_auth_sha256: sha256(sources['lib/sql-executor-auth.mjs']),
    candidate_sql39_sha256: sha256(sources['sql/39_mortgage_ops_agent_accept_complete.sql']),
    candidate_handler_sha256: sha256(sources['mortgage-ops-sql39.mjs']),
  };
}
