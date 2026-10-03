import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  LIVE_EXECUTOR_INDEX_SHA256,
  LIVE_MEMBERSHIP_SQL_SHA256,
  MEMBERSHIP_INDEX_MARKERS,
  OWNED_ADD_MEMBERS,
  OWNED_REPLACE_MEMBERS,
  PRESERVED_LIVE_MEMBERS,
  composeExecutorCandidate,
  indexContainsMembershipHelper,
  loadExecutorOverlaySources,
  membershipBindingFromAuth,
  prove601Preservation,
  proveFromLiveExtract,
} from '../../scripts/lib/mortgage-ops-executor-preserve.mjs';
import { writeZipMembers } from '../../scripts/deployment-guard/lib/zip-members.mjs';
import { AUTHORIZED_MEMBERSHIP_ONLY } from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIVE_DIR = '/tmp/mops-repair/executor-fresh/live';

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('candidate executor sources exist and SQL 39 SHA matches the reviewed file', () => {
  const sources = loadExecutorOverlaySources(ROOT);
  for (const member of [...OWNED_REPLACE_MEMBERS, ...OWNED_ADD_MEMBERS]) {
    assert.ok(sources[member]?.length, member);
  }
  assert.equal(
    sha256File(path.join(ROOT, 'aws/rls/sql/39_mortgage_ops_agent_accept_complete.sql')),
    sha256File(path.join(ROOT, 'aws/write-path/guarded-sql-executor/sql/39_mortgage_ops_agent_accept_complete.sql')),
  );
  assert.equal(
    sha256File(path.join(ROOT, 'scripts/deployment-guard/lib/sql-executor-auth.mjs')),
    sha256File(path.join(ROOT, 'aws/write-path/guarded-sql-executor/lib/sql-executor-auth.mjs')),
  );
  assert.equal(
    sha256File(path.join(ROOT, AUTHORIZED_MEMBERSHIP_ONLY.filename)),
    LIVE_MEMBERSHIP_SQL_SHA256,
  );
});

test('live extract plus overlay sources preserve exact #601 members and helper', () => {
  assert.equal(fs.existsSync(path.join(LIVE_DIR, 'index.mjs')), true);
  assert.equal(sha256File(path.join(LIVE_DIR, 'index.mjs')), LIVE_EXECUTOR_INDEX_SHA256);
  const originMainIndex = execFileSync('git', ['-C', ROOT, 'show', 'origin/main:aws/write-path/guarded-sql-executor/index.mjs'], {
    encoding: 'utf8',
  });
  const proof = proveFromLiveExtract(ROOT, LIVE_DIR, originMainIndex);
  assert.equal(proof.live_index_matches_pin, true);
  assert.equal(proof.live_membership_sql_matches_pin, true);
  assert.equal(proof.handleMembershipOnlyHelper_intact, true);
  assert.equal(proof.membership_binding_intact, true);
  assert.equal(proof.membership_sql_unchanged, true);
  assert.equal(proof.not_origin_main_executor, true);
  assert.equal(proof.ok, true, JSON.stringify(proof.drifted));
  assert.deepEqual(proof.drifted, []);
  assert.deepEqual(proof.unexpected, []);
  for (const member of PRESERVED_LIVE_MEMBERS) {
    assert.equal(proof.preserved[member].unchanged, true, member);
  }
  for (const member of OWNED_REPLACE_MEMBERS) {
    assert.equal(proof.replaced[member].changed, true, member);
  }
});

test('ZIP overlay candidate keeps every non-owned live member byte-identical', () => {
  const liveFiles = {};
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile() && !rel.startsWith('node_modules/')) {
        liveFiles[rel] = fs.readFileSync(full);
      }
    }
  }
  walk(LIVE_DIR);
  const liveZip = writeZipMembers(liveFiles);
  const sources = loadExecutorOverlaySources(ROOT);
  const { liveMembers, candidateMembers } = composeExecutorCandidate(liveZip, sources);
  const originMainIndex = execFileSync('git', ['-C', ROOT, 'show', 'origin/main:aws/write-path/guarded-sql-executor/index.mjs'], {
    encoding: 'utf8',
  });
  const proof = prove601Preservation({
    liveMembers,
    candidateMembers,
    liveIndexText: liveFiles['index.mjs'].toString('utf8'),
    candidateIndexText: sources['index.mjs'].toString('utf8'),
    liveAuthText: liveFiles['lib/sql-executor-auth.mjs'].toString('utf8'),
    candidateAuthText: sources['lib/sql-executor-auth.mjs'].toString('utf8'),
    originMainIndexText: originMainIndex,
  });
  assert.equal(proof.ok, true, JSON.stringify({ drifted: proof.drifted, unexpected: proof.unexpected }));
  assert.equal(liveMembers['sql/20261002200000_user_can_move_tenant_checks_membership_only.sql'], LIVE_MEMBERSHIP_SQL_SHA256);
  assert.equal(candidateMembers['sql/20261002200000_user_can_move_tenant_checks_membership_only.sql'], LIVE_MEMBERSHIP_SQL_SHA256);
});

test('origin/main executor is not the candidate and lacks the membership helper', () => {
  const originMainIndex = execFileSync('git', ['-C', ROOT, 'show', 'origin/main:aws/write-path/guarded-sql-executor/index.mjs'], {
    encoding: 'utf8',
  });
  const candidate = fs.readFileSync(path.join(ROOT, 'aws/write-path/guarded-sql-executor/index.mjs'), 'utf8');
  const live = fs.readFileSync(path.join(LIVE_DIR, 'index.mjs'), 'utf8');
  assert.equal(indexContainsMembershipHelper(originMainIndex), false);
  assert.equal(indexContainsMembershipHelper(live), true);
  assert.equal(indexContainsMembershipHelper(candidate), true);
  assert.notEqual(candidate, originMainIndex);
  for (const marker of MEMBERSHIP_INDEX_MARKERS) {
    assert.match(candidate, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.equal(
    membershipBindingFromAuth(fs.readFileSync(path.join(LIVE_DIR, 'lib/sql-executor-auth.mjs'), 'utf8')),
    membershipBindingFromAuth(fs.readFileSync(path.join(ROOT, 'aws/write-path/guarded-sql-executor/lib/sql-executor-auth.mjs'), 'utf8')),
  );
});
