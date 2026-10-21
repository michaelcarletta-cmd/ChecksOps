// The Claude Code PreToolUse hook (.claude/hooks/checksops-guard.mjs) refuses edits to
// migrations that exist on main, rewrites of an applied pin's evidence and direct deploys,
// and allows new migrations, ordinary pin edits and read-only commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = path.join(ROOT, '.claude/hooks/checksops-guard.mjs');
const SQL91 = 'aws/workflows/sql/91_moov_onboarding.sql';
const PIN91 = 'ops/deployment-guard/sql91-moov-onboarding-production-apply.json';

function run(payload, env = {}, cwd = ROOT) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CHECKSOPS_OWNER_ALLOW_SQL_EDIT: '', ...env },
  });
  return { code: r.status, err: r.stderr };
}
const edit = (rel, old_string, new_string) => run({ tool_name: 'Edit', tool_input: { file_path: path.join(ROOT, rel), old_string, new_string } });
const bash = (command, cwd = ROOT) => run({ tool_name: 'Bash', tool_input: { command } }, {}, cwd);

// A throwaway repository on a branch the test chooses: the push rules depend on the current
// branch, and this checkout may be on main (CI's push run, an owner's desktop) or detached.
function repoOnBranch(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-guard-push-'));
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', branch], { stdio: 'ignore' });
  return dir;
}

test('settings wire the hook for Edit, MultiEdit, Write and Bash and deny direct deploys', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
  const pre = settings.hooks.PreToolUse;
  assert.equal(pre.length, 1);
  assert.equal(pre[0].matcher, 'Edit|MultiEdit|Write|Bash');
  assert.match(pre[0].hooks[0].command, /\.claude\/hooks\/checksops-guard\.mjs/);
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /\.claude\/hooks\/session-brief\.mjs/);
  for (const allowed of settings.permissions.allow) assert.doesNotMatch(allowed, /sam |aws lambda|cloudformation|psql|git push|gh pr merge/, allowed);
  for (const d of ['Bash(sam deploy:*)', 'Bash(sam build:*)', 'Bash(aws lambda update-function-code:*)', 'Bash(aws cloudformation deploy:*)']) {
    assert.ok(settings.permissions.deny.includes(d), d);
  }
  const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /^@AGENTS\.md$/m);
  assert.match(fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8'), /^\* text=auto eol=lf$/m);
  assert.match(fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8'), /Migrations and pins are append-only/);
});

test('an existing migration cannot be edited, written or overwritten; a new one can', () => {
  const line = fs.readFileSync(path.join(ROOT, SQL91), 'utf8').split('\n').find((l) => l.startsWith('GRANT '));
  const r = edit(SQL91, line, `${line}\nGRANT SELECT ON TABLE public.payment_idempotency_keys TO checksops;`);
  assert.equal(r.code, 2);
  assert.match(r.err, /already exists on main\. Migrations are append-only/);
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: path.join(ROOT, SQL91), content: '-- x\n' } }).code, 2);
  assert.equal(run({ tool_name: 'MultiEdit', tool_input: { file_path: path.join(ROOT, SQL91), edits: [{ old_string: line, new_string: line }] } }).code, 2);
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: path.join(ROOT, 'aws/workflows/sql/999_new_migration_probe.sql'), content: '-- new\n' } }).code, 0);
});

test('the owner override allows exactly the named migration', () => {
  const payload = { tool_name: 'Write', tool_input: { file_path: path.join(ROOT, SQL91), content: '-- x\n' } };
  assert.equal(run(payload, { CHECKSOPS_OWNER_ALLOW_SQL_EDIT: SQL91 }).code, 0);
  assert.equal(run(payload, { CHECKSOPS_OWNER_ALLOW_SQL_EDIT: 'aws/workflows/sql/92_signature_request_check_files_link_grant.sql' }).code, 2);
});

test('an applied pin keeps its recorded evidence; other fields stay editable', () => {
  const text = fs.readFileSync(path.join(ROOT, PIN91), 'utf8');
  const pin = JSON.parse(text);
  assert.ok(pin.applied, 'fixture: SQL 91 is applied');
  const after = pin.applied.receipt.after_hash;
  const r = edit(PIN91, `"after_hash": "${after}"`, `"after_hash": "${'4'.repeat(64)}"`);
  assert.equal(r.code, 2);
  assert.match(r.err, /changes its recorded evidence \(applied\)/);
  const src = edit(PIN91, `"source_sha256": "${pin.source_sha256}"`, `"source_sha256": "${'3'.repeat(64)}"`);
  assert.equal(src.code, 2);
  assert.match(src.err, /source_sha256/);
  const note = edit(PIN91, `"order_note": ${JSON.stringify(pin.order_note)}`, `"order_note": ${JSON.stringify(`${pin.order_note} (probe)`)}`);
  assert.equal(note.code, 0, note.err);
});

test('direct deploys are refused; the guarded tooling and read-only commands are not', () => {
  for (const cmd of ['sam build', 'sam deploy --guided', 'aws lambda update-function-code --function-name x --zip-file fileb://x.zip', 'aws cloudformation deploy --template-file t.yaml', 'psql -h db.example.com -U checksops_admin -f x.sql', 'psql postgresql://u@h/db']) {
    assert.equal(bash(cmd).code, 2, cmd);
  }
  for (const cmd of [
    'node scripts/deployment-guard/preflight.mjs --input m.json',
    `sha256sum ${SQL91} 2>/dev/null`,
    `cat ${SQL91} | head -5`,
    `git diff main -- ${SQL91}`,
    'aws lambda get-function --function-name x',
    'psql -X -d postgres -c "select 1"',
    'psql -h /tmp/pg-sql96-x -p 55432 -U postgres -c "select 1"',
    'psql postgresql://postgres@localhost:55432/postgres -c "select 1"',
  ]) {
    assert.equal(bash(cmd).code, 0, cmd);
  }
});

test('a deploy is refused wherever the shell would run it; a quoted mention is allowed', () => {
  for (const cmd of [
    '  sam deploy',
    'echo ok\nsam deploy',
    'cd aws && sam deploy',
    'echo ready || sam build',
    'true; sam sync',
    'cat x | sam package',
    '(sam deploy)',
    'echo $(sam deploy)',
    'echo "$(sam deploy)"',
    'echo "`sam deploy`"',
    '{ sam deploy; }',
    'FOO=1 sam deploy',
    'env AWS_PROFILE=x sam deploy',
    'AWS_PROFILE=checksops aws cloudformation deploy --template-file t.yaml',
    'sudo sam deploy',
    'time sam build',
    "bash -c 'sam deploy'",
    'sh -c "aws lambda update-function-code --function-name x --zip-file fileb://x.zip"',
    "bash -lc 'cd aws && sam deploy'",
    "eval 'sam deploy'",
    'bash <<EOF\nsam deploy\nEOF',
    "echo \\'; sam deploy; echo \\'",
  ]) {
    assert.equal(bash(cmd).code, 2, JSON.stringify(cmd));
  }
  for (const cmd of [
    'grep -r "sam deploy" docs/',
    "rg 'aws lambda update-function-code' aws/",
    'echo "never run sam deploy here"',
    'cat README.md | grep "aws cloudformation deploy"',
    "awk '/sam build/' notes.txt",
    'git commit -m "Docs: never sam deploy or aws lambda update-function-code"',
    'git log --grep="sam deploy"',
  ]) {
    assert.equal(bash(cmd).code, 0, JSON.stringify(cmd));
  }
});

test('pushes to main and force pushes are refused; pushing a feature branch is not', () => {
  const feature = repoOnBranch('claude/x');
  const onMain = repoOnBranch('main');
  try {
  for (const cmd of [
    'git push origin main',
    'git push -u origin HEAD:main',
    'git push origin feature:refs/heads/main',
    'git push --force origin claude/x',
    'git push -f origin claude/x',
    'git push -fu origin claude/x',
    'git push origin +claude/x',
    'git push origin --delete main',
    'git -C /tmp/repo push origin main',
    'git fetch origin && git push origin main',
    'git push origin :claude/x',
  ]) {
    // Refused whatever branch is checked out.
    for (const cwd of [feature, onMain]) {
      const r = bash(cmd, cwd);
      assert.equal(r.code, 2, `${cmd} (on ${cwd === onMain ? 'main' : 'claude/x'})`);
      assert.match(r.err, /git push refused/);
    }
  }
  // On a feature branch these push that branch, or nothing.
  for (const cmd of [
    'git push -u origin claude/tender-allen-03lom8',
    'git push --force-with-lease origin claude/x',
    'git push origin HEAD',
    'git push',
    'git push --dry-run origin claude/x',
    'git log origin/main..HEAD',
    'grep "git push origin main" docs/',
  ]) {
    assert.equal(bash(cmd, feature).code, 0, cmd);
  }
  // On main, a bare push or a push of HEAD is a push to main.
  for (const cmd of ['git push', 'git push origin', 'git push origin HEAD', 'git push -u origin HEAD']) {
    const r = bash(cmd, onMain);
    assert.equal(r.code, 2, `${cmd} (on main)`);
    assert.match(r.err, /the current branch is main/);
  }
  // An explicit feature branch is still allowed from main.
  assert.equal(bash('git push -u origin claude/x', onMain).code, 0);
  } finally {
    fs.rmSync(feature, { recursive: true, force: true });
    fs.rmSync(onMain, { recursive: true, force: true });
  }
});

test('shell writes to an existing migration are refused', () => {
  for (const cmd of [`sed -i 's/a/b/' ${SQL91}`, `echo x >> ${SQL91}`, `printf x > ./${SQL91}`, `echo x | tee ${SQL91}`, `rm ${SQL91}`, `mv ${SQL91} /tmp/x`, `cp /tmp/x ${SQL91}`, `git checkout HEAD~1 -- ${SQL91}`]) {
    assert.equal(bash(cmd).code, 2, cmd);
  }
  assert.equal(bash(`cp ${SQL91} /tmp/sql91-copy.sql`).code, 0);
});
